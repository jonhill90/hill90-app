#!/usr/bin/env bash
#
# Is what is RUNNING the same as what was MERGED?
#
# WHY THIS EXISTS. On 2026-08-03 a fix for an anonymous information leak
# (#136) was merged at 18:07 and did not reach production until 18:30. In
# between, two defects in the deploy path (#137, #139) each failed the deploy,
# and nothing anywhere said the fix was not running. It could not have: every
# health check answers from the running container, so they all reported the OLD
# code as healthy — correctly. `hill90.com` was up. `api.hill90.com/health`
# returned 200. The platform's PublicSiteDown and TenantApiDown were both quiet
# and both right.
#
# The only reason it surfaced is that a human curled one specific endpoint from
# outside, repeatedly. That is luck, not a control. This is the control.
#
# WHY NOT SIMPLY `deployed != main`. Because in this repository drift is the
# NORMAL state, measured before writing this: 32 commits landed on main in 24
# hours against 7 deploys. Deploys are workflow_dispatch by design (invariant 7:
# a merge must not deploy). An alarm on any difference would be red permanently
# and ignored inside a day, which is worse than no alarm — it teaches people the
# red is meaningless.
#
# So it alarms on the difference that can actually hurt:
#
#   1. undeployed commits touching DEPLOYABLE paths — a docs commit that has
#      not shipped is not an outage, a services/ commit that has not shipped
#      may be one;
#   2. that have been waiting longer than a grace window — a deploy takes
#      minutes and nobody deploys on every merge, so recent drift is expected;
#   3. or ANY commit on the host that is not on main — that direction is never
#      normal. It means someone edited production, and `git reset --hard` is
#      about to destroy it.
#
# THE THIRD EXIT CODE IS THE POINT. If the deployed SHA cannot be determined,
# this exits 2 and says so. It does not pass. An assertion that succeeds on
# absence is the failure mode this estate has hit five times, most recently in
# `vault.sh assert-unsealed` — a check that cannot see the thing is not evidence
# the thing is fine.
#
# This runs on the RUNNER, against this repository's checkout, and is given the
# host's SHA as an input. It deliberately does NOT run from the host's copy:
# that is the bootstrap deadlock of #139, where the guard is read from the very
# checkout it is meant to be judging.
#
# Usage:
#   DEPLOYED_SHA=<sha> bash scripts/checks/check_deploy_drift.sh
#
# Exit codes:
#   0  no actionable drift  (in sync, docs-only, or inside the grace window)
#   1  ACTIONABLE DRIFT     (deployable code merged and not running, or host ahead)
#   2  CANNOT DETERMINE     (no usable deployed SHA — never silent, never green)

set -uo pipefail

DEPLOYED_SHA="${DEPLOYED_SHA:-}"
TARGET_REF="${TARGET_REF:-origin/main}"
GRACE_HOURS="${GRACE_HOURS:-4}"
LABEL="${LABEL:-hill90-app}"

# Paths whose content is actually shipped to the host and executed there.
# .github/workflows is deliberately ABSENT: since #139 the deploy path runs the
# runner's copy of what matters, so a workflow change is live the moment it is
# merged and can never be "undeployed".
DEPLOYABLE_PREFIXES="${DEPLOYABLE_PREFIXES:-services/ deploy/compose/ platform/ scripts/ infra/secrets/}"

say()  { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; }

say "Deploy drift — ${LABEL}"
say "=============================================="

# ---------------------------------------------------------------- unknown ---
if [ -z "$DEPLOYED_SHA" ]; then
    fail "DEPLOY DRIFT UNKNOWN for ${LABEL}: no deployed SHA was supplied. This is NOT a pass — nothing was compared. Whatever is running on the host is unverified."
    exit 2
fi

if ! git rev-parse --verify --quiet "${DEPLOYED_SHA}^{commit}" >/dev/null; then
    fail "DEPLOY DRIFT UNKNOWN for ${LABEL}: deployed SHA '${DEPLOYED_SHA}' is not a commit in this repository. The host may be on a branch that was force-pushed or deleted. Nothing was compared."
    exit 2
fi

if ! git rev-parse --verify --quiet "${TARGET_REF}^{commit}" >/dev/null; then
    fail "DEPLOY DRIFT UNKNOWN for ${LABEL}: '${TARGET_REF}' does not resolve. Fetch before running this."
    exit 2
fi

target_sha=$(git rev-parse "$TARGET_REF")
deployed_sha=$(git rev-parse "$DEPLOYED_SHA")

say "  deployed: ${deployed_sha:0:12}"
say "  ${TARGET_REF}: ${target_sha:0:12}"
say ""

# ------------------------------------------------------------- host ahead ---
# Never normal, in either repository. Commits that exist only on the host are
# undeployable by definition and `git reset --hard` destroys them silently.
ahead=$(git rev-list --count "${target_sha}..${deployed_sha}" 2>/dev/null || echo 0)
if [ "$ahead" -gt 0 ]; then
    fail "HOST AHEAD of ${TARGET_REF} for ${LABEL}: ${ahead} commit(s) exist on the deployed host and nowhere else. The next deploy's git reset --hard will destroy them."
    git --no-pager log --oneline -n 20 "${target_sha}..${deployed_sha}" | sed 's/^/    /'
    exit 1
fi

# ---------------------------------------------------------------- in sync ---
if [ "$deployed_sha" = "$target_sha" ]; then
    say "  PASS: what is running is what was merged."
    exit 0
fi

behind=$(git rev-list --count "${deployed_sha}..${target_sha}")
say "  ${behind} commit(s) merged and not deployed."

# --------------------------------------------------- deployable or not? ----
# shellcheck disable=SC2086
mapfile -t deployable < <(
    git rev-list "${deployed_sha}..${target_sha}" | while read -r sha; do
        files=$(git show --name-only --format="" "$sha")
        for prefix in $DEPLOYABLE_PREFIXES; do
            if printf '%s\n' "$files" | grep -q "^${prefix}"; then
                printf '%s\n' "$sha"
                break
            fi
        done
    done
)

if [ "${#deployable[@]}" -eq 0 ]; then
    say "  PASS: none of them touch a deployable path (${DEPLOYABLE_PREFIXES})."
    say "  Documentation drift is not an outage. Reported, not alarmed."
    exit 0
fi

say "  ${#deployable[@]} of them touch deployable paths:"
for sha in "${deployable[@]}"; do
    git --no-pager log -1 --format='    %h %s' "$sha"
done
say ""

# ------------------------------------------------------------ grace window --
# The OLDEST undeployed deployable commit is the one that has been waiting
# longest. Measuring the newest would reset the clock every time anything
# merged, so a permanently-undeployed fix would stay inside the window forever
# as long as the repository stayed busy — an alarm that a busy repo can never
# trip.
oldest_sha="${deployable[${#deployable[@]}-1]}"
oldest_epoch=$(git log -1 --format='%ct' "$oldest_sha")
now_epoch=$(date +%s)
age_hours=$(( (now_epoch - oldest_epoch) / 3600 ))

say "  oldest undeployed deployable commit is ${age_hours}h old (grace: ${GRACE_HOURS}h)"

if [ "$age_hours" -lt "$GRACE_HOURS" ]; then
    say "  PASS: inside the grace window. A deploy is manual and takes minutes."
    exit 0
fi

fail "DEPLOY DRIFT for ${LABEL}: ${#deployable[@]} commit(s) touching deployable paths have been merged for ${age_hours}h and are NOT running. The oldest is $(git log -1 --format='%h %s' "$oldest_sha"). Every health check will keep reporting the OLD code as healthy, because it is. Deploy, or say why not."
exit 1
