#!/usr/bin/env bash
#
# Is the host's CHECKOUT the same as what was MERGED?
#
# NOT "is what is running the same as what was merged" — that is the question
# worth answering and this cannot answer it. It compares one git SHA read from
# the host against origin/main. A deploy resets the whole checkout and rebuilds
# ONE stack, so a service can be running code several commits older than the
# checkout reports. On 2026-08-03 this printed "what is running is what was
# merged" while two merged api fixes sat in the checkout and outside the running
# image — the guard making exactly the overclaim it was built to catch (#158).
#
# The wording below therefore states what was compared AND what was not. That is
# weaker than the sentence it replaces, and the weakness is the true reading:
# the fix is to compare more (per-service build provenance, #158), not to word
# the current comparison more confidently.
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
#   3  RUNNING CODE UNKNOWN (a container carries no usable stamp: this check
#                            cannot say whether it is current OR behind)
#
# 1 AND 3 ARE DELIBERATELY DIFFERENT, and a caller that collapses them to
# "non-zero" loses the distinction this script exists to make. 1 is a finding
# about the code. 3 is the ABSENCE of a finding — the check has no information.
# Reporting 3 as 1 is what this script used to do, and it meant the alarm's
# headline asserted drift on evidence it did not have.

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

# --------------------------------------------------------------- revisions ---
# What each RUNNING container was created from, as `name=sha` pairs, supplied by
# the caller which reads them over ssh:
#
#   docker inspect app-api --format '{{index .Config.Labels "com.hill90.revision"}}'
#
# This is the half the checkout comparison cannot do. A deploy resets the whole
# checkout but rebuilds ONE stack, so the checkout can be current while a
# service runs code several commits old — which is exactly what happened on
# 2026-08-03 and what this alarm reported as the goal state (#158).
#
# Empty means the caller could not read any, which is reported and never treated
# as agreement.
CONTAINER_REVISIONS="${CONTAINER_REVISIONS:-}"

say()  { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; }

say "Deploy drift — ${LABEL}"
say "=============================================="
if [ -n "$CONTAINER_REVISIONS" ]; then
    say "  SCOPE: compares the git CHECKOUT on the host against ${TARGET_REF}, AND"
    say "         the revision each running container was created from."
else
    say "  SCOPE: compares the git CHECKOUT on the host against ${TARGET_REF}."
    say "         No container revisions were supplied, so nothing is known about"
    say "         which commit a running service was built from. See issue #158."
fi
say ""

# ---------------------------------------------------------------- unknown ---
if [ -z "$DEPLOYED_SHA" ]; then
    fail "DEPLOY DRIFT UNKNOWN for ${LABEL}: no checkout SHA was supplied. This is NOT a pass — nothing was compared, so neither the checkout nor anything running on the host is verified."
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

say "  host checkout: ${deployed_sha:0:12}"
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

# ------------------------------------------------ what is actually RUNNING ---
# The checkout comparison above is necessary and not sufficient. This is the
# part that answers the question the alarm's name implies.
# TWO DIFFERENT FINDINGS, TRACKED SEPARATELY.
#
# "this container runs code older than main" is a fact about the code.
# "this container carries no usable stamp" is an ABSENCE of information.
#
# They were one flag and one message, so the alarm's headline asserted BEHIND
# while its evidence was, for unstamped containers, that it could not tell. That
# is this repository's own defect family pointed the other way: a check reporting
# a specific finding when what it has is an absence of one. A reader who saw
# "RUNNING CODE IS BEHIND" and then deployed would find nothing had been behind.
running_behind=0
running_unknown=0
if [ -z "$CONTAINER_REVISIONS" ]; then
    say ""
    say "  RUNNING CONTAINERS: not reported."
    say "  No revision stamps were supplied, so nothing was compared about running"
    say "  code. That is UNKNOWN, not agreement."
