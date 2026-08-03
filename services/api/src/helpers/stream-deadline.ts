/**
 * End a long-lived stream when the credential that authorised it expires.
 *
 * A request is authenticated once, by requireAuth, and then an SSE response is
 * held open indefinitely — the agents event stream polls every 3s and the chat
 * streams heartbeat, both of which defeat any idle timeout. So without this the
 * stream outlives its token: it keeps delivering after the credential expires,
 * after the user signs out, and after their roles are revoked.
 *
 * This is app#145's defect on a different transport. That one was the terminal
 * WebSocket — a shell, and the more serious surface — but the shape is identical
 * and it was missed on the four SSE endpoints because the fix was applied where
 * the defect was found rather than everywhere the shape lives. Hence one helper
 * rather than four copies of a setTimeout.
 *
 * THE CLAMP IS NOT OPTIONAL. setTimeout stores its delay in a signed 32-bit int;
 * a larger value overflows and the timer fires IMMEDIATELY. Unclamped, the naive
 * version of this turns a long-lived session into one that dies the instant it
 * opens — and it would present as "streams are broken", nowhere near this line.
 */

/** setTimeout's ceiling. Beyond this a delay wraps and fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface DeadlineTarget {
  write(chunk: string): boolean;
  end(): void;
  writableEnded: boolean;
  destroyed: boolean;
}

/**
 * Arm a deadline from a JWT `exp` (seconds since epoch).
 *
 * Returns a cleanup that must be called when the stream ends for any other
 * reason. An armed timer holding a closed response is the leak class
 * docs/decisions/api-suite-flakiness.md spent a day on.
 *
 * Returns null when `exp` is absent or not a number: callers treat that as
 * "refuse", rather than silently running an unbounded stream.
 */
export function armCredentialDeadline(
  res: DeadlineTarget,
  exp: unknown,
  onExpired: () => void,
): (() => void) | null {
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;

  const msRemaining = exp * 1000 - Date.now();
  if (msRemaining <= 0) return null;

  const timer = setTimeout(() => {
    if (res.writableEnded || res.destroyed) return;
    onExpired();
  }, Math.min(msRemaining, MAX_TIMEOUT_MS));

  return () => clearTimeout(timer);
}

/**
 * The standard ending: say why, then stop. A stream that simply goes quiet is
 * indistinguishable from an idle one, and the client cannot tell that
 * re-authenticating is what would fix it.
 */
export function endStreamForExpiredCredential(res: DeadlineTarget, label: string): void {
  console.log(`[${label}] Closing stream: credential expired`);
  res.write(
    `event: error\ndata: ${JSON.stringify({
      error: 'Credential expired',
      detail: 'The stream ended because the credential that authorised it expired.',
    })}\n\n`,
  );
  res.end();
}
