#!/usr/bin/env bats

# smoke-auth.yml's job name ("Auth theme smoke tests") and its only trigger
# besides workflow_dispatch (repository_dispatch on deploy-auth-success) both
# say this workflow gates the auth theme specifically. But the step runs a
# bare `npx playwright test`, and tests/e2e/playwright.config.ts defines
# three projects — smoke, auth, app — so a bare invocation runs all ten spec
# files, not the one the name and trigger promise. Eight of those ten are the
# authenticated, production-writing specs app#514 is about (upload-and-delete,
# create workflow, start agent); this job has never been wired to skip them.
#
# Separately, the job declares no timeout-minutes, so a hang inherits
# GitHub's 6-hour default. A dispatched run was observed stuck in the test
# step for 20+ minutes with nothing to catch it.
#
# Static assertions against the workflow file only. Never dispatches the
# workflow, never touches tests/e2e/*.spec.ts — that tree is owned by a
# concurrent lane sharing this working tree.

setup() {
  WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/smoke-auth.yml"
  [ -f "$WORKFLOW" ] || skip "smoke-auth.yml not found"
}

@test "the test step selects the auth project explicitly, not a bare invocation of all three" {
  run grep -n 'npx playwright test' "$WORKFLOW"
  [ "$status" -eq 0 ] || { echo "no playwright invocation found in $WORKFLOW"; return 1; }
  [[ "$output" == *'--project=auth'* ]] || { echo "playwright invocation does not select --project=auth, so it runs every project including the eight production-writing app# specs: $output"; return 1; }
}

@test "the job declares timeout-minutes, so a hang cannot inherit GitHub's 6-hour default" {
  run grep -c 'timeout-minutes:' "$WORKFLOW"
  [ "$output" -ge 1 ] || { echo "no timeout-minutes anywhere in $WORKFLOW — a hung run would inherit the 6-hour default"; return 1; }
}

@test "the declared timeout is a tight ceiling — minutes, not hours, and not so tight it clips a real pass" {
  value=$(grep 'timeout-minutes:' "$WORKFLOW" | head -1 | grep -oE '[0-9]+')
  [ -n "$value" ] || { echo "timeout-minutes present but no integer value found"; return 1; }
  [ "$value" -le 15 ] || { echo "timeout-minutes is $value — too loose to surface a hang within single-digit minutes"; return 1; }
  [ "$value" -ge 3 ] || { echo "timeout-minutes is $value — too tight to survive a real chromium install plus 9 auth-theme assertions"; return 1; }
}
