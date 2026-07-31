#!/usr/bin/env bats

# The database provisioners must not default to a container that was retired.
#
# scripts/provision-akm-db.sh and scripts/provision-litellm-db.sh both defaulted
# PG_CONTAINER to ${CONTAINER_PREFIX:-}app-postgres. That was correct until 2026-07-31,
# when app-postgres was retired — after which the default named a container that cannot
# exist in production, and the failure message told the operator to run
# `scripts/deploy.sh db`, which now deliberately REFUSES. A wrong default whose error
# message sends you to a command that refuses costs more than no default.
#
# These tests run the scripts with a PG_CONTAINER that certainly does not exist, so they
# exercise the failure path only. Nothing is provisioned and no database is touched.

setup() {
  AKM="$BATS_TEST_DIRNAME/../../scripts/provision-akm-db.sh"
  LITELLM="$BATS_TEST_DIRNAME/../../scripts/provision-litellm-db.sh"
  [ -f "$AKM" ] || skip "provision-akm-db.sh not found"
  [ -f "$LITELLM" ] || skip "provision-litellm-db.sh not found"
}

# Read the effective default without running the script, so the assertion is about the
# default itself rather than about whatever happens to be running on this machine.
default_container() {
  sed -n 's/^PG_CONTAINER="\${PG_CONTAINER:-\(.*\)}"$/\1/p' "$1"
}

@test "both provisioners default to the platform Postgres, not the retired app-postgres" {
  for s in "$AKM" "$LITELLM"; do
    run default_container "$s"
    [ "$status" -eq 0 ]
    # Guard the vacuous case: an empty parse would satisfy every != below.
    [ -n "$output" ] || { echo "could not parse a PG_CONTAINER default out of $s"; return 1; }
    [ "$output" = "postgres" ] || { echo "$s defaults to '$output', expected 'postgres'"; return 1; }
    [[ "$output" != *app-postgres* ]]
    # CONTAINER_PREFIX must NOT be applied — the platform container is Hill90's and
    # carries no prefix of ours. A prefixed default silently misses it.
    [[ "$output" != *CONTAINER_PREFIX* ]] || { echo "$s still prefixes the platform container"; return 1; }
  done
}

@test "a missing container fails legibly, and does NOT send the operator to deploy.sh db" {
  for s in "$AKM" "$LITELLM"; do
    PG_CONTAINER=definitely-not-a-real-container run bash "$s"
    [ "$status" -ne 0 ]
    [[ "$output" == *definitely-not-a-real-container* ]] || { echo "error does not name the container: $output"; return 1; }
    # The specific regression: the old message recommended a command that now refuses.
    [[ "$output" != *"bash scripts/deploy.sh db"* ]] || { echo "$s still points at 'deploy.sh db', which refuses"; return 1; }
    # It must say what to do instead, for both of the two places you could be.
    [[ "$output" == *RETIRED* ]] || { echo "error does not mention the retirement: $output"; return 1; }
    [[ "$output" == *"PG_CONTAINER=app-postgres"* ]] || { echo "error does not give the local override: $output"; return 1; }
    [[ "$output" == *retiring-app-postgres* ]]
  done
}

@test "the failure names which database it was going to provision" {
  # 'Container not found' alone does not say what did not happen.
  PG_CONTAINER=nope run bash "$AKM"
  [[ "$output" == *hill90_akm* ]]
  PG_CONTAINER=nope run bash "$LITELLM"
  [[ "$output" == *hill90_litellm* ]]
}

@test "neither script claims to have granted anything to the tenant role" {
  # They grant to the superuser only. Silence there produces a database that
  # authenticates and then fails every query, which reads as a broken app.
  for s in "$AKM" "$LITELLM"; do
    run grep -c 'hill90_app' "$s"
    [ "$output" -ge 1 ] || { echo "$s never mentions the tenant role it does not grant"; return 1; }
  done
}
