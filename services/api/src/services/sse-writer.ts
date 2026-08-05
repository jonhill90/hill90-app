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

  /**
   * How long a follow-mode stream's poll or tail may be silently failing before
   * the client is told. Four sites poll or tail an upstream source on an
   * interval and, on failure, kept the connection open with nothing but
   * heartbeats — the client had no way to tell "nothing new happened" from
   * "the poll has been broken since some point in the past" (app#443).
   *
   * 10s: short enough that a client learns well before the 30s heartbeat cycle
   * would otherwise be the only other signal it has, long enough that one slow
   * tick — a GC pause, a single dropped connection — does not fire it by
   * itself. Each call site derives its own consecutive-failure THRESHOLD from
   * this and its own poll interval via failureThresholdFor(), so a stream that
   * polls once a second and one that polls once every five both signal inside
   * the same wall-clock bound rather than after the same failure COUNT.
   */
  pollFailureSignalMs: 10_000,
};

/**
 * Consecutive polls/ticks that must fail before pollFailureSignalMs's bound is
 * reached, for a given poll interval. Always at least 1, so a poll slower than
 * the bound itself still signals on its first failure rather than never.
 */
export function failureThresholdFor(pollIntervalMs: number): number {
  return Math.max(1, Math.ceil(SSE_DEFAULTS.pollFailureSignalMs / pollIntervalMs));
}

/**
 * The SAME frame shape createBoundedSseWriter's onOverflow already uses to say
 * "this stream cannot continue honestly" — `event: error` with a JSON
 * {error, detail} body. A second convention for the same idea, sent by four
 * different call sites, would be worse than either convention alone.
 */
export function sseErrorFrame(error: string, detail: string): string {
  return `event: error\ndata: ${JSON.stringify({ error, detail })}\n\n`;
}

/**
 * Tracks consecutive poll/tail failures for one follow-mode stream and fires
 * ONCE when they cross a threshold — not once PER failure, which would repeat
 * the same frame every tick for as long as the outage lasts. recordSuccess()
 * resets the counter AND re-arms the signal: a stream that recovers stops
 * complaining, and if it breaks again later the client is told again rather
 * than staying silent because it already fired once.
 *
 * Deliberately does not end the stream. Unlike the hard-cap overflow this
 * guards against (a reader that will never catch up), a poll failure is
 * recoverable — the next tick might succeed — so ending the connection over it
 * would turn a transient upstream blip into an unnecessary reconnect storm.
 * The frame is informational: it tells the client its view may be behind,
 * not that the connection is over.
 */
export interface PollFailureSignal {
  recordFailure(): void;
  recordSuccess(): void;
}

export function createPollFailureSignal(
  threshold: number,
  onThresholdCrossed: () => void,
): PollFailureSignal {
  let consecutiveFailures = 0;
  let signalled = false;
  return {
    recordFailure() {
      consecutiveFailures += 1;
      if (!signalled && consecutiveFailures >= threshold) {
        signalled = true;
        onThresholdCrossed();
      }
    },
    recordSuccess() {
      consecutiveFailures = 0;
      signalled = false;
    },
  };
}

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
