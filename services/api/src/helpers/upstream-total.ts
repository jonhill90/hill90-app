/**
 * The upstream's real total, from `X-Total-Count`, falling back to the page.
 *
 * ONE implementation, used by both proxies. It lived in `akm-proxy.ts` and the
 * shared-knowledge proxy did not read the header at all, so #180's total
 * stopped at the api boundary for sources. Copying it would have made two
 * copies of the rule that a page length is not a total — which is the rule
 * itself, duplicated.
 *
 * The fallback to `data.length` is deliberate and is NOT a total: it is what an
 * older upstream that sends no header can honestly offer, and the callers that
 * matter compare it against the page to decide whether to say "of".
 */
export function totalFrom(resp: Response, data: unknown): number | null {
  const fallback = Array.isArray(data) ? data.length : null;
  const header = resp.headers?.get?.('X-Total-Count');
  if (header === null || header === undefined || header === '') return fallback;

  const parsed = Number(header);
  // A non-numeric header must not become NaN on a dashboard.
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
