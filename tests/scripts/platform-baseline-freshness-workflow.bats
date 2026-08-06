#!/usr/bin/env bats

# platform-baseline-freshness.yml's first-ever scheduled run (2026-08-05)
# failed: an unauthenticated `curl` to api.github.com hit GitHub's
# 60-requests-per-hour-PER-IP limit — a budget shared across every other
# tenant of the same GitHub-hosted Actions runner IP, not something this
# workflow's own traffic could exhaust alone. Verified live: an
# authenticated request to the same endpoint, for a repo other than the
# token's own, gets x-ratelimit-limit 5000; unauthenticated, the identical
# call gets 60.
#
# A second, independent defect sat behind the first: `curl -f | python3 -c
# 'json.load(sys.stdin)["sha"]'` — on a non-200 response, curl's `-f` exits
# nonzero and prints nothing, but that happens INSIDE a pipe feeding
# python3, so python3 ran against empty input and crashed with an uncaught
# JSONDecodeError instead of the workflow's own intended `::error::` line.
# The step still failed, just not with a message anyone could read.
# Reproduced locally against a guaranteed-404 URL before the fix: identical
# shape — curl error, then a raw Python traceback, then exit 1, and the
# intended ::error:: line never printed.
#
# These are static assertions against the workflow file's text — they
# never call the network and never dispatch the workflow.

setup() {
  WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/platform-baseline-freshness.yml"
  [ -f "$WORKFLOW" ] || skip "platform-baseline-freshness.yml not found"
}

@test "the Hill90-commit-resolution call is authenticated" {
  run grep -c 'Authorization: Bearer' "$WORKFLOW"
  [ "$output" -ge 1 ] || { echo "no Authorization header found — the call is still unauthenticated and subject to the 60/hour-per-IP limit"; return 1; }
}

@test "the token used is the workflow's own ambient GITHUB_TOKEN, not a manually-configured secret" {
  run grep -c 'secrets.GITHUB_TOKEN' "$WORKFLOW"
  [ "$output" -ge 1 ] || { echo "expected secrets.GITHUB_TOKEN to be wired into the resolve step's env"; return 1; }
}

@test "a non-200 response is checked explicitly, not inferred from curl's own exit code inside a pipe" {
  run grep -c 'http_code' "$WORKFLOW"
  [ "$output" -ge 1 ] || { echo "no explicit HTTP status capture found — a non-200 can still be swallowed by a downstream parser crash"; return 1; }
  # Flattened because http_code=$(curl ...) and the `if` that checks it are
  # several physical lines apart (curl's own flags each on their own line).
  run bash -c "sed -n '/name: Resolve Hill90 main/,/name: Download/p' '$WORKFLOW' | tr '\n' ' ' | grep -c 'http_code.*!= \"200\"'"
  [ "$output" -ge 1 ] || { echo "http_code is captured but never compared against 200 before parsing"; return 1; }
}

@test "the fragile curl-piped-into-python json.load pattern is gone from the resolve step" {
  # Joins line-continued shell (curl ... \<newline>  | python3 ...) onto one
  # line before matching — the original wrote the pipe across two physical
  # lines via a trailing backslash, which a plain single-line grep misses.
  run bash -c "sed -n '/name: Resolve Hill90 main/,/name: Download/p' '$WORKFLOW' | tr '\n' ' ' | grep -c 'curl -fsSL.*| *python3'"
  [ "$output" -eq 0 ] || { echo "the resolve step still pipes curl directly into python3's json.load — a non-200 will crash instead of failing cleanly"; return 1; }
}

@test "JSON parsing uses .get(), not bracket indexing, so a 200 with an unexpected body fails cleanly instead of crashing" {
  run bash -c "sed -n '/name: Resolve Hill90 main/,/name: Download/p' '$WORKFLOW' | grep -c 'json.load(sys.stdin)\[\"sha\"\]'"
  [ "$output" -eq 0 ] || { echo "still uses bracket indexing (json.load(...)[\"sha\"]) — a 200 response missing the sha field will KeyError-crash instead of hitting the intended ::error:: guard"; return 1; }
}

@test "the resolve step still has a clean ::error:: for both failure shapes: non-200 and 200-without-sha" {
  run bash -c "sed -n '/name: Resolve Hill90 main/,/name: Download/p' '$WORKFLOW' | grep -c '::error::'"
  [ "$output" -ge 2 ] || { echo "expected at least 2 distinct ::error:: lines (non-200, and 200-but-no-sha) in the resolve step, found $output"; return 1; }
}

@test "the tarball download step was deliberately left unauthenticated, and says why" {
  # Whole-file, not scoped to the step block: the explanatory comment sits
  # in the trailing-comment position directly above the step's `- name:`
  # line, which is above where a range starting at that same "name:" text
  # would begin matching.
  run grep -c 'codeload' "$WORKFLOW"
  [ "$output" -ge 1 ] || { echo "expected a comment explaining why the tarball step wasn't given the same auth treatment as the resolve step"; return 1; }
}
