/**
 * Shared by terminal-session-endings.test.ts (the real 4002 handshake) and
 * expiry-runway-arithmetic.test.ts (the pure arithmetic guarantee, no
 * sockets, no timers). Split deliberately — see that PR review on #404:
 * testing the arithmetic guarantee and the WebSocket behaviour in the same
 * test meant neither was actually proven. The forced worst-case instant
 * belongs in the arithmetic test, not fed into the real handshake, where it
 * silently roughly halves the intended margin instead of exercising it.
 */

/** The OLD formula this repo used to compute a test JWT's exp: discards the
 * sub-second remainder before adding N whole seconds, so real runway is
 * anywhere in (0, N] depending on where `nowMs` falls in its current
 * second — not bounded away from 0. Kept here only as the positive control
 * for the fixed formula below.
 */
export function expWithFloorRunway(bufferSeconds: number, nowMs: number): number {
  return Math.floor(nowMs / 1000) + bufferSeconds;
}

/**
 * An exp that leaves at least `bufferSeconds` of real runway no matter where
 * `nowMs` falls within its current second. Math.ceil rounds up to the next
 * whole second FIRST, so runway is always in [bufferSeconds, bufferSeconds+1)
 * — provably, not just usually.
 */
export function expWithGuaranteedRunway(bufferSeconds: number, nowMs: number): number {
  return Math.ceil(nowMs / 1000) + bufferSeconds;
}

/**
 * The instant that minimizes expWithFloorRunway's real runway: 1ms before
 * nowMs's current second started, i.e. .999 of the PREVIOUS second. floor()
 * only depends on which whole second a value falls in, so nudging within
 * nowMs's OWN second changes nothing — floor(nowMs/1000) is already
 * identical whichever millisecond of that second you pick. Landing one
 * second earlier is what makes floor(forced/1000)+1 resolve to nowMs's
 * current second, i.e. an exp already at or before nowMs itself.
 */
export function worstCaseInstantForFloorFormula(nowMs: number): number {
  return Math.floor(nowMs / 1000) * 1000 - 1;
}
