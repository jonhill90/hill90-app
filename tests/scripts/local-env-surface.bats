#!/usr/bin/env bats

# .env.local must supply every variable the tenant path reads without a default.
#
# The three production retirements (app-keycloak #62, app-postgres #63, app-minio)
# changed the PRODUCTION compose files to read PLATFORM_DB_* and MINIO_TENANT_*.
# The local overrides LAYER on those files, so local began reading them too — and
# nothing supplied them. Compose does not fail on an unset variable, it warns and
# substitutes an empty string, so api/ai/knowledge were handed
# `postgresql://:@:5432/hill90_api`. Since #61 app-ai fails closed on a missing
# database, so a clean `local.sh up` failed outright.
#
# It reached main because deploy.sh has an interpolation gate and local.sh did
# not: production would have refused, local rendered blanks and said nothing.
#
# These tests need no docker daemon: they read the scripts and compose files.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  cd "$REPO_ROOT" || exit 1
}

# Source only the two generator helpers, so the test does not execute local.sh's
# dispatcher. Anchored on `^name()` so a rename fails loudly instead of silently
# extracting nothing.
load_helpers() {
  local extracted
  extracted="$(sed -n '/^tenant_platform_keys()/,/^}/p;/^topup_env()/,/^}/p' scripts/local.sh)"
  [ -n "$extracted" ] || { echo "could not extract helpers from scripts/local.sh"; return 1; }
  eval "$extracted"
}

@test "every no-default variable the tenant path reads is in .env.local.example" {
  run python3 - <<'PY'
import re, sys, pathlib
STACKS = "db auth api ai knowledge mcp minio ui".split()
files = []
for st in STACKS:
    files += [pathlib.Path(f"deploy/compose/prod/docker-compose.{st}.yml"),
              pathlib.Path(f"deploy/compose/overrides/local.{st}.yml")]
files.append(pathlib.Path("deploy/compose/overrides/local.networks.yml"))
PAT = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?][^}]*)?\}")
bare = {}
for f in files:
    if not f.exists():
        print("MISSING FILE", f); sys.exit(1)
    for line in f.read_text().splitlines():
        if line.strip().startswith("#"):
            continue
        for m in PAT.finditer(line):
            if not m.group(2):
                bare.setdefault(m.group(1), set()).add(f.name)
