#!/usr/bin/env bats

# app#517's follow-up. Realm `hill90` was retired 2026-07-30, and the fix in
# #519 covered tests/e2e/auth-theme.spec.ts, but compose/local.yml and
# compose/local.infra.yml still pointed KEYCLOAK_ISSUER, KEYCLOAK_JWKS_URI,
# AUTH_KEYCLOAK_ISSUER and KEYCLOAK_INTERNAL_ISSUER at /realms/hill90 — a
# realm that does not exist on the very Keycloak these env vars target.
#
# Verified live (not just read): bringing up compose/local.yml's own
# postgres+keycloak in isolation, /realms/hill90 404s and /realms/platform
# 200s, because compose/local/keycloak/realm-local.json — the file this
# Keycloak imports — declares "realm": "platform". The --standalone local
# dev path was silently broken: its own app services pointed at a realm
# their own Keycloak never imported.
#
# These are static assertions against the compose files' text, checked
# against the realm realm-local.json actually declares (read dynamically,
# not hardcoded) rather than assuming "platform" stays the answer forever.
# They never bring up Docker.

setup() {
  REALM_FILE="$BATS_TEST_DIRNAME/../../compose/local/keycloak/realm-local.json"
  LOCAL_YML="$BATS_TEST_DIRNAME/../../compose/local.yml"
  INFRA_YML="$BATS_TEST_DIRNAME/../../compose/local.infra.yml"
  [ -f "$REALM_FILE" ] || skip "realm-local.json not found"
  [ -f "$LOCAL_YML" ] || skip "compose/local.yml not found"
  [ -f "$INFRA_YML" ] || skip "compose/local.infra.yml not found"
  REALM=$(python3 -c "import json; print(json.load(open('$REALM_FILE'))['realm'])")
  [ -n "$REALM" ]
}

# Only lines that are live config, not comments explaining the history —
# this repo's convention (see #519) writes retirement history in prose, and
# that prose is expected to still say `hill90`.
live_hill90_refs() {
  local file="$1"
  grep -vE '^\s*#' "$file" | grep -c 'realms/hill90' || true
}

@test "compose/local.yml's env vars do not point at the retired hill90 realm" {
  run live_hill90_refs "$LOCAL_YML"
  [ "$output" -eq 0 ] || { echo "compose/local.yml still has $output live reference(s) to realms/hill90 — its own Keycloak imports realm '$REALM', not hill90"; return 1; }
}

@test "compose/local.infra.yml's env vars do not point at the retired hill90 realm" {
  run live_hill90_refs "$INFRA_YML"
  [ "$output" -eq 0 ] || { echo "compose/local.infra.yml still has $output live reference(s) to realms/hill90 — it overlays the same app-keycloak, which imports realm '$REALM'"; return 1; }
}

@test "compose/local.yml's Keycloak env vars point at the realm realm-local.json actually imports" {
  run bash -c "grep -vE '^\s*#' '$LOCAL_YML' | grep -c 'realms/$REALM'"
  [ "$output" -ge 4 ] || { echo "expected at least 4 live references to realms/$REALM (KEYCLOAK_ISSUER/JWKS_URI x2 services, AUTH_KEYCLOAK_ISSUER, KEYCLOAK_INTERNAL_ISSUER), found $output"; return 1; }
}

@test "compose/local.infra.yml's Keycloak env vars point at the realm realm-local.json actually imports" {
  run bash -c "grep -vE '^\s*#' '$INFRA_YML' | grep -c 'realms/$REALM'"
  [ "$output" -ge 4 ] || { echo "expected at least 4 live references to realms/$REALM, found $output"; return 1; }
}
