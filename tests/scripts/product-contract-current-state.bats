#!/usr/bin/env bats

# The PRD is the current-state contract. Keep implemented identity presentation
# and the deliberately incomplete admin-management boundary distinct: calling
# either side "open" or "done" wholesale would mislead the next product slice.

setup() {
  PRD="$BATS_TEST_DIRNAME/../../docs/product/PRD.md"
  [ -f "$PRD" ] || skip "docs/product/PRD.md not found"
}

@test "PRD distinguishes merged display-name and read-only-admin slices from open identity-management work" {
  run grep -F 'merged app#611' "$PRD"
  [ "$status" -eq 0 ]

  run grep -F 'Display names are captured at write time' "$PRD"
  [ "$status" -eq 0 ]

  run grep -F 'admin-only, read-only user list is implemented' "$PRD"
  [ "$status" -eq 0 ]

  run grep -F 'Live Keycloak lookup/backfill, role writes, invitations, and SMTP proof remain open.' "$PRD"
  [ "$status" -eq 0 ]

  run grep -F 'app#611, not yet merged' "$PRD"
  [ "$status" -ne 0 ]
}
