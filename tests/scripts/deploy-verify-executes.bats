#!/usr/bin/env bats
#
# cmd_verify is the pipeline's post-deploy gate, and NOTHING has ever executed it.
#
# THE MEASUREMENT THAT LED HERE. Every function in scripts/deploy.sh was
# instrumented and the whole bats suite run against the instrumented copy:
#
#   executed by the suite    usage, stack_secrets, refuse_if_retired,
#                            cmd_deploy, main                       5 of 16
#   never executed           stack_compose, stack_override, stack_containers,
#                            stack_project, cname, stack_summary, cmd_verify,
#                            stack_assert, cmd_preflight, cmd_all,
#                            cmd_teardown                          11 of 16
#
# And function-level coverage flattered it. cmd_deploy reported six calls, yet the
# one-word defect inside it (#166) went unnoticed — because the six calls enter
# and abandon it within FOUR lines, at the retired-stack refusal. Checkpointing
# its body showed the suite reaching offsets 2, 3 and 4 of roughly 190. The only
# deeper hit came from #166's own test, which extracts the block and runs it in a
# subshell rather than through cmd_deploy.
#
# WHY cmd_verify WAS PICKED. It is what
# `reusable-deploy-service.yml:334` runs as "Verify readiness":
#
#     bash scripts/deploy.sh verify <service> prod
#
# So it executes on every production deploy and it is the last gate between a
# broken deploy and a green run — and no test has ever run a line of it. The
# property worth pinning is narrow: "<stack> ready" must be printed only when
# every container actually reported healthy.
#
# Nothing here touches a VPS or a real docker.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    DEPLOY="$ROOT/scripts/deploy.sh"
    [ -f "$DEPLOY" ] || skip "scripts/deploy.sh not found"

    STUB="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB"

    # `sleep` as a no-op: cmd_verify polls 45 times at 2s. Without this a single
    # failure case would take 90 seconds, which is how a test gets deleted.
    printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/sleep"
    chmod +x "$STUB/sleep"
}

# A docker stub whose `inspect` answer is controlled per container name.
# HEALTH_MAP is "name:status" pairs; anything absent reports an empty status,
# which is what a missing container looks like.
write_docker_stub() {
    cat > "$STUB/docker" <<'SH'
#!/usr/bin/env bash
if [ "$1" = "inspect" ]; then
    fmt="$3"; name="$4"
    for pair in $HEALTH_MAP; do
        n="${pair%%:*}"; s="${pair#*:}"
        if [ "$n" = "$name" ]; then
            case "$fmt" in
                *State.Health.Status*)
                    # The real format falls back to .State.Status when there is
                    # no health block, and that is `running` — not the word
                    # "nohealth". Getting this wrong made the no-healthcheck case
                    # untestable.
                    if [ "$s" = "nohealth" ]; then printf 'running'; else printf '%s' "$s"; fi ;;
                *)  [ "$s" != "nohealth" ] && printf 'yes' ;;
            esac
            exit 0
        fi
    done
    exit 1
fi
[ "$1" = "logs" ] && { echo "stub logs"; exit 0; }
exit 0
SH
    chmod +x "$STUB/docker"
}

# Run cmd_verify without executing deploy.sh's `main "$@"` at the bottom.
run_verify() {
    local stack="$1"
    # SOURCE a stripped COPY, rather than eval-ing the text.
    #
    # The first version used `eval "$(sed ... deploy.sh)"` under `set -u`, and
    # deploy.sh reads ${BASH_SOURCE[0]} at load time — unbound inside an eval, so
    # the script aborted before defining anything. Two cases still "passed",
    # because the harness's own error produced the non-zero status they asserted.
    # A false pass in a file written to close a coverage gap.
    # _common.sh must sit BESIDE the copy: deploy.sh derives SCRIPT_DIR from
    # ${BASH_SOURCE[0]} and sources "$SCRIPT_DIR/_common.sh", so a copy placed
    # anywhere else fails to load its helpers and defines nothing.
    local stripped="$BATS_TEST_TMPDIR/deploy-under-test.sh"
    cp "$ROOT/scripts/_common.sh" "$BATS_TEST_TMPDIR/_common.sh"
    sed '/^main "\$@"/d' "$DEPLOY" > "$stripped"
    run env PATH="$STUB:$PATH" HEALTH_MAP="$HEALTH_MAP" bash -c "
        set -o pipefail
        cd '$ROOT'
        source '$stripped'
        cmd_verify '$stack' prod
    "
}

