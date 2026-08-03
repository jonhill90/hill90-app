#!/usr/bin/env bats

# The baseline check must catch a container that has VANISHED.
#
# The step it replaces ran `docker ps --filter health=unhealthy` and passed when
# nothing was unhealthy — but an absent container is not unhealthy, it is gone.
# The step's name claimed the stronger property and its verdict was relayed as a
# baseline check for a whole session.
#
# These tests are mostly about what the check must NOT do: pass when it cannot
# see, and pass on a substring.

setup() {
    CHECK="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/check_platform_baseline.sh"
    LIST="$BATS_TEST_TMPDIR/list.txt"
    printf '# a comment\n\ntraefik\nblackbox-exporter\nnode-exporter\n' > "$LIST"
}

@test "passes when every expected name is present" {
    run bash -c "printf 'traefik\nblackbox-exporter\nnode-exporter\napp-api\n' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 0 ]
    [[ "$output" == *"All 3"* ]]
}

@test "FIRES: a container that has vanished is named" {
    run bash -c "printf 'traefik\nnode-exporter\n' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 1 ]
    [[ "$output" == *"MISSING"* ]]
    [[ "$output" == *"blackbox-exporter"* ]]
}

@test "FIRES: this is the case the health filter could not see — present but absent, not unhealthy" {
    # Nothing here is unhealthy. Everything here is simply gone except traefik.
    run bash -c "printf 'traefik\n' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 1 ]
    [[ "$output" == *"blackbox-exporter"* ]]
    [[ "$output" == *"node-exporter"* ]]
}

@test "EXACT MATCH: 'blackbox' does not satisfy 'blackbox-exporter'" {
    # A substring implementation would call this a pass. The container named
    # blackbox-exporter is genuinely not running.
    run bash -c "printf 'traefik\nblackbox\nnode-exporter\n' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 1 ]
    [[ "$output" == *"blackbox-exporter"* ]]
}

@test "EXACT MATCH: a longer name does not satisfy a shorter expectation either" {
    printf 'blackbox\n' > "$LIST"
    run bash -c "printf 'blackbox-exporter\n' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 1 ]
    [[ "$output" == *"blackbox"* ]]
}

@test "extra containers are not a failure — the tenant's own run alongside" {
    run bash -c "printf 'traefik\nblackbox-exporter\nnode-exporter\napp-api\napp-ui\n' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 0 ]
}

@test "NEVER A PASS: empty stdin exits 2, because nothing was compared" {
    run bash -c "printf '' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 2 ]
    [[ "$output" == *"NOTHING WAS COMPARED"* ]]
}

@test "NEVER A PASS: whitespace-only stdin exits 2 as well" {
    run bash -c "printf '  \n \n' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 2 ]
}

@test "NEVER A PASS: an empty list file exits 2 rather than passing vacuously" {
    printf '# only comments\n\n' > "$LIST"
    run bash -c "printf 'traefik\n' | bash '$CHECK' '$LIST'"
    [ "$status" -eq 2 ]
}

@test "a missing list file exits 2" {
    run bash -c "printf 'traefik\n' | bash '$CHECK' '$BATS_TEST_TMPDIR/nope.txt'"
    [ "$status" -eq 2 ]
}

@test "the shipped list is the 16 the estate records, and is comment-documented" {
    real="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/hill90-platform-baseline.txt"
    [ -f "$real" ]
    n=$(grep -vcE '^\s*(#|$)' "$real")
    [ "$n" -eq 16 ]
    # The duplication must be stated in the file, or the next reader will treat
    # it as authoritative.
    grep -q "DUPLICATE" "$real"
    grep -q "WILL DRIFT" "$real"
}

@test "the shipped list CONTAINS a prefix pair, and the check is not fooled by it" {
    # This started as an assertion that no name is a prefix of another. It failed,
    # and the failure is the point: the real list contains `postgres` AND
    # `postgres-exporter`. We do not control the platform's names, so the property
    # to assert is not their shape — it is that the check survives it.
    #
    # With only postgres-exporter running, a substring implementation would report
    # `postgres` as present while the platform's DATABASE is gone. That is the
    # worst available failure of this check, and it is the one the exact match
    # exists to prevent.
    real="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/hill90-platform-baseline.txt"
    names=$(grep -vE '^\s*(#|$)' "$real")

    # The pair is really there — if the platform ever drops one, this test should
    # be revisited rather than silently weakened.
    printf '%s\n' "$names" | grep -Fxq postgres
    printf '%s\n' "$names" | grep -Fxq postgres-exporter

    # Everything present EXCEPT postgres itself.
    actual=$(printf '%s\n' "$names" | grep -Fxv postgres)
    run bash -c "printf '%s\n' '$actual' | bash '$CHECK' '$real'"

    [ "$status" -eq 1 ]
    [[ "$output" == *"postgres"* ]]
}