supplied = {m.group(1) for line in pathlib.Path(".env.local.example").read_text().splitlines()
            if (m := re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=", line))}
missing = sorted(set(bare) - supplied)
if missing:
    print("MISSING FROM .env.local.example:")
    for v in missing:
        print(f"  {v}  (read by {', '.join(sorted(bare[v]))})")
    sys.exit(1)
print("ok")
PY
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "the generator writes the platform keys a fresh clone needs" {
  load_helpers
  run tenant_platform_keys
  [ "$status" -eq 0 ]
  for key in PLATFORM_DB_HOST PLATFORM_DB_USER PLATFORM_DB_PASSWORD \
             MINIO_ENDPOINT MINIO_TENANT_ACCESS_KEY MINIO_TENANT_SECRET_KEY; do
    echo "$output" | grep -qE "^${key}=." || { echo "missing or empty: $key"; return 1; }
  done
}

@test "topup adds only missing keys and never overwrites an existing value" {
  load_helpers
  ENV_FILE="${BATS_TEST_TMPDIR}/.env.local"
  cat > "$ENV_FILE" <<'EOF'
DB_USER=hill90
PLATFORM_DB_HOST=somewhere-a-developer-chose
EOF
  run topup_env
  [ "$status" -eq 0 ]

  # The value a developer already set must survive untouched.
  grep -qx "PLATFORM_DB_HOST=somewhere-a-developer-chose" "$ENV_FILE"
  [ "$(grep -c '^PLATFORM_DB_HOST=' "$ENV_FILE")" -eq 1 ]

  # The rest must have been appended.
  for key in PLATFORM_DB_USER PLATFORM_DB_PASSWORD MINIO_ENDPOINT \
             MINIO_TENANT_ACCESS_KEY MINIO_TENANT_SECRET_KEY; do
    grep -qE "^${key}=." "$ENV_FILE" || { echo "not appended: $key"; return 1; }
  done
}

@test "topup is idempotent" {
  load_helpers
  ENV_FILE="${BATS_TEST_TMPDIR}/.env.local"
  printf 'DB_USER=hill90\n' > "$ENV_FILE"
  topup_env >/dev/null
  local first; first="$(wc -l < "$ENV_FILE")"
  topup_env >/dev/null
  local second; second="$(wc -l < "$ENV_FILE")"
  [ "$first" -eq "$second" ]
}

@test "local.sh up runs the interpolation gate before starting anything" {
  # deploy.sh has had this gate since hill90.com served app-ui with a blank
  # AUTH_SECRET while the deploy reported success. local.sh not having it is
  # why the PLATFORM_DB_* breakage reached main.
  run bash -c "sed -n '/^cmd_up()/,/^}/p' scripts/local.sh"
  echo "$output" | grep -q 'require_interpolation' \
    || { echo "cmd_up does not call require_interpolation"; return 1; }
  # It must run BEFORE compose up, not after.
  echo "$output" | grep -n 'require_interpolation\|compose up' \
    | awk -F: '/require_interpolation/{g=$1} /compose up/{u=$1} END{exit !(g && u && g < u)}' \
    || { echo "the gate does not run before 'compose up'"; return 1; }
}

@test "the gate is sourced from _common.sh, not copied" {
  # compose's warning has BACKSLASH-ESCAPED quotes (logfmt msg="..."). A second
  # copy of that regex is how the gate went silently inert once already.
  grep -q 'source .*scripts/_common.sh' scripts/local.sh \
    || { echo "local.sh does not source _common.sh for the gate"; return 1; }
  [ "$(grep -c 'variable is not set' scripts/local.sh)" -eq 0 ] \
    || { echo "local.sh has its own copy of the compose-warning pattern"; return 1; }
}

@test "the generated .env.local contains no shell-expanded backticks" {
  # gen_env's heredoc is UNQUOTED so \$(rand) works, which also made backticks in
  # its COMMENTS execute: the note explaining why the app's Keycloak host is not
  # `auth` rendered as "Deliberately NOT :" and printed three
  # "command not found" errors on every init.
  run bash -c "sed -n '/^gen_env()/,/^}/p' scripts/local.sh | grep -n '[^\\\\]\`'"
  [ "$status" -ne 0 ] || { echo "unescaped backtick inside gen_env's heredoc:"; echo "$output"; return 1; }
}

# ---------------------------------------------------------------------------
# Defects found on 2026-07-31 by tearing the tenant stack down WITH VOLUMES and
# bringing it up from nothing. Neither is visible on a restart — only a genuinely
# clean start reaches them.
# ---------------------------------------------------------------------------

@test "litellm's health start_period survives a first-run migration" {
  # On an empty database litellm applies its whole prisma migration set before
  # it binds the port. Measured: 172s from container start to first successful
  # probe. With start_period=15s it was marked unhealthy first, and app-ai's
  # `condition: service_healthy` aborted the entire `up` — app-ai never left
  # `Created`. It is invisible afterwards because a migrated database binds in
  # seconds.
  #
  # Parsed as YAML, not with an awk line range: the first version of this test
  # used `awk '/^  litellm:/,/^  [a-z]/'` and matched nothing, so it failed for
  # a reason unrelated to the thing it checks.
  run python3 -c "
import sys, yaml
d = yaml.safe_load(open('deploy/compose/prod/docker-compose.ai.yml'))
hc = (d['services']['litellm'].get('healthcheck') or {})
raw = str(hc.get('start_period', ''))
secs = int(raw.rstrip('s') or 0)
print(secs)
sys.exit(0 if secs >= 180 else 1)
"
  [ "$status" -eq 0 ] || { echo "litellm start_period is ${output}s, below the 172s a first run measured"; return 1; }
}

@test "app-ai still gates on litellm being healthy" {
  # The start_period fix is only meaningful while something waits on it. If this
  # dependency is dropped, app-ai races the proxy instead.
  run python3 -c "
import sys, yaml
d = yaml.safe_load(open('deploy/compose/prod/docker-compose.ai.yml'))
dep = (d['services']['ai'].get('depends_on') or {})
sys.exit(0 if dep.get('litellm', {}).get('condition') == 'service_healthy' else 1)
"
  [ "$status" -eq 0 ]
}

@test "local sets VOLUME_PREFIX so it cannot create production volume names" {
  # Compose declares volumes as ${VOLUME_PREFIX:-prod}_app-*. Unset locally, the
  # developer's stack created prod_app-postgres-data — a production name on a
  # laptop. CLAUDE.md invariant 4 calls volumes "the one that nearly caused data
  # loss" for exactly this reason.
  grep -qE '^VOLUME_PREFIX=.+' .env.local.example \
    || { echo "VOLUME_PREFIX is not set in .env.local.example"; return 1; }
  local v
  v=$(grep -E '^VOLUME_PREFIX=' .env.local.example | head -1 | cut -d= -f2-)
  [ "$v" != "prod" ] || { echo "VOLUME_PREFIX=prod locally is the bug, not the fix"; return 1; }
}

@test "all three parameterised prefixes are set locally, not just two" {
  # Invariant 3 names three. Two were set and the third silently was not, which
  # is how the volume naming drifted without anyone noticing.
  for key in CONTAINER_PREFIX NETWORK_PREFIX VOLUME_PREFIX; do
    grep -qE "^${key}=.+" .env.local.example \
      || { echo "${key} missing from .env.local.example"; return 1; }
  done
}

@test "a key that relocates state is announced, not applied silently" {
  # Appending VOLUME_PREFIX renames every volume the stack looks for, so an
  # existing developer's data is orphaned. That is fine for local dev and NOT
  # fine to do without saying so.
  grep -q 'tenant_disruptive_keys' scripts/local.sh \
    || { echo "no disruptive-key warning path in local.sh"; return 1; }
  run bash -c "sed -n '/^topup_env()/,/^}/p' scripts/local.sh"
  [[ "$output" == *"orphaned"* ]] || { echo "topup_env does not warn about orphaned volumes"; return 1; }
}

@test "the standalone fork's litellm has the same cold-start budget as the tenant path" {
  # Two files declare litellm. #77 fixed the tenant/production one and left the
  # standalone fork at 30s, whose 180s budget sat 8 seconds above a measured
  # 172s cold start. Assert they cannot drift apart again.
  run python3 -c "
import sys, yaml
def sp(path, svc):
    d = yaml.safe_load(open(path))
    raw = str((d['services'][svc].get('healthcheck') or {}).get('start_period', '0s'))
    return int(raw.rstrip('s') or 0)
prod = sp('deploy/compose/prod/docker-compose.ai.yml', 'litellm')
fork = sp('compose/local.yml', 'litellm')
print(f'prod={prod}s fork={fork}s')
sys.exit(0 if fork >= 180 and prod >= 180 else 1)
"
  [ "$status" -eq 0 ] || { echo "litellm start_period below the measured cold start: ${output}"; return 1; }
}

@test "raising a budget never came from interval or retries" {
  # start_period means "still doing one-time work". interval x retries governs
  # how fast a genuinely dead service is noticed, so padding those to buy
  # startup time hides real slowdowns.
  run python3 -c "
import sys, yaml
d = yaml.safe_load(open('deploy/compose/prod/docker-compose.ai.yml'))
hc = d['services']['litellm']['healthcheck']
iv = int(str(hc['interval']).rstrip('s')); rt = int(hc['retries'])
print(f'interval={iv}s retries={rt}')
sys.exit(0 if iv <= 60 and rt <= 5 else 1)
"
  [ "$status" -eq 0 ] || { echo "liveness detection was weakened to buy startup time: ${output}"; return 1; }
}
