#!/usr/bin/env bash
# Flake harness: run a pinned file list N times, record pass/fail and the failing test.
#
#   ./flake-harness.sh <label> <n> <listfile> [extra jest args...]
#
# Writes /tmp/flake-<label>.tsv with one row per run:
#   run <TAB> result <TAB> failing-suite <TAB> symptom
#
# Deliberately does NOT retry, skip or quarantine anything. The point is to
# measure the rate, not to make it green.
set -uo pipefail

label="$1"; n="$2"; list="$3"; shift 3
out="/tmp/flake-${label}.tsv"
: > "$out"

files=$(tr '\n' ' ' < "$list")
fails=0

for i in $(seq 1 "$n"); do
  log="/tmp/flake-${label}-run${i}.log"
  npx jest --runTestsByPath $files "$@" > "$log" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%d\tPASS\t\t\n' "$i" >> "$out"
  else
    fails=$((fails + 1))
    suite=$(grep -m1 -E "^(FAIL|●)" "$log" | sed -E 's/^FAIL +//' | head -c 80)
    # Classify: timeout vs status-code mismatch vs other
    if grep -q "Exceeded timeout of" "$log"; then
      sym="TIMEOUT"
    elif grep -qE "Expected: *[0-9]{3}" "$log"; then
      exp=$(grep -m1 -E "Expected: *[0-9]{3}" "$log" | grep -oE "[0-9]{3}")
      got=$(grep -m1 -E "Received: *[0-9]{3}" "$log" | grep -oE "[0-9]{3}")
      sym="STATUS ${exp}->${got}"
    else
      sym="OTHER"
    fi
    printf '%d\tFAIL\t%s\t%s\n' "$i" "$suite" "$sym" >> "$out"
  fi
  printf '.' >&2
done
echo >&2
echo "${label}: ${fails}/${n} failed  ($(python3 -c "print(f'{100*$fails/$n:.1f}')")%)"
