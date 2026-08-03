#!/usr/bin/env bats
#
# cmd_teardown is the only function in deploy.sh that can destroy containers, and
# nothing had ever executed it.
#
# WHY THIS ONE AND NOT THE OTHER SIX. Judged by cost of being wrong, not by
# working down the list:
#
#   cmd_teardown      runs `docker compose down`. Its scoping comes entirely from
#                     stack_project, and deploy.sh's own comment says why that
#                     matters: "a shared project is exactly what lets a `down`
#                     reach a neighbour". The neighbour here is HILL90 — the
#                     platform whose containers share this host. Low frequency,
#                     maximum severity, and it breaks the estate's most-protected
#                     invariant.  --> tested here
#
#   cmd_preflight     runs every deploy, but its failure mode is loud: it dies or
#                     it passes, and the workflow re-checks SSH, the checkout and
#                     the age key in its own steps. Left.
#   cmd_all           gated behind an explicit confirmation and delegates to
#                     cmd_deploy. Left.
#   stack_compose,    one-line printf helpers. A defect surfaces immediately as a
#   stack_override,   missing file or a wrong banner, not as silent damage.
#   stack_summary     Left.
#   stack_project     NOT left — it is the input that decides teardown's blast
#                     radius, and it is exercised through the cases below, which
#                     is where its correctness actually matters.
#
# Nothing here runs a real docker. The stub records its argv so the test can
# assert what WOULD have been destroyed.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    DEPLOY="$ROOT/scripts/deploy.sh"
    [ -f "$DEPLOY" ] || skip "scripts/deploy.sh not found"

    STUB="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB"
    ARGV="$BATS_TEST_TMPDIR/docker-argv.txt"
    : > "$ARGV"

    cat > "$STUB/docker" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ARGV"
exit 0
SH
    chmod +x "$STUB/docker"
}

run_teardown() {
    # _common.sh must sit beside the copy — deploy.sh derives SCRIPT_DIR from
    # \${BASH_SOURCE[0]}. Learned the hard way in #167, where a harness that
    # could not load its helpers still produced two passing cases.
    local stripped="$BATS_TEST_TMPDIR/deploy-under-test.sh"
    cp "$ROOT/scripts/_common.sh" "$BATS_TEST_TMPDIR/_common.sh"
    sed '/^main "\$@"/d' "$DEPLOY" > "$stripped"
    # PROJECT_ROOT must be forced to the REAL repo. _common.sh derives it from
    # SCRIPT_DIR/.., which for the copy is the temp directory's parent, so
    # require_file looked for the compose files in /tmp and died. It honours a
    # pre-set value, so exporting it first wins.
    run env PATH="$STUB:$PATH" PROJECT_ROOT="$ROOT" bash -c "
        set -o pipefail
        cd '$ROOT'
        source '$stripped'
        cmd_teardown $*
    "
}

@test "GUARD: the harness actually reaches cmd_teardown" {
    # Without this every assertion below could pass on a script that never ran —
    # exactly the false pass #167 produced.
    run_teardown ui prod
    [[ "$output" == *"Teardown: ui"* ]]
    [ -s "$ARGV" ]
}

@test "teardown scopes the down to THIS APP's compose project" {
    run_teardown ui prod
    [ "$status" -eq 0 ]
    grep -q -- "-p hill90-app-prod-ui" "$ARGV"
    grep -q -- "down" "$ARGV"
}

@test "the project name is never empty — an empty -p lets compose pick its own" {
    # The specific hazard: `docker compose -p "" down` falls back to a
    # directory-derived project, which is how a down reaches containers it was
    # never scoped to.
    run_teardown api prod
    ! grep -qE -- '-p( |$)-f' "$ARGV"
    grep -qE -- "-p hill90-app-prod-api" "$ARGV"
}

