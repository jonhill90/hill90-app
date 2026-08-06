#!/usr/bin/env bats
#
# THE DEPLOY BODY MUST ACTUALLY RUN. Nothing in this repository executed it.
#
# On 2026-08-03 a one-word defect — `log "revision stamp: ..."`, where the helper
# is `info` and no `log` exists — shipped to main through a fully green pipeline
# and BLOCKED EVERY DEPLOY OF EVERY STACK. It aborted with exit 127 immediately
# before `docker compose build`.
#
# Nothing could have caught it:
#
#   bats        141/141 green. No test executed cmd_deploy's compose path; the
#               suite covers the guards AROUND the deploy, not the deploy.
#   CI          runs no shell from scripts/deploy.sh at all.
#   dry_run     PASSED — and structurally always will, because dry_run's whole
#               purpose is to skip the deploy step. A dry run cannot validate
#               the body of the thing it declines to do. See #158.
#
# `bash -n` does not help either: an undefined function is a runtime failure,
# not a syntax error. Proven below rather than asserted.
#
# So these tests execute the real code with docker stubbed, which is the only
# arrangement that can see this class.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    DEPLOY="$ROOT/scripts/deploy.sh"
    COMMON="$ROOT/scripts/_common.sh"

    # A stub PATH so nothing real is contacted. `docker` succeeds silently; the
    # point is whether OUR shell survives, not what docker would do.
    STUB="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/docker"
    chmod +x "$STUB/docker"
    PATH="$STUB:$PATH"
}

# ---------------------------------------------------------------------------
# The specific defect: the revision-stamp block, executed for real.
# ---------------------------------------------------------------------------

@test "the revision-stamp block runs without a command-not-found" {
    # Located by CONTENT, not line number, so moving the block does not silently
    # stop testing it. Everything from the DEPLOY_REVISION assignment up to the
    # first docker command.
    block=$(sed -n '/^    DEPLOY_REVISION=/,/^    docker compose/p' "$DEPLOY" | sed '$d')
    [ -n "$block" ]
    # It must contain the logging call, or this test is exercising nothing.
    [[ "$block" == *"revision stamp"* ]]

    run bash -c "
        set -euo pipefail
        source '$COMMON' >/dev/null 2>&1
        PROJECT_ROOT='$ROOT'
        $block
        echo REACHED_THE_END
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"REACHED_THE_END"* ]]
    [[ "$output" == *"revision stamp"* ]]
}

@test "CONTROL: the same block with the ORIGINAL defect aborts the deploy" {
    # Proves the test above can fail. Without this it could be passing because
    # the block is empty or the stub swallows everything.
    #
    # NOT asserted as 127, and the reason is worth knowing: `log` IS a real
    # binary on macOS — Apple's unified logging CLI at /usr/bin/log — so there it
    # runs and exits 64 with a usage message. On the Linux VPS nothing provides
    # `log`, so it is 127. Different code, same outcome: non-zero under set -e,
    # deploy aborted. Pinning 127 would have made this test pass on the VPS and
    # fail on a developer machine, for a defect that is real on both.
    block=$(sed -n '/^    DEPLOY_REVISION=/,/^    docker compose/p' "$DEPLOY" | sed '$d')
    broken="${block//info \"revision stamp/log \"revision stamp}"
    [ "$broken" != "$block" ]

    run bash -c "
        set -euo pipefail
        source '$COMMON' >/dev/null 2>&1
        PROJECT_ROOT='$ROOT'
        $broken
        echo REACHED_THE_END
    "
    [ "$status" -ne 0 ]
    [[ "$output" != *"REACHED_THE_END"* ]]
}

