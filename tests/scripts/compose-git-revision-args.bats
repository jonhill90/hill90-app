#!/usr/bin/env bats
#
# app#558: a compose build: block can silently drift from the Dockerfile it
# builds — the Dockerfile keeps accepting ARG GIT_REVISION, the compose file
# stops passing it, and the image comes out labelled "unstamped" while the
# CONTAINER label (set separately) stays correct. Nothing failed loudly; the
# only way this was found was a human clearing drift by hand.
#
# A guard that cannot fail is not a guard — these tests check both
# directions: that the current tree passes, AND that removing the args:
# block makes it fail, on the exact file where this happened.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  CHECK="${REPO_ROOT}/tests/scripts/compose-git-revision-args-check.sh"
  PROD_DIR="${REPO_ROOT}/deploy/compose/prod"
}

@test "every deployed service whose Dockerfile stamps an image gets GIT_REVISION from compose" {
  run "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"COMPOSE_GIT_REVISION_ARGS_OK"* ]]
}

@test "the check inspects at least one Dockerfile that defines the ARG" {
  # Guards against the check passing because it matched nothing — the same
  # vacuous-inspection class compose-mem-limits.bats already guards for its
  # own check.
  run "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ([0-9]+)\ with\ ARG\ GIT_REVISION ]]
  [ "${BASH_REMATCH[1]}" -ge 1 ]
}

@test "the check FAILS when docker-compose.knowledge.yml loses its args: block — the actual app#558 regression" {
  target="${PROD_DIR}/docker-compose.knowledge.yml"
  stash="${BATS_TEST_TMPDIR}/knowledge.yml"
  cp "$target" "$stash"

  # Remove exactly the two lines app#558 found missing, leaving the rest of
  # the build: block (context, dockerfile) intact — the same shape as the
  # real regression, not a deleted file or a malformed one.
  grep -v -e '^\s*args:$' -e 'GIT_REVISION: \${DEPLOY_REVISION:-unstamped}' "$stash" > "$target"

  run "$CHECK"
  cp "$stash" "$target"

  [ "$status" -ne 0 ]
  [[ "$output" == *"MISSING GIT_REVISION build arg"* ]]
  [[ "$output" == *"knowledge"* ]]
}

@test "every deployed service's Dockerfile now defines ARG GIT_REVISION — app#561 closed the gap" {
  # Superseded, kept for the record of what used to be true: api/ai/ui/mcp
  # never defined ARG GIT_REVISION at all, so this file's own comment said
  # passing args: to them would be inert, and a prior version of this test
  # asserted exactly that absence. app#561 gave all four the same three
  # lines knowledge already had (Dockerfile ARG + LABEL, compose args:), so
  # the absence this test used to assert is no longer true and asserting it
  # today would be silently wrong the moment a reader trusted it.
  for svc in api ai ui mcp knowledge; do
    run grep -q '^ARG GIT_REVISION' "${REPO_ROOT}/services/${svc}/Dockerfile"
    [ "$status" -eq 0 ]
  done

  # Every deployed stack now has an ARG to check — the "no Dockerfile to
  # inspect" escape hatch above should never fire for any of the five.
  run "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ([0-9]+)\ deployed\ stacks,\ ([0-9]+)\ with\ ARG\ GIT_REVISION ]]
  [ "${BASH_REMATCH[1]}" -eq "${BASH_REMATCH[2]}" ]
}

@test "the check FAILS rather than passing when deploy.sh lists a missing file" {
  fake="${BATS_TEST_TMPDIR}/deploy.sh"
  printf 'DEPLOY_FIRST="ui"\nDEPLOY_REST="api nonexistent-stack"\n' > "$fake"

  cp "${REPO_ROOT}/scripts/deploy.sh" "${BATS_TEST_TMPDIR}/deploy.sh.real"
  cp "$fake" "${REPO_ROOT}/scripts/deploy.sh"

  run "$CHECK"
  cp "${BATS_TEST_TMPDIR}/deploy.sh.real" "${REPO_ROOT}/scripts/deploy.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"does not exist"* ]]
}
