#!/usr/bin/env bash
#
# Prove that each lint arm can actually FAIL.
#
# WHY THIS EXISTS. On 2026-07-31 all three lint entry points in this repo were
# broken and ci.yml invoked lint zero times. They were repaired in #95 — and the
# ui repair was itself defective: eslint-config-next does not include
# eslint:recommended, so the resolved ui config had 113 rules with `no-debugger`
# NOT CONFIGURED, and a deliberate `debugger;` statement linted clean. A lint job
# that runs, exits 0, and catches nothing is indistinguishable from coverage.
#
# That defect was found by injecting a violation BY HAND. It survived #95 because
# the check was a one-off and the pull request merged before it ran. This script
# is that check made repeatable, so the next person editing eslint.config.mjs or
# the ci.yml lint job cannot reintroduce the gap silently.
#
# THE IMPORTANT DESIGN DECISION: a non-zero exit is NOT accepted as proof.
#
# If node_modules were missing, or a config file had a syntax error, or the
# poetry venv were absent, the lint command would also exit non-zero — and a
# naive selftest would call that "the violation was caught" and pass while the
# arm was dead. So each arm must exit non-zero AND its output must name the rule
# that was supposed to fire. That is the difference between "it failed" and "it
# failed for the reason I injected".
#
# Cleanup runs on EXIT, so an interrupted or failing run does not leave injected
# files behind.

set -uo pipefail   # deliberately not -e: non-zero exits are the thing under test

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

# arm|relative file to inject|file content|working dir|command|rule that must appear
ARMS=(
  "api|services/api/src/__lint_selftest__.ts|export function selftest(): void {\n  debugger;\n}|services/api|npm run lint|no-debugger"
  "ui|services/ui/src/__lint_selftest__.ts|export function selftest(): void {\n  debugger;\n}|services/ui|npm run lint|no-debugger"
  # Injected into the LAST service the CI loop visits, so this also proves the
  # loop reaches the end rather than stopping at the first service. An earlier
  # version of that loop exited on the first failure, which is why a report once
  # said the Python problem was one finding when it was 53.
  "python|services/knowledge/__lint_selftest__.py|import os|services/knowledge|poetry run ruff check .|F401"
)

INJECTED=()

cleanup() {
  local f
  for f in "${INJECTED[@]:-}"; do
    [ -n "$f" ] && rm -f "$REPO_ROOT/$f"
  done
}
trap cleanup EXIT INT TERM

only="${1:-}"
failures=0
ran=0

for spec in "${ARMS[@]}"; do
  IFS='|' read -r arm file content dir cmd rule <<<"$spec"

  if [ -n "$only" ] && [ "$only" != "$arm" ]; then
    continue
  fi
  ran=$((ran + 1))

  printf '%s== %s%s  (%s, expecting %s)\n' "$BOLD" "$arm" "$OFF" "$cmd" "$rule"

  # Never clobber something real.
  if [ -e "$file" ]; then
    printf '  %sFAIL%s  %s already exists; refusing to overwrite it\n' "$RED" "$OFF" "$file"
    failures=$((failures + 1))
    continue
  fi

  printf '%b\n' "$content" > "$file"
  INJECTED+=("$file")

  out="$(cd "$dir" && eval "$cmd" 2>&1)"
  status=$?

  rm -f "$file"

  if [ "$status" -eq 0 ]; then
    printf '  %sFAIL%s  the arm exited 0 — it did not notice the injected violation\n' "$RED" "$OFF"
    printf '        this is the gap that shipped in #95: lint runs, passes, catches nothing\n'
    failures=$((failures + 1))
  elif ! grep -q -- "$rule" <<<"$out"; then
    printf '  %sFAIL%s  exited %d but never mentioned %s\n' "$RED" "$OFF" "$status" "$rule"
    printf '        non-zero for some OTHER reason — missing deps, broken config — which\n'
    printf '        would let a dead arm masquerade as a working one. Output tail:\n'
    printf '%s\n' "$out" | tail -12 | sed 's/^/          /'
    failures=$((failures + 1))
  else
    printf '  %sPASS%s  exited %d and reported %s\n' "$GREEN" "$OFF" "$status" "$rule"
  fi
done

echo
if [ "$ran" -eq 0 ]; then
  printf '%sNo arm matched %s.%s Valid arms: api ui python\n' "$YELLOW" "$only" "$OFF"
  exit 2
fi
if [ "$failures" -gt 0 ]; then
  printf '%s%d of %d lint arm(s) cannot fail.%s A lint that cannot fail is not a guard.\n' \
    "$RED" "$failures" "$ran" "$OFF"
  exit 1
fi
printf '%sall %d lint arm(s) provably catch a violation%s\n' "$GREEN" "$ran" "$OFF"
