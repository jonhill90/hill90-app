/**
 * One page of a knowledge listing, and the real total behind it.
 *
 * Three components list knowledge entries — AgentMemory, AgentNotebook and
 * KnowledgeClient. The page size lives here rather than in each of them
 * because this repo's recurring defect is drift: #141 existed because a clamp
 * sat on one endpoint and not its twin, #153 because the fix went to one route
 * and not the other. A bound typed in three files is three chances to fix two.
 */

/** Rows requested per page. The knowledge service's own default is 500. */
export const KNOWLEDGE_PAGE_SIZE = 100

export interface KnowledgePage<T> {
  entries: T[]
  /**
   * Rows matching the query upstream — NOT `entries.length`.
   *
   * Null when the response carried no `X-Total-Count`, which means some hop in
   * the chain is older than this build. Callers must render that case as
   * "unknown", never as `entries.length`: a total derived from the page agrees
   * with itself and reports truncation as completeness, which is the whole
   * defect (#180).
   */
  total: number | null
}

/**
 * Fetch one page of entries and the total that goes with it.
 *
 * Returns a bare array in `entries` even when the response is malformed — the
 * callers already guard with `Array.isArray`, and preserving that shape is why
 * the total travels in a header rather than in the body.
 */
export async function fetchKnowledgePage<T>(
  path: string,
  params: Record<string, string>,
  { limit = KNOWLEDGE_PAGE_SIZE, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<KnowledgePage<T>> {
  const qs = new URLSearchParams({
    ...params,
    limit: String(limit),
    offset: String(offset),
  })

  const res = await fetch(`${path}?${qs}`)
  if (!res.ok) return { entries: [], total: null }

  const data = await res.json()
  const entries: T[] = Array.isArray(data) ? data : []

  // Optional chaining only for test doubles — a real Response always has
  // headers. A double without them lands on the unknown-total path, which is
  // the honest reading of "this response carried no total".
  return { entries, total: parseTotal(res.headers?.get?.('X-Total-Count') ?? null) }
}

/** Parse X-Total-Count, refusing anything that would render as NaN. */
export function parseTotal(header: string | null): number | null {
  if (header === null || header === '') return null
  const n = Number(header)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * The line under a list heading: "showing 100 of 40,000".
 *
 * When `total` is unknown it says only how many are shown, and deliberately
 * does NOT fall back to the shown count as if it were the total — an unknown
 * total must read as unknown, not as complete.
 */
export function describePage(shown: number, total: number | null): string {
  const n = shown.toLocaleString()
  if (total === null) return `${n} shown`
  if (total <= shown) return `${n} ${total === 1 ? 'entry' : 'entries'}`
  return `showing ${n} of ${total.toLocaleString()}`
}
