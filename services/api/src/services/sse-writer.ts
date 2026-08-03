/**
 * Write Server-Sent Events without letting a stalled reader eat the heap.
 *
 * `res.write()` returns false when the socket's buffer is full. Node does not
 * stop you writing after that — it buffers, without limit, inside the process.
 * Across services/api there were 18 `res.write(` call sites in non-test code,
 * NONE of which consulted the return value, and no `'drain'` listener,
 * `writableNeedDrain` or `writableLength` check anywhere in the service. So an
 * SSE client that stops reading — a throttled tab, a slept laptop, a phone off
 * the network — had nothing bounding what accumulated for it.
 *
 * The highest-volume case is `/agents/:id/events?follow=true`, which relays a
 * container's `tail -f` line by line: the producer is an agent, and it does not
 * slow down because the browser did.
 *
 * SAME ORDERING AS THE TERMINAL RELAY (#148), for the same reasons.
 * Backpressure first: when the response reports it is full, PAUSE THE SOURCE, so
 * the stall reaches the producer rather than this process's memory, and resume
 * on 'drain'. A client that is merely slow then stays connected and catches up.
 * The hard cap is only for what backpressure cannot fix — a reader that is not
 * reading at all — and it ends the stream with an explicit `event: error`,
 * because an SSE stream that silently stops emitting is indistinguishable from
 * an idle one.
 */

/** The parts of an http.ServerResponse this needs; narrow so tests can fake it. */
export interface SseResponse {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): void;
  writableLength: number;
  writableEnded: boolean;
  destroyed: boolean;
}

/** A producer that can be told to wait. Node streams satisfy this. */
export interface PausableSource {
  pause(): void;
  resume(): void;
}

export const SSE_DEFAULTS = {
  /** 8 MB queued for one client is not slow, it is gone. Matches the relay cap. */
  hardCapBytes: 8 * 1024 * 1024,
};

export interface SseWriterOptions {
  hardCapBytes: number;
  /** Called once, when the cap is passed. The caller ends the stream. */
  onOverflow: (queuedBytes: number) => void;
}

export interface BoundedSseWriter {
  /** Attach the producer to pause while the client catches up. */
  setSource(source: PausableSource | null): void;
  /** Write one SSE frame. Returns false if it was refused or the socket is full. */
  write(chunk: string): boolean;
  readonly overflowed: boolean;
}

export function createBoundedSseWriter(
  res: SseResponse,
  opts: SseWriterOptions,
): BoundedSseWriter {
  let source: PausableSource | null = null;
  let overflowed = false;
  let paused = false;

  return {
    setSource(s) {
      source = s;
    },

    write(chunk: string): boolean {
      if (overflowed || res.writableEnded || res.destroyed) return false;

      if (res.writableLength > opts.hardCapBytes) {
        overflowed = true;
        opts.onOverflow(res.writableLength);
        return false;
      }

      const accepted = res.write(chunk);

      if (!accepted && source && !paused) {
        // The client is behind. Stop the producer rather than queueing for it.
        paused = true;
        source.pause();
        res.once('drain', () => {
          paused = false;
          if (!overflowed) source?.resume();
        });
      }

      return accepted;
    },

    get overflowed() {
      return overflowed;
    },
  };
}
