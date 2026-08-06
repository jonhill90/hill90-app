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
// floor) cannot land in one route and not its sibling. Deliberately NOT
// stricter than what POST already enforced — a bare falsy check, matching
// every one of the three POSTs' existing behavior exactly, not inventing
// new validation beyond parity.
export function requiredNonEmptyError(value: unknown, label: string): string | null {
  if (!value) return `${label} is required`;
  return null;
}
