#!/usr/bin/env bats
#
# Regression tests for scripts/_common.sh's secrets loader.
#
# These exist because of a production incident: hill90.com served app-ui with
# AUTH_SECRET, AUTH_KEYCLOAK_ID and AUTH_KEYCLOAK_SECRET all empty, and
# /api/auth/signin returned 500 MissingSecret. The store was correct; the loader
# silently exported nothing.
#
# load_secrets was `sops -d "$file" | _export_env_pairs`. The right-hand side of a
# pipe runs in a subshell, so `set -a; source` exported into a shell that exited
# immediately and nothing reached the caller. Nothing errored. `docker compose`
# then substituted "" for every unset variable with only a warning, and the
# container passed its healthcheck because the healthcheck probes the port.
#
# Deliberately dependency-free: no sops, no age key, no Docker, no VPS. The bug is
# in variable scoping, so it reproduces with a plaintext fixture and must be
# testable in CI.

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    export PROJECT_ROOT="$REPO_ROOT"
    export SCRIPT_DIR="$REPO_ROOT/scripts"
    FIXTURE="$BATS_TEST_TMPDIR/fixture.env"
}

# --- the regression itself -------------------------------------------------

# Stub sops so the SOPS branch of load_secrets runs without sops, an age key or
# the VPS. This matters: the bug lives ONLY on that branch. APP_ENV_FILE takes a
# separate redirect path that was already correct, so a test written through
# APP_ENV_FILE passes against the broken code and proves nothing.
_stub_sops() {
    mkdir -p "$BATS_TEST_TMPDIR/bin"
    cat > "$BATS_TEST_TMPDIR/bin/sops" <<STUB
#!/usr/bin/env bash
# emulate: sops -d <file>  -> plaintext on stdout
for a in "\$@"; do case "\$a" in -*) ;; *) f="\$a" ;; esac; done
cat "\$f"
STUB
    chmod +x "$BATS_TEST_TMPDIR/bin/sops"
    : > "$BATS_TEST_TMPDIR/age.key"
}

@test "load_secrets exports into the CALLER's shell, not a subshell (SOPS path)" {
    _stub_sops
    cat > "$FIXTURE" <<'EOF'
AUTH_SECRET=s3cr3t-value
AUTH_KEYCLOAK_ID=hill90-ui
AUTH_KEYCLOAK_SECRET=client-secret-value
EOF
    run bash -c "
        export PATH="$BATS_TEST_TMPDIR/bin:\$PATH"
        export SOPS_AGE_KEY_FILE='$BATS_TEST_TMPDIR/age.key'
        unset APP_ENV_FILE
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod '$FIXTURE' >/dev/null 2>&1
        printf 'AUTH_SECRET=[%s]\n' \"\${AUTH_SECRET:-}\"
        printf 'AUTH_KEYCLOAK_ID=[%s]\n' \"\${AUTH_KEYCLOAK_ID:-}\"
        printf 'AUTH_KEYCLOAK_SECRET=[%s]\n' \"\${AUTH_KEYCLOAK_SECRET:-}\"
    "
    [ "$status" -eq 0 ]
    # Against the piped shape these are all [] — the production failure exactly.
    [[ "$output" == *"AUTH_SECRET=[s3cr3t-value]"* ]]
    [[ "$output" == *"AUTH_KEYCLOAK_ID=[hill90-ui]"* ]]
    [[ "$output" == *"AUTH_KEYCLOAK_SECRET=[client-secret-value]"* ]]
}

@test "_export_env_pairs exports into the caller when fed by redirect" {
    printf 'DEMO_ONE=alpha\nDEMO_TWO=beta\n' > "$FIXTURE"
    run bash -c "
        source '$REPO_ROOT/scripts/_common.sh'
        _export_env_pairs < '$FIXTURE'
        printf 'DEMO_ONE=[%s] DEMO_TWO=[%s]\n' \"\${DEMO_ONE:-}\" \"\${DEMO_TWO:-}\"
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"DEMO_ONE=[alpha] DEMO_TWO=[beta]"* ]]
}

# --- properties the loader must not lose while being fixed ----------------

@test "values containing spaces and quotes survive" {
    cat > "$FIXTURE" <<'EOF'
WITH_SPACES=hello world again
WITH_QUOTES=say "hi" then 'bye'
EOF
    run bash -c "
        export APP_ENV_FILE='$FIXTURE'
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod >/dev/null 2>&1
        printf 'S=[%s]\n' \"\${WITH_SPACES:-}\"
        printf 'Q=[%s]\n' \"\${WITH_QUOTES:-}\"
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *'S=[hello world again]'* ]]
    [[ "$output" == *"Q=[say \"hi\" then 'bye']"* ]]
}

@test "an escaped-newline PEM survives as one single-line value" {
    printf 'AKM_SIGNING_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\nMC4CAQAwBQYDK2VwBCIEIL2\\n-----END PRIVATE KEY-----\\n\n' > "$FIXTURE"
    run bash -c "
        export APP_ENV_FILE='$FIXTURE'
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod >/dev/null 2>&1
        printf 'LEN=%s\n' \"\${#AKM_SIGNING_PRIVATE_KEY}\"
    "
    [ "$status" -eq 0 ]
    # Non-trivial length means the value was not truncated at the first space.
    [[ "$output" =~ LEN=([0-9]+) ]]
    [ "${BASH_REMATCH[1]}" -gt 40 ]
}