@test "CONTROL: bash -n does NOT catch it — that is why syntax checking was not enough" {
    # deploy.sh passes `bash -n` with the defect present. Recorded so nobody
    # concludes a syntax gate would have prevented this.
    printf '%s\n' 'log "hello"' > "$BATS_TEST_TMPDIR/broken.sh"
    run bash -n "$BATS_TEST_TMPDIR/broken.sh"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# The general rule, so the NEXT misnamed helper is caught too.
# ---------------------------------------------------------------------------

@test "every logging helper deploy.sh calls is actually defined" {
    # The defect class, generalised: a helper name that does not exist is a
    # runtime abort under set -e, wherever it appears.
    run bash -c "
        source '$COMMON' >/dev/null 2>&1
        missing=''
        while read -r fn; do
            [ -n \"\$fn\" ] || continue
            if [ \"\$(type -t \"\$fn\")\" != function ]; then missing=\"\$missing \$fn\"; fi
        done < <(grep -oE '^[[:space:]]+(log|info|warn|success|die|step|note|say|fail)[[:space:]]' '$DEPLOY' | tr -d ' \\t' | sort -u)
        [ -z \"\$missing\" ] || { echo \"UNDEFINED:\$missing\"; exit 1; }
        echo OK
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"OK"* ]]
}

@test "CONTROL: that rule reports a helper that does not exist" {
    # Same guard, pointed at a file that calls a helper nothing defines.
    printf '%s\n' '    log "x"' > "$BATS_TEST_TMPDIR/f.sh"
    run bash -c "
        source '$COMMON' >/dev/null 2>&1
        missing=''
        while read -r fn; do
            [ -n \"\$fn\" ] || continue
            if [ \"\$(type -t \"\$fn\")\" != function ]; then missing=\"\$missing \$fn\"; fi
        done < <(grep -oE '^[[:space:]]+(log|info|warn|success|die|step|note|say|fail)[[:space:]]' '$BATS_TEST_TMPDIR/f.sh' | tr -d ' \\t' | sort -u)
        [ -z \"\$missing\" ] || { echo \"UNDEFINED:\$missing\"; exit 1; }
        echo OK
    "
    [ "$status" -eq 1 ]
    [[ "$output" == *"UNDEFINED: log"* ]]
}

# ---------------------------------------------------------------------------
# app#558: the knowledge image-label verification guard, executed for real
# against a stubbed `docker`. This is a build-time property (does the IMAGE
# docker just built carry the right label) that no CI job actually builds an
# image to check — so what's tested here is the shell logic that reads the
# label back and reacts to it, the same "execute the real code with docker
# stubbed" arrangement the revision-stamp tests above already use, not the
# real docker build itself.
# ---------------------------------------------------------------------------

@test "the knowledge image-label guard passes when the label matches DEPLOY_REVISION" {
    block=$(sed -n '/^    if \[ "\$stack" = "knowledge" \]; then$/,/^    fi$/p' "$DEPLOY")
    [ -n "$block" ]
    [[ "$block" == *"com.hill90.revision"* ]]

    cat > "$STUB/docker" <<'SH'
#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    echo "abc123def456"
    exit 0
fi
exit 0
SH
    chmod +x "$STUB/docker"

    run bash -c "
        set -euo pipefail
        source '$COMMON' >/dev/null 2>&1
        stack=knowledge
        DEPLOY_REVISION=abc123def456
        $block
        echo REACHED_THE_END
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"REACHED_THE_END"* ]]
    [[ "$output" == *"com.hill90.revision=abc123def456"* ]]
}

@test "CONTROL: the guard dies when the image carries no revision label — the actual app#558 defect, reproduced" {
    # Simulates exactly what the missing `args:` block produced: `docker image
    # inspect` returning the empty string because the label was never set to
    # anything the build received.
    block=$(sed -n '/^    if \[ "\$stack" = "knowledge" \]; then$/,/^    fi$/p' "$DEPLOY")

    cat > "$STUB/docker" <<'SH'
#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    echo ""
    exit 0
fi
exit 0
SH
    chmod +x "$STUB/docker"

    run bash -c "
        set -euo pipefail
        source '$COMMON' >/dev/null 2>&1
        stack=knowledge
        DEPLOY_REVISION=abc123def456
        $block
        echo REACHED_THE_END
    "
    [ "$status" -ne 0 ]
    [[ "$output" != *"REACHED_THE_END"* ]]
    [[ "$output" == *"carries no com.hill90.revision label"* ]]
}

@test "CONTROL: the guard dies when the image label does not match DEPLOY_REVISION" {
    block=$(sed -n '/^    if \[ "\$stack" = "knowledge" \]; then$/,/^    fi$/p' "$DEPLOY")

    cat > "$STUB/docker" <<'SH'
#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    echo "stale-sha"
    exit 0
fi
exit 0
SH
    chmod +x "$STUB/docker"

    run bash -c "
        set -euo pipefail
        source '$COMMON' >/dev/null 2>&1
        stack=knowledge
        DEPLOY_REVISION=abc123def456
        $block
        echo REACHED_THE_END
    "
    [ "$status" -ne 0 ]
    [[ "$output" != *"REACHED_THE_END"* ]]
    [[ "$output" == *"is stamped stale-sha, expected abc123def456"* ]]
}

@test "the guard is skipped entirely for a stack other than knowledge" {
    # api/ai/ui/mcp never defined ARG GIT_REVISION in their Dockerfiles (see
    # compose-git-revision-args.bats), so this guard must not run `docker
    # image inspect` for them at all — not merely tolerate whatever it
    # returns. A docker call that FAILS proves the guard truly
    # short-circuited rather than calling inspect and happening to accept an
    # empty result.
    block=$(sed -n '/^    if \[ "\$stack" = "knowledge" \]; then$/,/^    fi$/p' "$DEPLOY")

    cat > "$STUB/docker" <<'SH'
#!/usr/bin/env bash
echo "docker should not have been called: $*" >&2
exit 1
SH
    chmod +x "$STUB/docker"

    run bash -c "
        set -euo pipefail
        source '$COMMON' >/dev/null 2>&1
        stack=api
        DEPLOY_REVISION=abc123def456
        $block
        echo REACHED_THE_END
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"REACHED_THE_END"* ]]
}
