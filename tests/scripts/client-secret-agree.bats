#!/usr/bin/env bats

# The client secret in the running Keycloak must equal AUTH_KEYCLOAK_SECRET in the
# store. If they diverge, Keycloak authenticates the user and then refuses the
# code-for-token exchange with `unauthorized_client`, and every health check still
# passes: app-ui is healthy, /api/auth/signin returns 200, and the failure happens
# one redirect later.
#
# THIS IS NOT HYPOTHETICAL. It was the live state of production on 2026-07-29 and
# had been since the app was first deployed. Nobody noticed because nobody had ever
# completed a login — the redirect chain was verified and the token exchange was
# not. Keycloak had a 32-char minted secret, the store a 64-char one that was never
# applied.
#
# Why it happens: platform/auth/keycloak/hill90-realm.json declares the confidential
# clients with NO `secret` field, and app-keycloak runs `start --import-realm`, so
# Keycloak mints a random secret at import. It will do so again on ANY re-import,
# including during the one-Keycloak migration.
#
# The comparison is deliberately separated from the fetching so it can be tested
# without a live Keycloak or an age key. These tests drive the comparison directly.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  # shellcheck disable=SC1090
  source "${REPO_ROOT}/scripts/_common.sh"
}

@test "identical secrets pass" {
  run assert_client_secret_agrees "hill90-ui" "abc123" "abc123"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CLIENT_SECRET_AGREES"* ]]
}

@test "differing secrets FAIL closed" {
  run assert_client_secret_agrees "hill90-ui" "from-keycloak" "from-store"
  [ "$status" -ne 0 ]
  [[ "$output" == *"CLIENT_SECRET_MISMATCH"* ]]
}

@test "an empty STORE value fails — it must not be treated as a match" {
  run assert_client_secret_agrees "hill90-ui" "from-keycloak" ""
  [ "$status" -ne 0 ]
  [[ "$output" == *"CLIENT_SECRET"* ]]
}

@test "an empty KEYCLOAK value fails" {
  run assert_client_secret_agrees "hill90-ui" "" "from-store"
  [ "$status" -ne 0 ]
  # Positive anchor: a missing function also exits non-zero (127), so the status
  # alone would pass before the guard was written.
  [[ "$output" == *"CLIENT_SECRET"* ]]
}

@test "BOTH empty fails — two blanks are equal and must still not pass" {
  # The failure this guards against: a fetch that silently returns nothing and a
  # store value that decrypted to nothing would compare equal and report success.
  # That is the shape of the secrets-loader incident, in a different place.
  run assert_client_secret_agrees "hill90-ui" "" ""
  [ "$status" -ne 0 ]
  [[ "$output" == *"CLIENT_SECRET"* ]]
}

@test "the failure message never contains either secret value" {
  run assert_client_secret_agrees "hill90-ui" "SUPERSECRET_KC" "SUPERSECRET_STORE"
  [ "$status" -ne 0 ]
  # Anchor first — otherwise empty output satisfies both negatives.
  [[ "$output" == *"CLIENT_SECRET_MISMATCH"* ]]
  [[ "$output" != *"SUPERSECRET_KC"* ]]
  [[ "$output" != *"SUPERSECRET_STORE"* ]]
}

@test "the failure message reports lengths and hash prefixes, so it is diagnosable" {
  run assert_client_secret_agrees "hill90-ui" "0123456789012345678901234567890a" "abc"
  [ "$status" -ne 0 ]
  [[ "$output" == *"32"* ]]   # the keycloak-side length
  [[ "$output" == *"3"* ]]    # the store-side length
  [[ "$output" == *"sha256"* ]]
}

@test "the success message never contains the secret either" {
  run assert_client_secret_agrees "hill90-ui" "MATCHINGSECRET" "MATCHINGSECRET"
  [ "$status" -eq 0 ]
  [[ "$output" != *"MATCHINGSECRET"* ]]
}

@test "the message names the client, so a multi-client check is readable" {
  run assert_client_secret_agrees "hill90-vault" "a" "b"
  [ "$status" -ne 0 ]
  [[ "$output" == *"hill90-vault"* ]]
}

@test "the failure explains the symptom, not just the fact" {
  # An operator reading this at 6am needs to know what it breaks.
  run assert_client_secret_agrees "hill90-ui" "a" "b"
  [[ "$output" == *"unauthorized_client"* ]]
}

@test "deploy.sh runs the check on the path the pipeline actually uses" {
  cd "$REPO_ROOT"
  # Not only inside cmd_all: a guard that lives on the bulk verb the runbook tells
  # you NOT to use is missing from the single-stack path the pipeline runs. That
  # exact mistake was made once already with require_agentbox_path.
  run grep -q "require_client_secret_matches" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "the fetch helper exists and is separate from the comparison" {
  run declare -F require_client_secret_matches
  [ "$status" -eq 0 ]
  run declare -F assert_client_secret_agrees
  [ "$status" -eq 0 ]
}

@test "the hash in the AGREES message is actually populated" {
  # The first implementation printed an EMPTY hash here: it chose its hashing tool
  # with `cmd | ... || fallback`, and `||` reads the exit status of the LAST command
  # in the pipeline (cut), which succeeds even when the tool is missing. The verdict
  # was still correct, but the diagnostic silently emptied.
  run assert_client_secret_agrees "hill90-ui" "abcdef123456" "abcdef123456"
  [ "$status" -eq 0 ]
  [[ "$output" =~ sha256/12\ [0-9a-f]{12} ]]
}

@test "the hashes in the MISMATCH message are actually populated" {
  run assert_client_secret_agrees "hill90-ui" "aaaa" "bbbb"
  [ "$status" -ne 0 ]
  # Two distinct 12-hex-char hashes must appear, not empty strings.
  [[ "$(printf '%s' "$output" | grep -coE 'sha256/12 [0-9a-f]{12}')" == "2" ]]
}

@test "the hash survives pipefail being OFF as well as on" {
  # The bug only appeared with pipefail disabled, so pin both settings.
  set +o pipefail
  run assert_client_secret_agrees "hill90-ui" "zzzz" "zzzz"
  [ "$status" -eq 0 ]
  [[ "$output" =~ sha256/12\ [0-9a-f]{12} ]]
}
