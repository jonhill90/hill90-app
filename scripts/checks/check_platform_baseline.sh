#!/usr/bin/env bash
#
# Is every Hill90 PLATFORM container still present, BY NAME?
#
# WHY THIS EXISTS. The deploy step that claimed to check this ran only
#
#     docker ps --filter health=unhealthy
#
# and passed when nothing was unhealthy. A container that has VANISHED is not
# unhealthy — it is absent, and absence is precisely what a baseline check exists
# to catch. The step's name asserted a strictly stronger claim than its evidence,
# and that verdict was relayed as a baseline check for a whole session before
# anyone read the step.
#
# Absence and ill-health are different questions. This answers the first; the
# unhealthy sweep still answers the second, under a name that says so.
#
# USAGE: the actual container names arrive on stdin, one per line, from
#   docker ps --format '{{.Names}}'
#
#   docker ps --format '{{.Names}}' | bash check_platform_baseline.sh [list-file]
#
# EXIT 0 every expected name is present
#      1 at least one is missing — named
#      2 nothing arrived on stdin, so nothing was compared. NOT a pass: a check
#        that cannot see must never report agreement, which is the rule this
#        estate has re-learned in five other places.
set -uo pipefail

LIST="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hill90-platform-baseline.txt}"

if [ ! -f "$LIST" ]; then
    printf '::error::baseline list not found: %s\n' "$LIST" >&2
    exit 2
fi

expected=$(grep -vE '^\s*(#|$)' "$LIST" || true)
if [ -z "$expected" ]; then
    printf '::error::baseline list %s contains no names — refusing to pass vacuously\n' "$LIST" >&2
    exit 2
fi

actual=$(cat)
if [ -z "${actual//[[:space:]]/}" ]; then
    printf '::error::no container names were supplied, so NOTHING WAS COMPARED. This is not a pass.\n' >&2
    exit 2
fi

missing=()
while IFS= read -r name; do
    [ -n "$name" ] || continue
    # -F -x: exact whole-line match. Substring matching would report
    # blackbox-exporter as satisfying "blackbox", and a genuinely missing
    # container as present.
    if ! printf '%s\n' "$actual" | grep -Fxq "$name"; then
        missing+=("$name")
    fi
done <<< "$expected"

n_expected=$(printf '%s\n' "$expected" | grep -c .)

if [ ${#missing[@]} -gt 0 ]; then
    printf '::error::HILL90 PLATFORM CONTAINER MISSING: %d of %d expected containers are not running: %s\n' \
        "${#missing[@]}" "$n_expected" "${missing[*]}" >&2
    printf '  This tenant consumes the platform. A missing platform container is not this deploy\n' >&2
    printf '  failing — it is the ground under it moving. Check the host before deploying again.\n' >&2
    printf '  If the platform legitimately renamed or removed one, this list is stale: %s\n' "$LIST" >&2
    exit 1
fi

printf 'All %d Hill90 platform containers present by name.\n' "$n_expected"