@test "MEASUREMENT GUARD: cmd_verify is reachable and does something" {
    # If this file ever stops actually entering cmd_verify, every case below
    # becomes vacuous. It must produce its own waiting line.
    HEALTH_MAP="app-ui:healthy"
    write_docker_stub
    run_verify ui
    [[ "$output" == *"Waiting for ui to become healthy"* ]]
}

@test "a healthy container yields ready" {
    HEALTH_MAP="app-ui:healthy"
    write_docker_stub
    run_verify ui
    [ "$status" -eq 0 ]
    [[ "$output" == *"app-ui: healthy"* ]]
    [[ "$output" == *"ui ready"* ]]
}

@test "ALL containers in a multi-container stack must be healthy" {
    # api is app-api AND app-docker-proxy. Verifying one and declaring the stack
    # ready is the shape that would let half a deploy pass.
    HEALTH_MAP="app-api:healthy app-docker-proxy:healthy"
    write_docker_stub
    run_verify api
    [ "$status" -eq 0 ]
    [[ "$output" == *"app-api: healthy"* ]]
    [[ "$output" == *"app-docker-proxy: healthy"* ]]
}

@test "an UNhealthy container must NOT yield ready — the gate's whole job" {
    HEALTH_MAP="app-ui:unhealthy"
    write_docker_stub
    run_verify ui
    [ "$status" -ne 0 ]
    [[ "$output" != *"ui ready"* ]]
    [[ "$output" == *"failed its readiness check"* ]]
}

@test "one healthy and one not is still NOT ready" {
    # The partial case, which a loop that breaks on the first success would pass.
    HEALTH_MAP="app-api:healthy app-docker-proxy:unhealthy"
    write_docker_stub
    run_verify api
    [ "$status" -ne 0 ]
    [[ "$output" != *"api ready"* ]]
}

@test "a container that cannot be inspected at all is NOT ready" {
    # Absence is not health. An empty HEALTH_MAP makes every inspect fail, which
    # is what a container that was never created looks like.
    HEALTH_MAP=""
    write_docker_stub
    run_verify ui
    [ "$status" -ne 0 ]
    [[ "$output" != *"ui ready"* ]]
}

@test "a container with NO healthcheck is accepted but SAID OUT LOUD" {
    # Deliberate and documented in cmd_verify: a container with no healthcheck can
    # only ever report `running`. It is accepted so the poll does not time out,
    # and warned about because it is a weaker claim. Pinned so it cannot quietly
    # become a silent tick — which would downgrade verification to "the process
    # started" while still printing success.
    HEALTH_MAP="app-ui:nohealth"
    write_docker_stub
    run_verify ui
    [[ "$output" == *"NO healthcheck"* ]]
    [[ "$output" != *"app-ui: healthy"* ]]
}

@test "CONTROL: the stub can express both outcomes, so the cases are not fixed" {
    # Guards against a stub that always says the same thing, which would make the
    # healthy and unhealthy cases agree for the wrong reason.
    HEALTH_MAP="app-ui:healthy"; write_docker_stub; run_verify ui
    local ok="$status"
    HEALTH_MAP="app-ui:unhealthy"; write_docker_stub; run_verify ui
    [ "$ok" -eq 0 ]
    [ "$status" -ne 0 ]
}
