// app#599. Three routes (workflows.ts, container-profiles.ts, mcp-servers.ts)
// have a required string field on POST — name is required everywhere,
// docker_image and prompt in one route each — and PUT never gained the
// equivalent check. Each POST already rejects a missing/empty value with a
// bare falsy check (`if (!name) ...`); PUT skipped validation entirely and
// passed the raw value straight into `COALESCE($n, col)` with no `|| null`
// conversion, so an explicit `''` from a PUT body was actually WRITTEN —
// an unnamed workflow, a container profile with no docker_image, an MCP
// server with no name — the exact input POST already refuses for the
// identical field.
//
// One function, used by every POST/PUT pair that has this shape, so a
// future edit to what "required" means (trimming whitespace, a length
// floor) cannot land in one route and not its sibling. For '' specifically,
// deliberately NOT stricter than what POST already enforced — a bare falsy
// check, matching every one of the three POSTs' existing behavior exactly,
// not inventing new validation beyond parity.
export function requiredNonEmptyError(value: unknown, label: string): string | null {
  if (!value) return `${label} is required`;
  return null;
}

// Review of #594/#601 together surfaced a real disagreement, not just a
// naming inconsistency: #594's invalidTransportError treats explicit JSON
// `null` the same as an omitted field (COALESCE keeps the column
// unchanged); #601's PUT gates originally checked only `!== undefined`,
// so `null` reached requiredNonEmptyError and was rejected as invalid —
// same shape of field (a NOT NULL column with no "clear it" PUT
// operation), opposite answers, decided in the same review pass. #594's
// reasoning wins here: it is written down and tied to the column's actual
// NOT NULL constraint, and it matches what COALESCE($n, col) itself
// already does with a bound SQL NULL — falls back to "unchanged" — so a
// caller sending `null` and a caller omitting the field get the same
// (correct, harmless) result either way. Treating them differently would
// only ever produce a 400 for an input that, had validation not existed
// at all, would have been silently and safely ignored.
//
// One function, so this decision cannot be made twice — every PUT gate in
// this codebase that has "was this field actually provided, distinct from
// COALESCE's own already-safe null-handling" should call this, not
// reimplement the `!== undefined && !== null` check inline.
export function wasProvided(value: unknown): boolean {
  return value !== undefined && value !== null;
}