else
    say ""
    say "  RUNNING CONTAINERS:"
    # Split on NEWLINES, not whitespace. `docker inspect --format` prints
    # `<no value>` for a missing label — a value containing a space — and
    # word-splitting tore that into two bogus entries, one of which looked like a
    # container called `value>`. The format is one `name=revision` per line.
    while IFS= read -r pair; do
        [ -n "$pair" ] || continue
        cname="${pair%%=*}"
        crev="${pair#*=}"

        # Anything that is not a hex object name is not a revision. Validating the
        # SHAPE rather than listing known placeholders means a new placeholder
        # cannot be mistaken for a commit.
        if ! printf '%s' "$crev" | grep -qE '^[0-9a-f]{7,40}$'; then
            say "    ${cname}: UNSTAMPED — created before the stamp existed, or by hand."
            say "      Not a pass. Nothing is known about this container's code."
            running_unknown=1
            continue
        fi

        if ! git rev-parse --verify --quiet "${crev}^{commit}" >/dev/null; then
            say "    ${cname}: revision ${crev:0:12} is not a commit in this repository."
            say "      Not a pass. The stamp exists but cannot be resolved here."
            running_unknown=1
            continue
        fi

        cbehind=$(git rev-list --count "${crev}..${target_sha}" 2>/dev/null || echo 0)
        if [ "$cbehind" -eq 0 ]; then
            say "    ${cname}: ${crev:0:12} — current with ${TARGET_REF}"
        else
            say "    ${cname}: ${crev:0:12} — ${cbehind} commit(s) behind ${TARGET_REF}"
            # Only a commit touching a DEPLOYABLE path can matter to a container,
            # for the same reason the checkout rule uses that filter.
            # SCOPED TO THIS CONTAINER, and to code it actually runs.
            #
            # The first version reused the global DEPLOYABLE_PREFIXES, which made
            # every container behind on every other container's commits: against
            # app-api it counted a change to services/ui/src/__tests__ and a
            # change to this very script. Neither is inside the api image. That is
            # the too-broad-guard failure again — a guard that fires on things it
            # does not describe gets relaxed, and then guards nothing.
            svc="${cname#app-}"
            n_dep=0
            for sha in $(git rev-list "${crev}..${target_sha}"); do
                if git show --name-only --format="" "$sha" \
                     | grep -E "^(services/${svc}/|deploy/compose/prod/docker-compose\.${svc}\.yml)" \
                     | grep -qvE '(/__tests__/|/tests/|\.test\.|\.spec\.|_test\.py$|/test_)'; then
                    n_dep=$((n_dep+1))
                fi
            done
            if [ "$n_dep" -gt 0 ]; then
                say "      ${n_dep} of them touch deployable paths — this container is running OLD CODE."
                running_behind=1
            else
                say "      none touch a deployable path"
            fi
        fi
    done < <(printf '%s\n' "$CONTAINER_REVISIONS" | tr ' ' '\n' | grep -F '=' || true)
fi

# Reported separately, and with different exit codes, so a caller can tell a
# defect from an absence of evidence. Both are non-zero: neither is a pass.
if [ "$running_behind" -ne 0 ]; then
    fail "RUNNING CODE IS BEHIND for ${LABEL}: at least one container is running code older than ${TARGET_REF} on a path inside its own image. The host checkout may well be current — that is the gap #158 is about, and it is why this check no longer stops at the checkout."
    exit 1
fi

if [ "$running_unknown" -ne 0 ]; then
    fail "RUNNING CODE UNKNOWN for ${LABEL}: at least one container carries no usable revision stamp, so this check CANNOT SAY whether it is current or behind. This is an absence of evidence, not a finding of drift — do not read it as 'behind'. Redeploy the affected stacks to stamp them."
    exit 3
fi

# ---------------------------------------------------------------- in sync ---
if [ "$deployed_sha" = "$target_sha" ]; then
    if [ -n "$CONTAINER_REVISIONS" ]; then
        say "  Checkout matches ${TARGET_REF}. Container revisions are checked below."
    else
        say "  PASS: the host checkout matches ${TARGET_REF}."
        say "  NOT CHECKED: which commit each container was built from — no"
        say "  revision stamps were supplied."
        say "  A deploy resets the whole checkout but rebuilds ONE stack, so a"
        say "  service can be running older code while this line is green."
    fi
    exit 0
fi

behind=$(git rev-list --count "${deployed_sha}..${target_sha}")
say "  ${behind} commit(s) merged and not in the host checkout."

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

fail "DEPLOY DRIFT for ${LABEL}: ${#deployable[@]} commit(s) touching deployable paths have been merged for ${age_hours}h and are NOT IN THE HOST CHECKOUT. The oldest is $(git log -1 --format='%h %s' "$oldest_sha"). They are certainly not running. Every health check will keep reporting the OLD code as healthy, because it is. Deploy, or say why not."
exit 1
