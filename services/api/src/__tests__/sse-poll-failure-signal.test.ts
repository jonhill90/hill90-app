/**
 * app#443: a follow-mode SSE stream that polls or tails an upstream source on
 * an interval used to catch that source's errors, log them server-side only,
 * and keep the connection open — the client saw heartbeats and nothing else,
 * with no way to tell "nothing new happened" from "the poll has been silently
 * broken since some point in the past."
 *
 * These pin the two primitives the four call sites (chat.ts's thread-message
 * poll and per-agent tail, chat.ts's incremental correlation refresh,
 * agents.ts's inference poll) all share: how many consecutive failures it
 * takes to signal, derived from each site's own poll interval rather than a
 * shared round number, and that the signal fires once per outage rather than
 * once per failed tick.
 */
import { failureThresholdFor, createPollFailureSignal, sseErrorFrame, SSE_DEFAULTS } from '../services/sse-writer';

describe('failureThresholdFor', () => {
  it('derives the threshold from the poll interval against the stated bound', () => {
    // 1s polls: 10s bound / 1s interval = 10 consecutive failures.
    expect(failureThresholdFor(1000)).toBe(10);
    // 5s polls (chat.ts's default correlation refresh): 10s / 5s = 2.
    expect(failureThresholdFor(5000)).toBe(2);
    // 3s polls (agents.ts's default inference poll): ceil(10s / 3s) = 4.
    expect(failureThresholdFor(3000)).toBe(4);
  });

  it('never returns less than 1, so a poll slower than the bound itself still signals', () => {
    expect(failureThresholdFor(SSE_DEFAULTS.pollFailureSignalMs * 5)).toBe(1);
  });
});

describe('sseErrorFrame', () => {
  it('matches the exact shape onOverflow already uses: event: error, JSON {error, detail}', () => {
    const frame = sseErrorFrame('Something', 'went wrong');
    expect(frame).toBe('event: error\ndata: {"error":"Something","detail":"went wrong"}\n\n');
  });
});

describe('createPollFailureSignal', () => {
  it('does not fire before the threshold is reached', () => {
    const onThresholdCrossed = jest.fn();
    const signal = createPollFailureSignal(3, onThresholdCrossed);

    signal.recordFailure();
    signal.recordFailure();

    expect(onThresholdCrossed).not.toHaveBeenCalled();
  });

  it('fires exactly once when consecutive failures reach the threshold', () => {
    const onThresholdCrossed = jest.fn();
    const signal = createPollFailureSignal(3, onThresholdCrossed);

    signal.recordFailure();
    signal.recordFailure();
    signal.recordFailure();
    signal.recordFailure(); // still failing — must not fire again

    expect(onThresholdCrossed).toHaveBeenCalledTimes(1);
  });

  // POSITIVE CONTROL, direction one: sustained failure signals.
  it('a stream whose poll keeps failing crosses the threshold', () => {
    const onThresholdCrossed = jest.fn();
    const threshold = failureThresholdFor(1000); // 10, at the 1s cadence chat.ts's thread stream uses
    const signal = createPollFailureSignal(threshold, onThresholdCrossed);

    for (let i = 0; i < threshold; i++) signal.recordFailure();

    expect(onThresholdCrossed).toHaveBeenCalledTimes(1);
  });

  // POSITIVE CONTROL, direction two: a transient blip that self-heals does not.
  it('one failure followed by success does not signal, at any threshold above 1', () => {
    const onThresholdCrossed = jest.fn();
    const signal = createPollFailureSignal(failureThresholdFor(1000), onThresholdCrossed);

    signal.recordFailure();
    signal.recordSuccess();

    expect(onThresholdCrossed).not.toHaveBeenCalled();
  });

  it('recordSuccess resets the counter, so failures after a recovery must reaccumulate', () => {
    const onThresholdCrossed = jest.fn();
    const signal = createPollFailureSignal(3, onThresholdCrossed);

    signal.recordFailure();
    signal.recordFailure();
    signal.recordSuccess(); // recovers with one failure still short of 3
    signal.recordFailure();
    signal.recordFailure();

    expect(onThresholdCrossed).not.toHaveBeenCalled(); // only 2 consecutive since the reset
  });

  it('recordSuccess re-arms the signal: a stream that breaks again is told again', () => {
    const onThresholdCrossed = jest.fn();
    const signal = createPollFailureSignal(2, onThresholdCrossed);

    signal.recordFailure();
    signal.recordFailure();
    expect(onThresholdCrossed).toHaveBeenCalledTimes(1);

    signal.recordSuccess();
    signal.recordFailure();
    signal.recordFailure();

    expect(onThresholdCrossed).toHaveBeenCalledTimes(2);
  });
});
