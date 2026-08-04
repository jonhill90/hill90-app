import { Request } from 'express';

/**
 * Shared paging parameters for bounded list endpoints.
 *
 * ONE definition, deliberately. This repo's recurring defect is drift — #141
 * existed because a clamp sat on one endpoint and not its twin, #153 because
 * the fix went to one route and not the other. A bound typed in each route is
 * one chance per route to get it wrong, and no chance at all to notice.
 */

/** Rows returned when a caller asks for no particular number. */
export const DEFAULT_PAGE = 500;

/** Upper bound on a single page, mirroring the knowledge service's own clamp. */
export const MAX_PAGE = 2000;

export interface PageParams {
  limit?: number;
  offset?: number;
}

/**
 * Read `limit`/`offset` from the query string.
 *
 * REJECTED rather than clamped. A caller that asks for 5000 and silently
 * receives 2000 has been handed an answer that is not what it asked for and
 * does not say so — the same silent-success family these endpoints are being
 * bounded to remove. Rejecting also stops the api forwarding garbage upstream
 * and translating a validation error into a 500.
 */
export function parsePageParams(req: Request): PageParams | { error: string } {
  const out: PageParams = {};

  for (const key of ['limit', 'offset'] as const) {
    const raw = req.query[key];
    if (raw === undefined) continue;

    const n = Number(raw);
    if (!Number.isInteger(n)) return { error: `${key} must be an integer` };
    if (key === 'limit' && (n < 1 || n > MAX_PAGE)) {
      return { error: `limit must be between 1 and ${MAX_PAGE}` };
    }
    if (key === 'offset' && n < 0) return { error: 'offset must be >= 0' };
    out[key] = n;
  }

  return out;
}