@test "teardown names ONLY this app's compose file" {
    run_teardown api prod
    grep -q -- "deploy/compose/prod/docker-compose.api.yml" "$ARGV"
    # and nothing belonging to the platform
    ! grep -qiE "hill90/(app|platform)/|/opt/hill90/" "$ARGV"
}

@test "every live stack tears down under its own distinct project" {
    # Two stacks sharing a project would let one down take the other with it.
    for s in api ui ai knowledge mcp; do
        : > "$ARGV"
        run_teardown "$s" prod
        grep -q -- "-p hill90-app-prod-${s}" "$ARGV"
    done
}

@test "an unknown stack destroys NOTHING" {
    # stack_containers validates the name. If that validation were ever moved
    # after the down, a typo would be destructive.
    run_teardown definitely-not-a-stack prod
    [ "$status" -ne 0 ]
    [ ! -s "$ARGV" ]
}

@test "volumes are KEPT — teardown must not carry -v or --volumes" {
    # `down -v` deletes named volumes. On this host that is the app's Postgres
    # and MinIO data, and the estate has already had one near-miss from a volume
    # name collision. The script says volumes are kept; this is that promise.
    run_teardown ui prod
    ! grep -qE -- '(^| )(-v|--volumes)( |$)' "$ARGV"
    [[ "$output" == *"volumes: KEPT"* ]]
}

@test "CONTROL: the argv recorder can see a flag, so the -v case is not vacuous" {
    # If the stub recorded nothing, every "must not contain" assertion above
    # would pass for free.
    printf 'compose -p x -f y down -v\n' > "$ARGV"
    grep -qE -- '(^| )(-v|--volumes)( |$)' "$ARGV"
}

# ---------------------------------------------------------------------------
# --remove-orphans, banned for the neighbour's sake.
#
# Hill90 bans it globally — every script and workflow — and enforces it in CI,
# because a `down` carrying it deletes containers that share a Compose project
# name but belong to another stack. THIS REPO IS THE NEIGHBOUR that ban exists to
# protect the platform from: both deploys run as the same user on the same host.
#
# deploy.sh:607 already says it is deliberately not used. A comment is not a
# guard, and the argv assertion is stronger than a grep because it pins what
# docker actually RECEIVES rather than what the source happens to spell.
# ---------------------------------------------------------------------------

@test "teardown never passes --remove-orphans — it would reach a neighbour's containers" {
    run_teardown ui prod
    [ "$status" -eq 0 ]
    ! grep -qE -- '(^| )--remove-orphans( |$)' "$ARGV"
}

@test "no stack's teardown passes --remove-orphans" {
    for s in api ui ai knowledge mcp; do
        : > "$ARGV"
        run_teardown "$s" prod
        ! grep -qE -- '(^| )--remove-orphans( |$)' "$ARGV"
    done
}

@test "CONTROL: the recorder CAN see --remove-orphans, so the case is not vacuous" {
    # Same defence as the -v control: on an empty argv file every "must not
    # contain" assertion passes for free.
    printf 'compose -p x -f y down --remove-orphans\n' > "$ARGV"
    grep -qE -- '(^| )--remove-orphans( |$)' "$ARGV"
}

@test "no script or workflow in this repo uses --remove-orphans at all" {
    # Wider than Hill90's equivalent, which greps scripts/deploy.sh only. The
    # flag is dangerous wherever it appears, and the app has local.sh and its own
    # workflows that Hill90's check would never see.
    cd "$ROOT"
    run bash -c "grep -rn -- '--remove-orphans' scripts/ .github/ deploy/ compose/ 2>/dev/null | grep -v 'deliberately NOT used' | grep -v 'remove-orphans( |\$)' || true"
    [ -z "$output" ]
}

@test "CONTROL: that repo-wide grep finds the flag when it is present" {
    printf 'docker compose down --remove-orphans\n' > "$BATS_TEST_TMPDIR/planted.sh"
    run grep -rn -- '--remove-orphans' "$BATS_TEST_TMPDIR/planted.sh"
    [ "$status" -eq 0 ]
}
