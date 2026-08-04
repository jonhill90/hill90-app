#!/usr/bin/env bats
#
# POSITIVE CONTROL for scripts/checks/check_platform_baseline_freshness.py.
#
# A comparison that has only ever seen agreement has not been shown to
# notice disagreement — the same standard applied to
# hill90-ui-secret-agreement-control.bats on the Hill90 side today. Every
# fixture here is a scratch compose file, fabricated for this test. Nothing
# touches the network and nothing reads the real hill90-platform-baseline.txt
# for the drift cases — a real snapshot changing size over time must not be
# able to break this control.

CHECK=""
FIXTURES=""

setup() {
    CHECK="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/check_platform_baseline_freshness.py"
    FIXTURES="$BATS_TEST_TMPDIR"
}

# A minimal, real-shaped compose file: three ordinary services and one
# one-shot (restart: "no") that must be excluded, exactly like openbao-init.
write_compose() {
    local path="$1"; shift
    {
        echo "services:"
        for name in "$@"; do
            echo "  svc-${name}:"
            echo "    image: whatever:latest"
            echo "    container_name: \${CONTAINER_PREFIX:-}${name}"
            echo "    restart: unless-stopped"
        done
        echo "  svc-oneshot:"
        echo "    image: whatever:latest"
        echo "    container_name: \${CONTAINER_PREFIX:-}oneshot-init"
        echo "    restart: \"no\""
    } > "$path"
}

write_local_list() {
    local path="$1"; shift
    : > "$path"
    for name in "$@"; do
        echo "$name" >> "$path"
    done
}

@test "AGREE: identical sets, one-shot container correctly excluded from the platform side" {
    write_local_list "$FIXTURES/local.txt" alpha beta gamma
    write_compose "$FIXTURES/compose.yml" alpha beta gamma
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 0 ]
    [[ "$output" == *"AGREE"* ]]
    # oneshot-init must not be silently expected of the platform.
    [[ "$output" != *"oneshot"* ]]
}

@test "FIRES: platform gained a container our copy does not have — named, in that direction" {
    write_local_list "$FIXTURES/local.txt" alpha beta
    write_compose "$FIXTURES/compose.yml" alpha beta gamma
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 1 ]
    [[ "$output" == *"IN HILL90'S COMPOSE, NOT IN OUR COPY"* ]]
    [[ "$output" == *"gamma"* ]]
    [[ "$output" == *"ADD to hill90-platform-baseline.txt"* ]]
    # The other direction must NOT fire — this fixture has no orphaned local entry.
    [[ "$output" != *"IN OUR COPY, NOT IN HILL90'S COMPOSE"* ]]
}

@test "FIRES: our copy holds a container the platform no longer declares — named, in the OTHER direction" {
    write_local_list "$FIXTURES/local.txt" alpha beta gamma
    write_compose "$FIXTURES/compose.yml" alpha beta
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 1 ]
    [[ "$output" == *"IN OUR COPY, NOT IN HILL90'S COMPOSE"* ]]
    [[ "$output" == *"gamma"* ]]
    [[ "$output" == *"REMOVE from hill90-platform-baseline.txt"* ]]
    [[ "$output" != *"IN HILL90'S COMPOSE, NOT IN OUR COPY"* ]]
}

@test "FIRES: both directions at once are both named, not just the first found" {
    write_local_list "$FIXTURES/local.txt" alpha beta
    write_compose "$FIXTURES/compose.yml" alpha gamma
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 1 ]
    [[ "$output" == *"beta"* ]]
    [[ "$output" == *"gamma"* ]]
    [[ "$output" == *"IN OUR COPY, NOT IN HILL90'S COMPOSE"* ]]
    [[ "$output" == *"IN HILL90'S COMPOSE, NOT IN OUR COPY"* ]]
}

@test "the CONTAINER_PREFIX interpolation is stripped, not compared literally" {
    write_local_list "$FIXTURES/local.txt" postgres
    write_compose "$FIXTURES/compose.yml" postgres
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 0 ]
}

