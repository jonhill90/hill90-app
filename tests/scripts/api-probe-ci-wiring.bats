#!/usr/bin/env bats

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CI="$ROOT/.github/workflows/ci.yml"
}

@test "api CI enables the 400 and Jest-timeout probes and uploads their workspace artifacts" {
  run bash -c '
    grep -Eq "^[[:space:]]+PROBE_400: .?1.?$" "$1" &&
    grep -Eq "^[[:space:]]+PROBE_TIMEOUT: .?1.?$" "$1" &&
    grep -Fq "path: services/api/test-artifacts/" "$1"
  ' _ "$CI"

  [ "$status" -eq 0 ]
}