@test "a genuinely multi-line value is refused, not silently truncated" {
    cat > "$FIXTURE" <<'EOF'
GOOD=fine
BAD=-----BEGIN PRIVATE KEY-----
continuation-line-that-would-be-dropped
-----END PRIVATE KEY-----
EOF
    run bash -c "
        export APP_ENV_FILE='$FIXTURE'
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod
    "
    [ "$status" -ne 0 ]
    [[ "$output" == *"continuation-line-that-would-be-dropped"* ]]
}

# --- the cause fix: a loader that exports nothing must not pass -----------

@test "require_secrets fails when a required key is absent" {
    printf 'PRESENT=yes\n' > "$FIXTURE"
    run bash -c "
        export APP_ENV_FILE='$FIXTURE'
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod >/dev/null 2>&1
        require_secrets PRESENT MISSING_ONE
    "
    [ "$status" -ne 0 ]
    [[ "$output" == *"MISSING_ONE"* ]]
}

@test "require_secrets fails when a required key is present but EMPTY" {
    # The production failure mode exactly: the key exists and its value is "".
    printf 'AUTH_SECRET=\nOTHER=fine\n' > "$FIXTURE"
    run bash -c "
        export APP_ENV_FILE='$FIXTURE'
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod >/dev/null 2>&1
        require_secrets AUTH_SECRET OTHER
    "
    [ "$status" -ne 0 ]
    [[ "$output" == *"AUTH_SECRET"* ]]
}

@test "require_secrets passes when every required key is present and non-empty" {
    printf 'A=1\nB=2\n' > "$FIXTURE"
    run bash -c "
        export APP_ENV_FILE='$FIXTURE'
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod >/dev/null 2>&1
        require_secrets A B
    "
    [ "$status" -eq 0 ]
}

@test "no script pipes into a function that exports" {
    # The shape that caused the incident. Guards against it returning anywhere.
    run bash -c "
        cd '$REPO_ROOT'
        grep -nE '\\|[[:space:]]*_export_env_pairs' scripts/*.sh | grep -vE ':[[:space:]]*#' || true
    "
    [ -z "$output" ]
}

# --- akm key materialisation (the ai/knowledge outage) ---------------------

@test "an inlined PEM expands to a parseable key, and does NOT parse unexpanded" {
    # Delegated to a helper: the awk that inlines a PEM does not survive being
    # nested inside a bats double-quoted `run bash -c` string.
    run bash "$BATS_TEST_DIRNAME/pem-escape-check.sh" "$BATS_TEST_TMPDIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"EXPANDED_OK"* ]]
    [[ "$output" == *"LITERAL_REJECTED"* ]]
}

@test "materialise_akm_keys dies when a signing key is absent" {
    printf 'OTHER=fine\n' > "$FIXTURE"
    run bash -c "
        export APP_ENV_FILE='$FIXTURE'
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod >/dev/null 2>&1
        materialise_akm_keys
    "
    [ "$status" -ne 0 ]
    [[ "$output" == *"AKM_SIGNING_PRIVATE_KEY"* ]]
}

@test "materialise_akm_keys dies on a key whose escapes were not expanded" {
    # Simulates a store value that somehow arrives with real newlines already
    # mangled — the parse check must catch it rather than write garbage.
    printf 'AKM_SIGNING_PRIVATE_KEY=not-a-key\nMODEL_ROUTER_SIGNING_PRIVATE_KEY=also-not-a-key\n' > "$FIXTURE"
    run bash -c "
        export APP_ENV_FILE='$FIXTURE'
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod >/dev/null 2>&1
        materialise_akm_keys
    "
    [ "$status" -ne 0 ]
    [[ "$output" == *"did not parse as a key"* ]]
}

@test "cmd_deploy materialises akm keys for ai and knowledge" {
    run bash -c "
        cd '$REPO_ROOT'
        sed -n '/^cmd_deploy()/,/^}/p' scripts/deploy.sh | grep -q 'materialise_akm_keys'
    "
    [ "$status" -eq 0 ]
}

@test "the akm public key filenames match what the services read" {
    # knowledge reads /etc/akm/public.pem, ai reads /etc/akm/model-router-public.pem.
    # A rename in one place and not the other is silent until deploy.
    run bash -c "
        cd '$REPO_ROOT'
        grep -q 'AKM_PUBLIC_KEY_PATH=/etc/akm/public.pem' deploy/compose/prod/docker-compose.knowledge.yml
        grep -q 'PUBLIC_KEY_PATH=/etc/akm/model-router-public.pem' deploy/compose/prod/docker-compose.ai.yml
        grep -q 'out/public.pem' scripts/_common.sh
        grep -q 'model-router-public.pem' scripts/_common.sh
    "
    [ "$status" -eq 0 ]
}