@test "a prefix pair is matched exactly — postgres does not satisfy postgres-exporter" {
    write_local_list "$FIXTURES/local.txt" postgres postgres-exporter
    write_compose "$FIXTURES/compose.yml" postgres
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 1 ]
    [[ "$output" == *"postgres-exporter"* ]]
}

# ------------------------------------------------------- CANNOT DETERMINE ---

@test "CANNOT DETERMINE: no compose files supplied exits 2, not 0" {
    write_local_list "$FIXTURES/local.txt" alpha
    run python3 "$CHECK" "$FIXTURES/local.txt"
    [ "$status" -eq 2 ]
}

@test "CANNOT DETERMINE: an unreadable compose file exits 2 — a fetch failure must not read as agreement" {
    write_local_list "$FIXTURES/local.txt" alpha
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/does-not-exist.yml"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CANNOT DETERMINE"* ]]
    [[ "$output" != *"AGREE"* ]]
}

@test "CANNOT DETERMINE: a compose file that parses but has no container_name entries exits 2" {
    write_local_list "$FIXTURES/local.txt" alpha
    echo "services: {}" > "$FIXTURES/empty.yml"
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/empty.yml"
    [ "$status" -eq 2 ]
    [[ "$output" == *"zero container_name entries"* ]]
}

@test "CANNOT DETERMINE: a missing local list exits 2" {
    run python3 "$CHECK" "$FIXTURES/no-such-list.txt" "$FIXTURES/whatever.yml"
    [ "$status" -eq 2 ]
}

@test "CANNOT DETERMINE: an empty local list exits 2 rather than passing vacuously" {
    : > "$FIXTURES/local.txt"
    write_compose "$FIXTURES/compose.yml" alpha
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 2 ]
}

@test "malformed YAML in one file does not abort the others — partial read still compares" {
    write_local_list "$FIXTURES/local.txt" alpha beta
    write_compose "$FIXTURES/good.yml" alpha beta
    printf ': not: valid: yaml: [' > "$FIXTURES/bad.yml"
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/good.yml" "$FIXTURES/bad.yml"
    [ "$status" -eq 0 ]
    [[ "$output" == *"1/2"* ]]
}

@test "CONTROL: exit codes are three genuinely distinct states" {
    write_local_list "$FIXTURES/local.txt" alpha
    write_compose "$FIXTURES/agree.yml" alpha
    write_compose "$FIXTURES/differ.yml" beta

    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/agree.yml"
    agree_status="$status"
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/differ.yml"
    differ_status="$status"
    run python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/does-not-exist.yml"
    unknown_status="$status"

    [ "$agree_status" -eq 0 ]
    [ "$differ_status" -eq 1 ]
    [ "$unknown_status" -eq 2 ]
}

@test "the pinned commit is reported when the caller supplies one" {
    write_local_list "$FIXTURES/local.txt" alpha
    write_compose "$FIXTURES/compose.yml" alpha
    run env HILL90_SHA=deadbeefcafe python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 0 ]
    [[ "$output" == *"deadbeefcafe"* ]]
}

@test "an unpinned run says so plainly rather than silently omitting the line" {
    write_local_list "$FIXTURES/local.txt" alpha
    write_compose "$FIXTURES/compose.yml" alpha
    run env -u HILL90_SHA python3 "$CHECK" "$FIXTURES/local.txt" "$FIXTURES/compose.yml"
    [ "$status" -eq 0 ]
    [[ "$output" == *"not supplied — caller did not pin a commit"* ]]
}

@test "the real shipped list agrees with a REAL Hill90 compose fixture shape" {
    # Not a network test — a fixture built to match the real file's shape
    # (six services, one one-shot), so a change to the fixture-building logic
    # above is itself exercised against something resembling production.
    write_compose "$FIXTURES/compose.yml" \
        alertmanager blackbox-exporter cadvisor grafana keycloak loki minio \
        node-exporter openbao portainer postgres postgres-exporter prometheus \
        promtail tempo traefik
    run python3 "$CHECK" \
        "$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/hill90-platform-baseline.txt" \
        "$FIXTURES/compose.yml"
    [ "$status" -eq 0 ]
}
