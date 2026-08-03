/**
 * Relay one WebSocket into another without letting a slow reader eat the heap.
 *
 * THE PROBLEM. `ws.send()` does not block. If the peer stops reading — a browser
 * tab throttled in the background, a laptop that slept, a phone off the network
 * that has not TCP-timed-out yet — the data does not stop arriving from the
 * other side, and everything unsent piles up in `bufferedAmount` inside this
 * process. A terminal attached to an agent that is printing output is exactly
 * the shape that produces faster than a stalled client consumes.
 *
 * The proxy relayed both directions with a bare `to.send(...)` and consulted
 * `bufferedAmount` nowhere, so the queue had no ceiling. `app-api` declares no
 * mem_limit (see issue #144), so the ceiling was the VPS's memory, shared with
 * the platform.
 *
 * THE ANSWER IS BACKPRESSURE FIRST, NOT A KILL. Above the high-water mark the
 * SOURCE socket is paused, which stops reading from it and lets TCP push the
 * stall back to whoever is producing — the agent's PTY blocks, which is exactly
 * what a terminal is supposed to do when the far end cannot keep up. A legitimate
 * burst (`cat` on a large file over a slow link) then simply slows down instead
 * of dying, which dropping data or closing the session would not achieve.
 *
 * The hard cap exists for the case backpressure cannot fix: a peer that is not
 * reading at all. Once the queue passes it, the session is not slow, it is dead,
 * and holding megabytes for it is a cost with no beneficiary. That case ends the
 * session explicitly — the caller closes with a stated reason — because a
 * terminal that silently stops relaying is indistinguishable from an idle one.
 */

/** The parts of a `ws` socket this needs. Narrow on purpose, so tests can fake it. */
export interface RelaySocket {
  readyState: number;
  bufferedAmount: number;
  send(data: unknown, options: { binary: boolean }): void;
  on(event: string, listener: (...args: never[]) => void): void;
  /** `ws` exposes the underlying net.Socket here; pausing it is what applies TCP backpressure. */
  _socket?: { pause(): void; resume(): void };
}

export interface RelayOptions {
  /** Pause the source once the destination has this much queued. */
  highWaterBytes: number;
  /** Give up once the destination has this much queued; the peer is not reading. */
  hardCapBytes: number;
  /** How often to re-check a paused source. `ws` has no drain event to wait on. */
  resumePollMs: number;
  /** Destination is OPEN. Kept injectable so tests need not import ws. */
  isOpen: (socket: RelaySocket) => boolean;
  /** Called once when the hard cap is passed. The caller ends the session. */
  onOverflow: (bufferedBytes: number) => void;
}

export const RELAY_DEFAULTS = {
  /** 1 MB queued is already a stalled reader for a terminal; slow down the source. */
  highWaterBytes: 1024 * 1024,
  /** 8 MB is not slow, it is gone. */
  hardCapBytes: 8 * 1024 * 1024,
  resumePollMs: 250,
};

/**
 * Pump `from` into `to`. Returns a cleanup that clears the resume poll — an
 * armed interval holding a socket is the leak this repository has already paid
 * for once, so the caller must call it alongside its other teardown.
 */
export function pumpWithBackpressure(
  from: RelaySocket,
  to: RelaySocket,
  opts: RelayOptions,
): () => void {
  let resumeTimer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  let overflowed = false;

  const resumeThreshold = Math.floor(opts.highWaterBytes / 2);

  const stopPolling = () => {
    if (resumeTimer) {
      clearInterval(resumeTimer);
      resumeTimer = null;
    }
  };

  const resumeSource = () => {
    paused = false;
    stopPolling();
    from._socket?.resume();
  };

  const pauseSource = () => {
    if (paused) return;
    paused = true;
    from._socket?.pause();
    // No 'drain' on a ws socket, so the queue is polled. The interval only
    // exists while paused, and is cleared the moment it is not needed.
    resumeTimer = setInterval(() => {
      if (!opts.isOpen(to)) {
        resumeSource();
        return;
      }
      if (to.bufferedAmount <= resumeThreshold) resumeSource();
    }, opts.resumePollMs);
  };

  from.on('message', ((data: unknown, isBinary: boolean) => {
    if (overflowed) return;
    if (!opts.isOpen(to)) return;

    to.send(data, { binary: isBinary });

    const queued = to.bufferedAmount;
    if (queued > opts.hardCapBytes) {
      overflowed = true;
      stopPolling();
      opts.onOverflow(queued);
      return;
    }
    if (queued > opts.highWaterBytes) pauseSource();
  }) as (...args: never[]) => void);

  return () => {
    stopPolling();
    // Leaving a socket paused on teardown would strand it if it is reused.
    if (paused) from._socket?.resume();
  };
}
