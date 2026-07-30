#!/usr/bin/env bats

# scripts/local.sh must not treat its OWN published ports as conflicts.
#
# Its comment states the intent plainly: "Ports this stack is already publishing are
# not conflicts — that is just a re-run of `up` against a running stack." The
# implementation did not deliver it. The exclusion was
#
#     docker ps --filter 'name=hill90-' ...
#
# and `--filter name=` is a substring match, so with CONTAINER_PREFIX=hill90dev the
# container names are `hill90dev-app-ui` — which does not contain `hill90-`. The
# exclusion silently matched nothing, every port looked foreign, and `up` against a
# running stack refused with a list of OUR OWN containers named as the holders.
#
# That made `up` non-idempotent: you had to `down` first, every time, which is how the
# local stack ends up rarely exercised.
#
# The compose project label is the prefix-independent way to say "our stack": every
# container the tenant path creates carries com.docker.compose.project=hill90-local
# regardless of what CONTAINER_PREFIX is set to.
#
# `docker` is stubbed, so these run with no daemon and no containers.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  STUB="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"
}

# A docker stub whose `ps` output depends on the filter it is given, so the test can
# tell WHICH filter local.sh used.
write_docker_stub() {
  cat > "${STUB}/docker" <<'SH'
#!/usr/bin/env bash
# Records the arguments it was called with, and answers only a project-label filter.
echo "$*" >> "${DOCKER_CALLS:-/dev/null}"
if [ "$1" = "ps" ]; then
  case "$*" in
    *com.docker.compose.project=hill90-local*)
      # Our stack, named with a prefix that does NOT contain "hill90-".
      echo '0.0.0.0:13000->3000/tcp, 0.0.0.0:13001->3000/tcp' ;;
    *name=hill90-*)
      # The old filter: matches nothing, because names are hill90dev-*.
      : ;;
    *)
      echo 'hill90dev-app-ui	0.0.0.0:13000->3000/tcp' ;;
  esac
fi
SH
  chmod +x "${STUB}/docker"
}

@test "the port exclusion identifies our stack by compose project, not by name prefix" {
  write_docker_stub
  run grep -n "com.docker.compose.project" "${REPO_ROOT}/scripts/local.sh"
  [ "$status" -eq 0 ]
}

@test "the brittle name=hill90- filter is gone" {
  # It matched nothing for any prefix other than the literal `hill90-`.
  run grep -c "filter 'name=hill90-'" "${REPO_ROOT}/scripts/local.sh"
  [ "$output" = "0" ]
}

@test "our own published ports are excluded even when the prefix is not hill90-" {
  write_docker_stub
  export DOCKER_CALLS="${BATS_TEST_TMPDIR}/calls"
  # Drive just the exclusion, the way local.sh computes it.
  run bash -c "
    source '${REPO_ROOT}/scripts/local.sh' --source-only 2>/dev/null || true
    ours_ports 'hill90-local'
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"13000"* ]]
  [[ "$output" == *"13001"* ]]
}

@test "local.sh can be sourced without running a command" {
  # Needed so the helper is testable at all. Sourcing used to fall through to the
  # dispatch and run `up`.
  run bash -c "source '${REPO_ROOT}/scripts/local.sh' --source-only && echo SOURCED_CLEAN"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SOURCED_CLEAN"* ]]
}
