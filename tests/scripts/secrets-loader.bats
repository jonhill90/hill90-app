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
# container still reported healthy — its healthcheck is an HTTP GET of /api/health
# asserting 200, which does not touch auth.
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
        # tr the files to a single line first: a pipe split across two lines
        # defeated a per-line grep, and the audit proved it.
        for f in scripts/*.sh; do
            sed -E 's/^[[:space:]]*#.*//' \"\$f\" | tr '\\n' ' ' \
              | grep -oE '\\|[[:space:]]*_export_env_pairs' | sed \"s|^|\$f: |\"
        done || true
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

# --- gaps an adversarial audit found in the first version of this suite -----

@test "exports must reach a CHILD PROCESS, not just the shell (set -a variant)" {
    # The audit removed `set -a` from _export_env_pairs and the entire suite still
    # passed, while reproducing the incident exactly: variables set in the shell,
    # the gate satisfied, docker compose seeing nothing. compose is a child
    # process, so this asserts what a child sees.
    _stub_sops
    printf 'AUTH_SECRET=child-visible\n' > "$FIXTURE"
    run bash -c "
        export PATH=\"$BATS_TEST_TMPDIR/bin:\$PATH\"
        export SOPS_AGE_KEY_FILE='$BATS_TEST_TMPDIR/age.key'
        unset APP_ENV_FILE
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod '$FIXTURE' >/dev/null 2>&1
        # a genuine child process, as docker compose is
        bash -c 'printf \"CHILD=[%s]\\n\" \"\$AUTH_SECRET\"'
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"CHILD=[child-visible]"* ]]
}

@test "require_secrets fails on a shell variable that was never exported" {
    run bash -c "
        source '$REPO_ROOT/scripts/_common.sh'
        AUTH_SECRET=set-but-not-exported
        require_secrets AUTH_SECRET
    "
    [ "$status" -ne 0 ]
    [[ "$output" == *"AUTH_SECRET"* ]]
}

@test "require_secrets refuses to pass when called with no arguments" {
    run bash -c "source '$REPO_ROOT/scripts/_common.sh'; require_secrets"
    [ "$status" -ne 0 ]
}

@test "stack_secrets matches what each prod compose file interpolates" {
    # Guards the table against drift. The audit reduced ui) to an empty list and
    # the whole suite stayed green.
    #
    # `|| true` on every grep is load-bearing: _common.sh sets `set -euo pipefail`,
    # so a grep matching nothing aborts the loop. That silently truncated an
    # earlier version of this test at the first stack with no required variables.
    run bash "$BATS_TEST_DIRNAME/table-check.sh" "$REPO_ROOT"
    [ "$status" -eq 0 ]
}

@test "cmd_deploy still calls require_secrets and the interpolation gate" {
    # The audit deleted the whole gate block from cmd_deploy and the suite stayed
    # green. This asserts the wiring exists, not merely the helpers.
    run bash -c "
        cd '$REPO_ROOT'
        sed -n '/^cmd_deploy()/,/^}/p' scripts/deploy.sh > /tmp/cd.\$\$
        grep -q 'require_secrets' /tmp/cd.\$\$ && grep -q 'require_compose_interpolation' /tmp/cd.\$\$
        rc=\$?; rm -f /tmp/cd.\$\$; exit \$rc
    "
    [ "$status" -eq 0 ]
}

@test "stack_secrets fails closed for an unknown stack" {
    run bash -c "
        cd '$REPO_ROOT'
        source scripts/_common.sh >/dev/null 2>&1
        eval \"\$(sed -n '/^stack_secrets()/,/^}/p' scripts/deploy.sh)\"
        stack_secrets not-a-real-stack
    "
    [ "$status" -ne 0 ]
}

# --- the interpolation gate, which shipped inert and then shipped fatal --------

@test "require_compose_interpolation passes clean compose and catches an unset variable" {
    # Needs docker, so it is skipped where docker is unavailable rather than
    # failing. The two bugs it guards were both silent: the gate killed a healthy
    # deploy with no message, and before that it returned 0 on a broken one.
    command -v docker >/dev/null 2>&1 || skip "docker not available"
    docker info >/dev/null 2>&1 || skip "docker daemon not running"
    run bash "$BATS_TEST_DIRNAME/interpolation-gate-check.sh" "$BATS_TEST_TMPDIR" "$REPO_ROOT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"CLEAN_PASSES"* ]]
    [[ "$output" == *"UNSET_CAUGHT"* ]]
    [[ "$output" == *"NAMES_THE_VARIABLE"* ]]
}

