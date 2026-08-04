#!/usr/bin/env bats
#
# A guard that cannot fail is not a guard. These tests check both directions:
# that the current tree passes, AND that removing a limit makes it fail. The
# second is the one that matters — this repo has found several checks that
# matched nothing and looked exactly like health.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  CHECK="${REPO_ROOT}/tests/scripts/compose-mem-limits-check.sh"
  PROD_DIR="${REPO_ROOT}/deploy/compose/prod"
}

@test "every deployed prod service declares a mem_limit" {
  run "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"COMPOSE_MEM_LIMITS_OK"* ]]
}

@test "the check inspects a non-trivial number of services" {
  # Guards against the check passing because it parsed nothing. It reported
  # OK on zero stacks during development, when a BSD/GNU sed difference made
  # the stack list parse empty on macOS but not in CI.
  run "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ([0-9]+)\ services ]]
  [ "${BASH_REMATCH[1]}" -ge 5 ]
}

@test "the check FAILS when a service loses its mem_limit" {
  target="${PROD_DIR}/docker-compose.ui.yml"
  stash="${BATS_TEST_TMPDIR}/ui.yml"
  cp "$target" "$stash"

  # Remove only the ui service's limit, leaving the file otherwise intact.
  grep -v '^    mem_limit: 512m$' "$stash" > "$target"

  run "$CHECK"
  cp "$stash" "$target"

  [ "$status" -ne 0 ]
  [[ "$output" == *"MISSING mem_limit"* ]]
  [[ "$output" == *"ui"* ]]
}

@test "the check FAILS rather than passing when deploy.sh lists a missing file" {
  # The stack list is read from deploy.sh, so a stack named there with no
  # compose file must be an error — not a silently skipped entry.
  fake="${BATS_TEST_TMPDIR}/deploy.sh"
  printf 'DEPLOY_FIRST="ui"\nDEPLOY_REST="api nonexistent-stack"\n' > "$fake"

  cp "${REPO_ROOT}/scripts/deploy.sh" "${BATS_TEST_TMPDIR}/deploy.sh.real"
  cp "$fake" "${REPO_ROOT}/scripts/deploy.sh"

  run "$CHECK"
  cp "${BATS_TEST_TMPDIR}/deploy.sh.real" "${REPO_ROOT}/scripts/deploy.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"does not exist"* ]]
}

@test "the node services cap the V8 heap below the container limit" {
  # A mem_limit alone makes a leak WORSE: V8 sizes its heap from host memory
  # and ignores the cgroup, so the kernel kills the container instead of the
  # collector working harder. Both node services were measured reporting a
  # 2096 MiB heap ceiling on a 7.75 GiB machine before this flag existed.
  for f in api ui; do
    run grep -c -- '--max-old-space-size=320' "${PROD_DIR}/docker-compose.${f}.yml"
    [ "$status" -eq 0 ]
    [ "$output" -ge 1 ]
  done
}

@test "the api heap flag does not clobber the tracing NODE_OPTIONS" {
  # services/api/Dockerfile sets NODE_OPTIONS="--require ./dist/tracing.js".
  # Setting NODE_OPTIONS in compose REPLACES it and silently disables tracing,
  # which is why the flag goes on `command` instead. Verified by running the
  # image both ways; this asserts the shape that keeps it true.
  run grep -E '^\s+- NODE_OPTIONS' "${PROD_DIR}/docker-compose.api.yml"
  [ "$status" -ne 0 ]
}
