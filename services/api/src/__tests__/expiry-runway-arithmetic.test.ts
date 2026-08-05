/**
 * The arithmetic guarantee behind the 4002 test's fixed exp fixture
 * (terminal-session-endings.test.ts), proven on its own — no sockets, no
 * timers, no WebSocket server. Split out per review on #404: the previous
 * version fed a forced worst-case instant into the real handshake test and
 * claimed the guarantee was "proven every run" with nothing actually
 * asserting it. This file is that assertion.
 */
import {
  expWithFloorRunway,
  expWithGuaranteedRunway,
  worstCaseInstantForFloorFormula,
} from '../testSupport/expiryRunway';

const BUFFER_SECONDS = 2;

/** A handful of instants spanning a whole second, plus the one before it —
 * every millisecond position that matters for either formula.
 */
function boundaryInstants(secondStartMs: number): number[] {
  return [
    secondStartMs,             // start of the second
    secondStartMs + 1,         // just after
    secondStartMs + 500,       // middle
    secondStartMs + 999,       // .999 — the worst case WITHIN this second
    secondStartMs - 1,         // .999 of the PREVIOUS second — worse still
  ];
}

describe('expWithGuaranteedRunway — the fixed formula', () => {
  it.each(boundaryInstants(1_700_000_000_000))(
    'always leaves at least %i ms of runway from nowMs=%i',
    (nowMs) => {
      const exp = expWithGuaranteedRunway(BUFFER_SECONDS, nowMs);
      const runwayMs = exp * 1000 - nowMs;
      expect(runwayMs).toBeGreaterThanOrEqual(BUFFER_SECONDS * 1000);
      // And the guarantee has a ceiling too — this is a fixed buffer, not an
      // ever-growing one when nowMs happens to land early in its second.
      expect(runwayMs).toBeLessThan((BUFFER_SECONDS + 1) * 1000);
    },
  );

  it('the worst instant for the OLD formula still clears the buffer here', () => {
    const secondStart = 1_700_000_000_000;
    const worst = worstCaseInstantForFloorFormula(secondStart);
    const exp = expWithGuaranteedRunway(BUFFER_SECONDS, worst);
    const runwayMs = exp * 1000 - worst;
    expect(runwayMs).toBeGreaterThanOrEqual(BUFFER_SECONDS * 1000);
  });
});

describe('expWithFloorRunway — the OLD formula, kept only as a positive control', () => {
  it.each(boundaryInstants(1_700_000_000_000))(
    'runway from nowMs=%i is NOT reliably >= the buffer (can be as little as just above 0)',
    (nowMs) => {
      const exp = expWithFloorRunway(BUFFER_SECONDS, nowMs);
      const runwayMs = exp * 1000 - nowMs;
      // Never negative in the normal (non-forced) case — floor(nowMs/1000)
      // is always <= nowMs/1000, so exp*1000 - nowMs > 0 for any ordinary
      // instant. The point is the LOWER bound is nowhere near the buffer.
      expect(runwayMs).toBeGreaterThan(0);
      expect(runwayMs).toBeLessThanOrEqual((BUFFER_SECONDS + 1) * 1000);
    },
  );

  it('POSITIVE CONTROL: fed the worst-case instant, runway against the real now it came from is already <= 0', () => {
    // worstCaseInstantForFloorFormula(secondStart) simulates "what Date.now()
    // would have to return at computation time" for the OLD formula's
    // runway (measured against the REAL now, secondStart) to be smallest —
    // it is not itself the point being measured against. Comparing runway
    // to `worst` instead of `secondStart` would trivially read ~1ms > 0
    // every time, hiding exactly the bug this is supposed to demonstrate.
    const secondStart = 1_700_000_000_000;
    const worst = worstCaseInstantForFloorFormula(secondStart);
    const exp = expWithFloorRunway(1, worst); // the exact old fixture: +1, not the general buffer
    const runwayMs = exp * 1000 - secondStart;
    expect(runwayMs).toBeLessThanOrEqual(0);
  });
});