# --- inert store keys (the AUTH_KEYCLOAK_ISSUER trap) -----------------------

@test "every key in the secrets store is consumed by something" {
    # Fails when a store key is not interpolated by any compose file and is not an
    # allowlisted tooling-only key. This is the generalisable form of the
    # AUTH_KEYCLOAK_ISSUER defect: a value an operator can edit to no effect, with
    # no warning, because the compose file recomposes it from parts that all carry
    # `:-` defaults so require_compose_interpolation can never fire.
    run bash "$BATS_TEST_DIRNAME/store-keys-check.sh" "$REPO_ROOT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"ALL_KEYS_CONSUMED"* ]]
}

@test "the issuer is composed from exactly one source of truth" {
    # api, mcp and ui must all derive the issuer from APP_AUTH_HOST/BASE_DOMAIN/
    # KC_REALM. If any of them read a literal AUTH_KEYCLOAK_ISSUER from the store
    # instead, the two can disagree and `iss` mismatches between the token the UI
    # obtains and the token the API validates.
    run bash -c "
        cd '$REPO_ROOT'
        # no compose file may interpolate a literal AUTH_KEYCLOAK_ISSUER
        if grep -rE '\\\$\{AUTH_KEYCLOAK_ISSUER' deploy/compose >/dev/null 2>&1; then
            echo 'LITERAL_ISSUER_INTERPOLATED'; exit 1
        fi
        # and all three consumers must compose it from the parts
        for f in docker-compose.api.yml docker-compose.mcp.yml docker-compose.ui.yml; do
            grep -q 'APP_AUTH_HOST' \"deploy/compose/prod/\$f\" || { echo \"NO_PARTS \$f\"; exit 1; }
        done
        echo ONE_SOURCE_OF_TRUTH
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"ONE_SOURCE_OF_TRUTH"* ]]
}

# --- app-keycloak must not follow APP_AUTH_HOST -----------------------------

@test "app-keycloak's hostname and router rule are pinned, not APP_AUTH_HOST-derived" {
    # Guards a latent production hazard: Traefik labels bake at container creation,
    # so an APP_AUTH_HOST-derived rule would not fail at migration time — it would
    # fail on a later unrelated `deploy.sh auth`, by claiming Hill90's own
    # auth.<domain> hostname and taking Grafana/Portainer/OpenBao SSO with it.
    run bash "$BATS_TEST_DIRNAME/keycloak-host-pin-check.sh" "$REPO_ROOT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"PIN_HOLDS"* ]]
}

# --- front and back channel must not diverge --------------------------------

@test "no compose file hardcodes a JWKS URI at a specific Keycloak container" {
    # KEYCLOAK_JWKS_URI was pinned to http://app-keycloak:8080/... in api and mcp,
    # so flipping APP_AUTH_HOST moved only the FRONT channel: the login page would
    # look fine while every authenticated API and MCP call 401'd, and reverting
    # APP_AUTH_HOST alone would restore the login page and leave calls broken — a
    # revert that looks like it worked.
    #
    # Both services derive the JWKS URI from KEYCLOAK_ISSUER when it is unset, so
    # leaving it unset makes APP_AUTH_HOST the single knob.
    run bash -c "
        cd '$REPO_ROOT'
        if grep -rn 'KEYCLOAK_JWKS_URI=http' deploy/compose/prod/ 2>/dev/null | grep -v '^\\s*#'; then
            echo HARDCODED_JWKS; exit 1
        fi
        # and the issuer must still be present, or nothing derives the JWKS URI
        for f in docker-compose.api.yml docker-compose.mcp.yml; do
            grep -q 'KEYCLOAK_ISSUER=' \"deploy/compose/prod/\$f\" || { echo \"NO_ISSUER \$f\"; exit 1; }
        done
        echo SINGLE_KNOB
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"SINGLE_KNOB"* ]]
}

@test "KEYCLOAK_ISSUER and KEYCLOAK_JWKS_URI cannot disagree about host or realm" {
    # Generalises the #26 defect: two independently-settable values for one OIDC
    # relationship. Passes only when the JWKS URI is unset (derived) or written
    # literally in terms of ${KEYCLOAK_ISSUER}.
    run bash "$BATS_TEST_DIRNAME/issuer-jwks-agree-check.sh" "$REPO_ROOT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"ISSUER_JWKS_CANNOT_DIVERGE"* ]]
}
