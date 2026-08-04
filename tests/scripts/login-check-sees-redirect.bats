#!/usr/bin/env bats

# A check that hardcodes a request parameter can never fail on that parameter.
#
# tenant-login-platform-test.sh hardcoded `redirect_uri` and grepped the client
# secret out of .env.local. On 2026-08-04 it printed four green assertions against a
# local stack where a browser login died on HTTP 400 `Invalid parameter: redirect_uri`
# (#271): the flow it ran and the flow a person runs had drifted apart, and no failure
# mode existed that could have said so.
#
# These tests hold the correction structurally, because the natural way to "simplify"
# that script later is to put the literal back.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  CHECK="${REPO_ROOT}/scripts/checks/tenant-login-platform-test.sh"
  UI_OVERRIDE="${REPO_ROOT}/deploy/compose/overrides/local.ui.yml"
}

# Everything below the shebang-and-comments block is the code that runs; the header
# quotes the old hardcode on purpose, so grepping the whole file would pass forever.
check_body() {
  grep -v '^[[:space:]]*#' "$CHECK"
}

@test "the check exists and is the one the README names" {
  [ -f "$CHECK" ]
  run grep -q "tenant-login-platform-test.sh" "${REPO_ROOT}/README.md"
  [ "$status" -eq 0 ]
}

@test "no callback URI is hardcoded in the executable part of the check" {
  # This is the assertion that fails on every commit before #271 was fixed.
  run bash -c "$(declare -f check_body); CHECK='$CHECK' check_body | grep -c 'localhost:13000'"
  [ "$output" = "0" ]
  run bash -c "$(declare -f check_body); CHECK='$CHECK' check_body | grep -c 'app.localtest.me'"
  [ "$output" = "0" ]
}

@test "the redirect_uri is derived from the UI's own AUTH_URL" {
  run bash -c "$(declare -f check_body); CHECK='$CHECK' check_body | grep -c 'ui_env AUTH_URL'"
  [ "$output" != "0" ]
  run bash -c "$(declare -f check_body); CHECK='$CHECK' check_body | grep -c 'REDIRECT=\"\${APP_URL%/}/api/auth/callback/keycloak\"'"
  [ "$output" != "0" ]
}

@test "the client secret comes from the UI container, not from an env file" {
  # It was `grep -E '^AUTH_KEYCLOAK_SECRET=' "$ENVF"`, which is a second copy of the
  # same defect: .env.local held local-dev-secret while the UI held another value.
  run bash -c "$(declare -f check_body); CHECK='$CHECK' check_body | grep -c 'AUTH_KEYCLOAK_SECRET=.*ENVF'"
  [ "$output" = "0" ]
  run bash -c "$(declare -f check_body); CHECK='$CHECK' check_body | grep -c 'SECRET=\$(ui_env AUTH_KEYCLOAK_SECRET)'"
  [ "$output" != "0" ]
}

@test "a rejected redirect_uri has its own failure branch, not a generic one" {
  run bash -c "$(declare -f check_body); CHECK='$CHECK' check_body | grep -c 'Invalid parameter: redirect_uri'"
  [ "$output" != "0" ]
}

# --- behaviour, with docker stubbed: no fallback exists ------------------------
#
# The property is "a missing value FAILS rather than being guessed". Assert it by
# running the script, not by reading it.

stub_docker() {
  STUB_DIR="$(mktemp -d)"
  cat >"${STUB_DIR}/docker" <<STUB
#!/usr/bin/env bash
case "\$1" in
  ps)   echo "stub-app-ui" ;;
  exec) exit 0 ;;   # every printenv returns nothing
  *)    exit 0 ;;
esac
STUB
  chmod +x "${STUB_DIR}/docker"
  ENV_STUB="$(mktemp)"
  echo "CONTAINER_PREFIX=stub-" >"$ENV_STUB"
}

teardown() {
  [ -n "${STUB_DIR:-}" ] && rm -rf "$STUB_DIR"
  [ -n "${ENV_STUB:-}" ] && rm -f "$ENV_STUB"
  return 0
}

@test "a UI with no AUTH_URL fails the check instead of falling back to a literal" {
  stub_docker
  run env PATH="${STUB_DIR}:$PATH" bash "$CHECK" "$ENV_STUB"
  [ "$status" -eq 1 ]
  [[ "$output" == *"neither AUTH_URL nor NEXTAUTH_URL"* ]]
  # And it stopped before contacting anything: a guessed redirect is the failure
  # this test exists to prevent, so no PASS line may be printed.
  [[ "$output" != *"PASS"* ]]
}

@test "a stack that is not running still SKIPs, so the check stays safe anywhere" {
  stub_docker
  cat >"${STUB_DIR}/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  ps) echo "something-else" ;;
  *)  exit 0 ;;
esac
STUB
  chmod +x "${STUB_DIR}/docker"
  run env PATH="${STUB_DIR}:$PATH" bash "$CHECK" "$ENV_STUB"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP"* ]]
  [[ "$output" == *"stub-app-ui"* ]]
}

# --- the configuration the check now measures ---------------------------------

@test "the local UI's AUTH_URL is the published port the platform client allows" {
  # #271's chosen fix. The other host, app.localtest.me:8080, is not in the
  # hill90-ui client's redirectUris — that client is Hill90's to write, not this
  # repo's, and production has exactly one UI origin.
  run grep -E '^\s+AUTH_URL: http://localhost:\$\{PORT_UI:-13000\}$' "$UI_OVERRIDE"
  [ "$status" -eq 0 ]
}

@test "the local UI's back-channel issuer is a container-reachable host" {
  # Behind the 400 sat a second defect: KEYCLOAK_INTERNAL_ISSUER was the
  # browser-facing host, which inside the container is 127.0.0.1 and refuses the
  # token exchange. NextAuth reports that as `error=Configuration`, naming nothing.
  run grep -E '^\s+KEYCLOAK_INTERNAL_ISSUER: http://\$\{KEYCLOAK_CONTAINER:-keycloak\}:8080/realms/' "$UI_OVERRIDE"
  [ "$status" -eq 0 ]
  run bash -c "grep 'KEYCLOAK_INTERNAL_ISSUER:' '$UI_OVERRIDE' | grep -c 'BASE_DOMAIN'"
  [ "$output" = "0" ]
}
