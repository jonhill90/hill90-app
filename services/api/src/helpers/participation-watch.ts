/**
 * Authorisation on a long-lived stream must be re-checked, not just captured.
 *
 * THE GAP THIS CLOSES (issue #196). Participation was checked exactly once, at
 * connect — `terminal-proxy.ts` before the upgrade, `chat.ts` before each SSE
 * stream. app#156 armed a deadline on the token's `exp`, so EXPIRY ends a stream.
 * REVOCATION did not: remove someone from a thread while their terminal or event
 * stream was open and it kept delivering until their token happened to expire.
 *
 * Removal is the action an operator takes when they want access gone now, usually
 * because something is wrong — and a stream that outlives its authorisation is
 * precisely the case where nobody is watching.
 *
 * WHY THIS IS A MODULE AND NOT THREE COPIES. Three call sites need the identical
 * policy. CONTRIBUTING's "Look for the twin before you look for the next defect"
 * was written after six instances in one day of a fix landing in one place and not
 * its twin, and the recurring cause was a decision typed out repeatedly instead of
 * named once. The fail-closed rule below is exactly the kind of decision that must
 * not drift, so it lives here and the callers pass in their own query.
 */

/**
 * The guarantee this buys, stated as a number rather than left to be inferred
 * from a timer interval: the re-check runs on each caller's EXISTING 30s tick
 * (`PING_INTERVAL_MS` in terminal-proxy, the SSE heartbeats in chat), so the
 * worst case between a removal committing and the stream closing is
 * ~30 seconds plus one query round-trip. It is not immediate, and nothing here
 * should be read as claiming it is.
 */
/*
 * Deliberately NOT exported as a constant. The re-check has no interval of its
 * own — it rides `PING_INTERVAL_MS` (terminal-proxy) and the two SSE heartbeats,
 * which are 30s each for their own reasons. A constant here would claim to be the
 * period while changing nothing if edited, which is worse than the prose above.
 */

/**
 * Is the viewer still allowed on this stream?
 *
 * FAILS CLOSED. If the participation query throws — the pool is exhausted, the
 * database is briefly unreachable, the query times out — this returns false and
 * the stream ends. A check that treats "I could not tell" as "allowed" is not a
 * check, and this is the branch that would otherwise be written three different
 * ways in three files.
 *
 * The cost of failing closed is bounded by reconnection, which is why it is the
 * cheap choice as well as the correct one: an SSE client reconnects on its own
 * (EventSource, with Last-Event-ID) and re-authorises on the new request, so a
 * transient error costs a reconnect rather than access. A terminal WebSocket does
 * not reconnect by itself, so there the cost is a session the user must reopen —
 * still the right trade against streaming to someone who has been removed, but
 * worth knowing rather than discovering.
 */
export async function stillAuthorised(
  isParticipant: () => Promise<boolean>,
  label: string,
): Promise<boolean> {
  try {
    return await isParticipant();
  } catch (err) {
    console.error(`[${label}] participation re-check failed; ending stream (fail closed):`, err);
    return false;
  }
}

/** Ends an SSE stream whose viewer is no longer a participant. */
export function endStreamForRevokedAccess(
  res: { write(chunk: string): unknown; end(): unknown },
  label: string,
): void {
  console.log(`[${label}] Closing stream: participation revoked`);
  res.write(
    `event: error\ndata: ${JSON.stringify({
      error: 'Access revoked',
      detail: 'The stream ended because you are no longer a participant in this thread.',
    })}\n\n`,
  );
  res.end();
}
