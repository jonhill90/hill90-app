#!/usr/bin/env bats

# A secret value must reach a container byte-identical, whatever characters it holds.
#
# The loader parses a dotenv stream and then SOURCES it, so every value makes a round
# trip through the shell:
#
#   grep ... | while IFS='=' read -r key value; do printf '%s=%q\n' "$key" "$value"; done
#   set -a; source "$temp_file"; set +a
#
# Two chances to be mangled: the IFS='=' split, and the requote-then-source. A value
# containing a quote, a backslash, a $ or a trailing = is where those go wrong, and the
# failure is silent -- the deploy succeeds with a corrupted credential, which is the
# family this estate has spent two days removing.
#
# Real values in this store that hit these cases: AUTH_SECRET and the AKM/model-router
# signing keys are base64 (trailing = padding), and the PEMs carry backslash escapes.
#
# Dependency-free: sops is stubbed, no age key, no Docker, no VPS.

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    export PROJECT_ROOT="$REPO_ROOT"
    export SCRIPT_DIR="$REPO_ROOT/scripts"
    FIXTURE="$BATS_TEST_TMPDIR/fixture.env"
    mkdir -p "$BATS_TEST_TMPDIR/bin"
    cat > "$BATS_TEST_TMPDIR/bin/sops" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in -*) ;; *) f="\$a" ;; esac; done
cat "\$f"
STUB
    chmod +x "$BATS_TEST_TMPDIR/bin/sops"
    : > "$BATS_TEST_TMPDIR/age.key"
}

# Load one KEY=VALUE through the real loader and print what the ENVIRONMENT ends up
# holding. printenv is deliberate: compose reads the exported environment, not a shell
# variable, and those differ.
_roundtrip() {
    local key="$1"
    run bash -c "
        export PATH='$BATS_TEST_TMPDIR/bin':\$PATH
        export SOPS_AGE_KEY_FILE='$BATS_TEST_TMPDIR/age.key'
        unset APP_ENV_FILE
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod '$FIXTURE' >/dev/null 2>&1
        printf '<%s>' \"\$(printenv $key)\"
    "
}

@test "a value containing a SINGLE QUOTE survives intact" {
    printf "%s\n" "AUTH_SECRET=it's-a-secret" > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = "<it's-a-secret>" ]
}

@test "a value containing a DOUBLE QUOTE survives intact" {
    printf '%s\n' 'AUTH_SECRET=say "hello"' > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = '<say "hello">' ]
}

@test "a value containing a BACKSLASH survives intact" {
    printf '%s\n' 'AUTH_SECRET=back\slash' > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = '<back\slash>' ]
}

@test "a value containing a DOLLAR is not expanded" {
    # $HOME must arrive literally. If it expands, the credential silently becomes a path.
    printf '%s\n' 'AUTH_SECRET=cost$HOME${PATH}' > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = '<cost$HOME${PATH}>' ]
}

@test "a value containing COMMAND SUBSTITUTION does not execute" {
    # The sharp end: a value is data, never code.
    printf '%s\n' 'AUTH_SECRET=a$(id -u)b`id -u`c' > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = '<a$(id -u)b`id -u`c>' ]
}

@test "BASE64 PADDING survives — trailing = must not be dropped" {
    # AUTH_SECRET and the signing keys are base64. Losing the padding gives a
    # silently-wrong credential and a deploy that reports success.
    printf '%s\n' 'AUTH_SECRET=YWJjZGVmZ2g=' > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = '<YWJjZGVmZ2g=>' ]
}

@test "DOUBLE base64 padding survives" {
    printf '%s\n' 'AUTH_SECRET=YWJjZGVmZw==' > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = '<YWJjZGVmZw==>' ]
}

@test "a value containing an INTERNAL equals sign survives" {
    printf '%s\n' 'AUTH_SECRET=a=b=c' > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = '<a=b=c>' ]
}

@test "a value with LEADING and TRAILING spaces survives" {
    printf '%s\n' 'AUTH_SECRET=  padded  ' > "$FIXTURE"
    _roundtrip AUTH_SECRET
    [ "$output" = '<  padded  >' ]
}

@test "all of them at once, in one store, still land correctly" {
    # A store is loaded as a whole; one bad value must not corrupt its neighbours.
    {
      printf '%s\n' "A_QUOTE=it's"
      printf '%s\n' 'B_DQUOTE=say "hi"'
      printf '%s\n' 'C_BSLASH=back\slash'
      printf '%s\n' 'D_DOLLAR=$HOME'
      printf '%s\n' 'E_PAD=YWJjZA=='
    } > "$FIXTURE"
    run bash -c "
        export PATH='$BATS_TEST_TMPDIR/bin':\$PATH
        export SOPS_AGE_KEY_FILE='$BATS_TEST_TMPDIR/age.key'
        unset APP_ENV_FILE
        source '$REPO_ROOT/scripts/_common.sh'
        load_secrets prod '$FIXTURE' >/dev/null 2>&1
        for k in A_QUOTE B_DQUOTE C_BSLASH D_DOLLAR E_PAD; do
            printf '%s=<%s>\n' \"\$k\" \"\$(printenv \$k)\"
        done
    "
    [[ "$output" == *"A_QUOTE=<it's>"* ]]
    [[ "$output" == *'B_DQUOTE=<say "hi">'* ]]
    [[ "$output" == *'C_BSLASH=<back\slash>'* ]]
    [[ "$output" == *'D_DOLLAR=<$HOME>'* ]]
    [[ "$output" == *'E_PAD=<YWJjZA==>'* ]]
}
