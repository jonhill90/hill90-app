#!/usr/bin/env bats

# The deploy path must not resurrect a retired stack.
#
# Two stacks have now been retired in production — `auth` (app-keycloak, 2026-07-30)
# and `db` (app-postgres, 2026-07-31). In both cases the container was stopped and
# removed on the VPS, and in both cases the stack was still listed in DEPLOY_REST
# afterwards, which means `deploy all` would have recreated it. That is the failure
# mode these tests exist to prevent, and it is silent: recreating app-postgres would
# succeed, report healthy, and leave a second Postgres running that nothing reads —
# so nothing would break loudly enough to notice.
#
# These are static assertions against scripts/deploy.sh plus one invocation that must
# refuse. They never touch a VPS and never run docker.

setup() {
  DEPLOY="$BATS_TEST_DIRNAME/../../scripts/deploy.sh"
  [ -f "$DEPLOY" ] || skip "scripts/deploy.sh not found"
}

# Read DEPLOY_REST as the script itself defines it, rather than grepping for a
# literal. A grep would keep passing if the variable were renamed or reassigned
# further down the file.
deploy_rest() {
  bash -c 'set -a; eval "$(sed -n "/^DEPLOY_FIRST=/,/^DEPLOY_ORDER=/p" "$1")"; printf "%s" "$DEPLOY_REST"' _ "$DEPLOY"
}

@test "DEPLOY_REST is non-empty and contains the stacks that are still live" {
  run deploy_rest
  [ "$status" -eq 0 ]
  # Guard against the vacuous pass: if DEPLOY_REST parsed as empty, every
  # "does not contain" assertion below would succeed for the wrong reason.
  [ -n "$output" ]
  for live in api ai knowledge mcp minio; do
    [[ " $output " == *" $live "* ]] || { echo "live stack '$live' missing from DEPLOY_REST: '$output'"; return 1; }
  done
}

@test "DEPLOY_REST does not contain the retired db stack" {
  run deploy_rest
  [ -n "$output" ]
  [[ " $output " != *" db "* ]] || { echo "db is still in DEPLOY_REST: '$output' — 'deploy all' would recreate app-postgres"; return 1; }
}

@test "DEPLOY_REST does not contain the retired auth stack" {
  run deploy_rest
  [ -n "$output" ]
  [[ " $output " != *" auth "* ]] || { echo "auth is still in DEPLOY_REST: '$output'"; return 1; }
}

@test "deploying the retired db stack refuses, and says so in a greppable way" {
  run bash "$DEPLOY" db prod
  # Must fail, and must fail with the refusal rather than any other error —
  # a missing .env or an absent docker would also be non-zero.
  [ "$status" -ne 0 ]
  [[ "$output" == *"Refusing to recreate"* ]] || { echo "expected a refusal, got: $output"; return 1; }
  [[ "$output" == *RETIRED* ]]
  [[ "$output" == *app-postgres* ]]
  # The refusal must point at the record and the backup, because someone reading
  # it is mid-incident and needs to know a restore is possible.
  [[ "$output" == *retiring-app-postgres* ]]
  [[ "$output" == */opt/hill90/backups/* ]]
  # And it must say the volume survived, which is the question that actually
  # matters at that moment.
  [[ "$output" == *prod_app-postgres-data* ]]
}

@test "the refusal fires BEFORE anything environment-dependent" {
  # This is the assertion that stops the test passing for the wrong reason. Until
  # 2026-07-31 the auth refusal sat after cmd_preflight, so on any machine without
  # Hill90's networks `deploy auth` died with "Hill90's shared networks are missing"
  # and the retirement notice was never reached — while a naive grep for RETIRED
  # still passed, because the stack SUMMARY line contains that word. A retirement
  # must not be reported as a platform outage.
  for stack in db auth; do
    run bash "$DEPLOY" "$stack" prod
    [ "$status" -ne 0 ]
    [[ "$output" != *"Preflight"* ]] || { echo "$stack reached preflight before refusing: $output"; return 1; }
    [[ "$output" != *"networks are missing"* ]] || { echo "$stack failed as an outage, not a retirement"; return 1; }
    [[ "$output" != *"compose:"* ]] || { echo "$stack printed the deploy banner before refusing"; return 1; }
  done
}

@test "deploying the retired auth stack refuses" {
  run bash "$DEPLOY" auth prod
  [ "$status" -ne 0 ]
  [[ "$output" == *"Refusing to recreate"* ]] || { echo "expected a refusal, got: $output"; return 1; }
  [[ "$output" == *RETIRED* ]]
  [[ "$output" == *retiring-app-keycloak* ]]
}

@test "the retired stacks are still listed in usage, marked retired rather than deleted" {
  # Deleting them from usage would make `deploy db` fail with "unknown stack",
  # which reads as a typo rather than a decision.
  run bash "$DEPLOY" help
  [ "$status" -eq 0 ]
  [[ "$output" == *db*RETIRED* ]] || { echo "usage does not mark db as retired"; return 1; }
  [[ "$output" == *auth*RETIRED* ]] || { echo "usage does not mark auth as retired"; return 1; }
}

@test "the db compose file is kept, because local development still uses it" {
  # local.sh layers deploy/compose/overrides/local.db.yml on top of the prod file.
  # Deleting the prod file to 'finish' the retirement would break local.
  [ -f "$BATS_TEST_DIRNAME/../../deploy/compose/prod/docker-compose.db.yml" ]
  [ -f "$BATS_TEST_DIRNAME/../../deploy/compose/overrides/local.db.yml" ]
  run grep -c 'RETIRED IN PRODUCTION' "$BATS_TEST_DIRNAME/../../deploy/compose/prod/docker-compose.db.yml"
  [ "$output" -ge 1 ]
}
