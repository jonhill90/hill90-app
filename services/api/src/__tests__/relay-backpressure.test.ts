/**
 * The relay policy, tested directly.
 *
 * `ws.send()` does not block. With the peer not reading, everything unsent piles
 * up in `bufferedAmount` inside this process, and the proxy consulted that
 * nowhere. These assert the three behaviours that bound it: pause the source
 * when the queue builds, resume when it drains, and give up when it does not.
 *
 * Timers are faked so "resumes when it drains" is a decision about a value, not
 * a race against a 250ms poll.
 */
import { pumpWithBackpressure, RELAY_DEFAULTS, RelaySocket } from '../services/relay-backpressure';

type Fake = RelaySocket & {
  emitMessage: (data: unknown) => void;
  sent: unknown[];
  paused: boolean;
};

function fakeSocket(bufferedAmount = 0): Fake {
  let handler: ((data: unknown, isBinary: boolean) => void) | null = null;
  const f: Fake = {
    readyState: 1,
    bufferedAmount,
    sent: [],
    paused: false,
    send(data: unknown) {
      f.sent.push(data);
    },
    on(event: string, listener: (...args: never[]) => void) {
      if (event === 'message') handler = listener as unknown as typeof handler extends null ? never : (d: unknown, b: boolean) => void;
    },
    _socket: {
      pause() { f.paused = true; },
      resume() { f.paused = false; },
    },
    emitMessage(data: unknown) {
      handler?.(data, false);
    },
  };
  return f;
}

const opts = (over: Partial<Parameters<typeof pumpWithBackpressure>[2]> = {}) => ({
  ...RELAY_DEFAULTS,
  isOpen: (s: RelaySocket) => s.readyState === 1,
  onOverflow: jest.fn(),
  ...over,
});

describe('pumpWithBackpressure', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('relays normally while the destination keeps up', () => {
    const from = fakeSocket();
    const to = fakeSocket(0);
    const o = opts();
    pumpWithBackpressure(from, to, o);

    from.emitMessage('ls -la');

    expect(to.sent).toEqual(['ls -la']);
    expect(from.paused).toBe(false);
    expect(o.onOverflow).not.toHaveBeenCalled();
  });

  it('pauses the SOURCE when the destination queue passes the high-water mark', () => {
    const from = fakeSocket();
    const to = fakeSocket(RELAY_DEFAULTS.highWaterBytes + 1);
    pumpWithBackpressure(from, to, opts());

    from.emitMessage('output');

    // Pausing the source is what pushes the stall back to the producer. Dropping
    // the data instead would corrupt a terminal stream; closing would kill a
    // session that is merely slow.
    expect(from.paused).toBe(true);
  });

  it('resumes the source once the queue drains', () => {
    const from = fakeSocket();
    const to = fakeSocket(RELAY_DEFAULTS.highWaterBytes + 1);
    pumpWithBackpressure(from, to, opts());
    from.emitMessage('output');
    expect(from.paused).toBe(true);

    to.bufferedAmount = 0; // the client caught up
    jest.advanceTimersByTime(RELAY_DEFAULTS.resumePollMs * 2);

    expect(from.paused).toBe(false);
  });

  it('gives up when the queue passes the hard cap — that peer is not reading', () => {
    const from = fakeSocket();
    const to = fakeSocket(RELAY_DEFAULTS.hardCapBytes + 1);
    const o = opts();
    pumpWithBackpressure(from, to, o);

    from.emitMessage('output');

    expect(o.onOverflow).toHaveBeenCalledTimes(1);
    expect(o.onOverflow).toHaveBeenCalledWith(RELAY_DEFAULTS.hardCapBytes + 1);
  });

  it('stops relaying after an overflow instead of continuing to queue', () => {
    const from = fakeSocket();
    const to = fakeSocket(RELAY_DEFAULTS.hardCapBytes + 1);
    pumpWithBackpressure(from, to, opts());

    from.emitMessage('first');
    from.emitMessage('second');
    from.emitMessage('third');

    expect(to.sent).toEqual(['first']); // the one that tripped it, and no more
  });

  it('cleanup clears the resume poll and unpauses', () => {
    const from = fakeSocket();
    const to = fakeSocket(RELAY_DEFAULTS.highWaterBytes + 1);
    const stop = pumpWithBackpressure(from, to, opts());
    from.emitMessage('output');
    expect(from.paused).toBe(true);

    stop();

    expect(from.paused).toBe(false);
    // An interval still armed here would hold both sockets alive — the leak
    // class docs/decisions/api-suite-flakiness.md spent a day on.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not relay into a destination that is no longer open', () => {
    const from = fakeSocket();
    const to = fakeSocket(0);
    to.readyState = 3;
    pumpWithBackpressure(from, to, opts());

    from.emitMessage('output');

    expect(to.sent).toEqual([]);
  });
});
