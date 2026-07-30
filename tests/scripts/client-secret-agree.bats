#!/usr/bin/env bats

# The app's client secret must actually AUTHENTICATE against the platform Keycloak.
#
# WHY THIS REPLACED A COMPARISON
#
# The first version of this guard read the client secret out of Keycloak over the
# ADMIN API and compared it to the store. That worked while the Keycloak was the
# app's own, because the app's store held its admin credentials. It cannot work now:
# the app is a tenant of the platform realm, and a tenant has no business holding the
# platform IdP's admin credentials. The guard failed closed on the first ui deploy
# with `admin_token_status=401` — correct behaviour, permanently unsatisfiable.
#
# The replacement asks the question that actually matters: can this client
# authenticate with the secret the store holds? Token introspection requires client
# authentication, so a correct secret returns 200 and a wrong one 401. It needs no
# privileges beyond the client's own credentials.
#
# It is also a better check than the comparison it replaces. Two strings matching
# proves storage agrees; a 200 proves the credential works — which is the property
# whose absence broke login for a day.
#
# And the assertion layer never sees the secret at all now: it takes an HTTP status.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  # shellcheck disable=SC1090
  source "${REPO_ROOT}/scripts/_common.sh"
}

@test "HTTP 200 means the client authenticated" {
  run assert_client_auth "hill90-ui" 200
  [ "$status" -eq 0 ]
  [[ "$output" == *"CLIENT_SECRET_WORKS"* ]]
}

@test "HTTP 401 is a wrong secret, and FAILS closed" {
  run assert_client_auth "hill90-ui" 401
  [ "$status" -ne 0 ]
  [[ "$output" == *"CLIENT_SECRET_REJECTED"* ]]
}

@test "the 401 message explains the symptom, not just the fact" {
  run assert_client_auth "hill90-ui" 401
  [[ "$output" == *"unauthorized_client"* ]]
}

@test "an unexpected status is UNVERIFIABLE and also fails" {
  # A 404 (wrong realm), a 000 (unreachable) or a 503 must not pass. A guard that
  # treats "could not tell" as "fine" reports success on the day it was needed.
  for code in 000 404 500 503; do
    run assert_client_auth "hill90-ui" "$code"
    [ "$status" -ne 0 ]
    [[ "$output" == *"CLIENT_SECRET_UNVERIFIABLE"* ]]
  done
}

@test "an empty status fails rather than passing" {
  run assert_client_auth "hill90-ui" ""
  [ "$status" -ne 0 ]
  [[ "$output" == *"CLIENT_SECRET_UNVERIFIABLE"* ]]
}

@test "the client name appears in every message" {
  for code in 200 401 503; do
    run assert_client_auth "hill90-vault" "$code"
    [[ "$output" == *"hill90-vault"* ]]
  done
}

@test "no message can contain a secret, because none is passed in" {
  # Structural, not incidental: the assertion takes a client name and a status.
  run grep -n "assert_client_auth()" "${REPO_ROOT}/scripts/_common.sh"
  [ "$status" -eq 0 ]
  run bash -c "sed -n '/^assert_client_auth()/,/^}/p' '${REPO_ROOT}/scripts/_common.sh' | grep -c 'AUTH_KEYCLOAK_SECRET'"
  [ "$output" = "0" ]
}

@test "deploy.sh runs the check on the path the pipeline actually uses" {
  cd "$REPO_ROOT"
  run grep -q "require_client_secret_works" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "the fetcher exists and is separate from the assertion" {
  run declare -F require_client_secret_works
  [ "$status" -eq 0 ]
  run declare -F assert_client_auth
  [ "$status" -eq 0 ]
}

@test "the guard no longer needs Keycloak admin credentials" {
  # The tenancy property. If this reappears, the guard becomes unsatisfiable again.
  # Anchor first: an empty sed range also greps to 0, so this would pass with no
  # function at all.
  run bash -c "sed -n '/^require_client_secret_works()/,/^}/p' '${REPO_ROOT}/scripts/_common.sh' | grep -c 'introspect'"
  [ "$output" != "0" ]
  run bash -c "sed -n '/^require_client_secret_works()/,/^}/p' '${REPO_ROOT}/scripts/_common.sh' | grep -c 'KC_ADMIN'"
  [ "$output" = "0" ]
}
