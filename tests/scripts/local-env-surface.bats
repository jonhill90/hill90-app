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
