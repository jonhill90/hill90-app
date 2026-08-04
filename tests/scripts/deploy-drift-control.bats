#!/usr/bin/env bats
#
# POSITIVE CONTROL for scripts/checks/check_deploy_drift.sh.
#
# The alarm exists because on 2026-08-03 a merged security fix was not running
# for 23 minutes and nothing said so. An alarm nobody has SEEN FIRE is the same
# object as the checks that could not fire — so every case here builds a real
# repository, points the check at a deliberately stale deployment, and requires
# red. The green cases exist because an alarm that fires on everything gets
# muted, and a muted alarm is also one that cannot fire.
#
# Each fixture is a real git repository with real commits and real timestamps.
# Nothing is mocked: the check reads git, so the control gives it git.

CHECK="" # set in setup

# Commit with a controlled age. GIT_COMMITTER_DATE is what the check reads (%ct),
# and setting only AUTHOR_DATE would leave the committer date at now — a fixture
# that looks aged and is not, which is how a grace-window test passes for the
# wrong reason.
commit_at() {
    local hours_ago="$1" path="$2" msg="$3"
    local when
    when=$(( $(date +%s) - hours_ago * 3600 ))
    mkdir -p "$(dirname "$path")"
    echo "$RANDOM" > "$path"
    git add "$path"
    GIT_AUTHOR_DATE="@${when} +0000" GIT_COMMITTER_DATE="@${when} +0000" \
        git commit -qm "$msg"
}

setup() {
    CHECK="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/check_deploy_drift.sh"
    REPO="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO"
    cd "$REPO"
    git init -q -b main .
    git config user.email t@example.com
    git config user.name t
    commit_at 200 "README.md" "base"
    # A local ref standing in for origin/main, so the fixture needs no network.
    git branch -f origin-main main
    export TARGET_REF=origin-main
    export LABEL=fixture
}

# ------------------------------------------------------------ CANNOT TELL ---
# These matter most. A check that cannot see the thing must not report green.

@test "no deployed SHA exits 2 and says nothing was compared — never a pass" {
    run env DEPLOYED_SHA= bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"UNKNOWN"* ]]
    [[ "$output" == *"NOT a pass"* ]]
}

@test "a deployed SHA this repo has never heard of exits 2, not 0" {
    run env DEPLOYED_SHA=0000000000000000000000000000000000000000 bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not a commit in this repository"* ]]
}

@test "an unresolvable target ref exits 2" {
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" TARGET_REF=origin/nope bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"does not resolve"* ]]
}

# --------------------------------------------------------- THE REAL ALARM ---

@test "FIRES: a deployable commit merged longer ago than the grace window" {
    # This is the 2026-08-03 incident, replayed: a services/ fix merged and not
    # running, while every health check stays green because it answers from the
    # container that is running the old code.
    deployed=$(git rev-parse HEAD)
    commit_at 9 "services/api/src/routes/health.ts" "fix(api): stop leaking the inventory"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"DEPLOY DRIFT for fixture"* ]]
    [[ "$output" == *"stop leaking the inventory"* ]]
    [[ "$output" == *"9h"* ]]
}

@test "FIRES: the host carries a commit that is on no branch — reset will destroy it" {
    # The direction that is never normal. Someone edited production.
    commit_at 1 "services/api/hand-edit.ts" "hand edit made directly on the VPS"
    deployed=$(git rev-parse HEAD)
    git reset -q --hard origin-main

    run env DEPLOYED_SHA="$deployed" bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"HOST AHEAD"* ]]
    [[ "$output" == *"destroy them"* ]]
}

@test "the failing message is loud enough to act on without opening the repo" {
    deployed=$(git rev-parse HEAD)
    commit_at 30 "services/api/x.ts" "fix(api): the thing"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    # ::error:: so it surfaces in the Actions UI rather than only in the log body.
    [[ "$output" == *"::error::"* ]]
    # names the repo, the age, and what to do
    [[ "$output" == *"fixture"* ]]
    [[ "$output" == *"Deploy, or say why not"* ]]
}

# ------------------------------------------------------ AND STAYS QUIET -----
# Measured before this was written: 32 commits on main against 7 deploys in 24
# hours. An alarm that cannot be quiet in this repository is one that gets muted.

@test "QUIET: checkout SHA equals the target" {
    # This case asserted "what is running is what was merged" until #158. It was
    # pinning the overclaim: the check compares a git SHA and never looks at a
    # container, so that sentence asserted something it had not verified. A test
    # that pins a wrong message keeps the message wrong.
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"the host checkout matches"* ]]
}

@test "QUIET: old drift that touches only documentation" {
    deployed=$(git rev-parse HEAD)
    commit_at 100 "docs/decisions/whatever.md" "docs: a long essay"
    commit_at 90 "CLAUDE.md" "docs: correct a date"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"not an outage"* ]]
}

@test "QUIET: a deployable commit merged minutes ago" {
    deployed=$(git rev-parse HEAD)
    commit_at 0 "services/ui/src/x.ts" "fix(ui): something"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"inside the grace window"* ]]
}

# ------------------------------------------------------------- the mixture --

@test "a docs commit NEWER than an aged deployable one does not reset the clock" {
    # The bug this pins: measuring the NEWEST undeployed commit would mean a busy
    # repository could never trip the alarm, because something always merged
    # recently. The oldest waiting deployable commit is the one that matters.
    deployed=$(git rev-parse HEAD)
    commit_at 48 "services/api/urgent.ts" "fix(api): the security fix nobody deployed"
    commit_at 1  "docs/note.md" "docs: an unrelated note from an hour ago"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"the security fix nobody deployed"* ]]
    [[ "$output" == *"48h"* ]]
}

@test "a docs commit OLDER than the grace window alone still does not fire" {
    # The mirror of the case above, so the filter is proven in both directions
    # rather than only where it happens to agree with the age rule.
    deployed=$(git rev-parse HEAD)
    commit_at 500 "README.md" "docs: ancient"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]
}

@test "CONTROL: the check is not vacuously green — it can be made to fire by one commit" {
    # Guards against the whole file passing because the script exits 0 early for
    # some unrelated reason. Same fixture, one deployable commit is the only
    # difference between green and red.
    deployed=$(git rev-parse HEAD)
    commit_at 50 "docs/only.md" "docs: only"
    git branch -f origin-main main
    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]

    commit_at 50 "services/api/one.ts" "fix(api): one deployable change"
    git branch -f origin-main main
    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# THE WORDING IS PART OF THE CHECK.
#
# This alarm compares ONE git SHA read from the host against origin/main. It
# does not inspect a container image. It nevertheless printed "what is running
# is what was merged", and on 2026-08-03 printed exactly that while two merged
# api fixes sat in the checkout and outside the running image (#158) — the guard
# asserting something it had not verified, which is the family it exists to
# catch.
#
# So these cases pin the message, in both directions: it must say what it
# compared, must say what it did not, and must not be readable as a statement
# about running code.
# ---------------------------------------------------------------------------

@test "WORDING clean: says CHECKOUT, and never claims to know what is running" {
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"the host checkout matches"* ]]
    # The exact sentence that overclaimed, and the phrasing family around it.
    [[ "$output" != *"what is running is what was merged"* ]]
    [[ "$output" != *"is what was merged"* ]]
}

@test "WORDING clean: carries the NOT CHECKED caveat, so coverage cannot be inferred" {
    # A green line with no stated limit reads as a broader guarantee than it is.
    # The caveat has to travel WITH the pass, not live only in a comment.
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"NOT CHECKED"* ]]
    [[ "$output" == *"container"* ]]
    [[ "$output" == *"rebuilds ONE stack"* ]]
}

@test "WORDING: the scope banner states the comparison before any verdict" {
    # A reader who stops at the first two lines must still not be able to infer
    # coverage that is absent.
    #
    # The banner is now CONDITIONAL, because a fixed "does NOT inspect any
    # container image" became false the moment revisions were supplied — the same
    # overclaim as the sentence #162 removed, pointing the other way. Both arms
    # are asserted so neither can drift into describing the other's run.
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [[ "$output" == *"SCOPE: compares the git CHECKOUT"* ]]
    [[ "$output" == *"No container revisions were supplied"* ]]
    [[ "$output" != *"AND"* ]] || true

    run env DEPLOYED_SHA="$(git rev-parse HEAD)" \
        CONTAINER_REVISIONS="app-api=$(git rev-parse HEAD)" bash "$CHECK"
    [[ "$output" == *"the revision each running container was created from"* ]]
    [[ "$output" != *"No container revisions were supplied"* ]]
}

@test "WORDING drifted: says NOT IN THE HOST CHECKOUT, not 'not running'" {
    # The same overclaim with the opposite sign. The check knows the commits are
    # absent from the checkout; that they are not running follows, and the
    # message may say so — but the thing it VERIFIED must be named first.
    deployed=$(git rev-parse HEAD)
    commit_at 9 "services/api/x.ts" "fix(api): a bound"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"NOT IN THE HOST CHECKOUT"* ]]
    [[ "$output" == *"They are certainly not running"* ]]
}

@test "WORDING drifted: the count line is about the checkout too" {
    deployed=$(git rev-parse HEAD)
    commit_at 9 "services/api/x.ts" "fix(api): a bound"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [[ "$output" == *"not in the host checkout."* ]]
    [[ "$output" != *"merged and not deployed."* ]]
}

@test "WORDING unknown: names the checkout, and refuses to imply anything else" {
    run env DEPLOYED_SHA= bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no checkout SHA was supplied"* ]]
    [[ "$output" == *"neither the checkout nor anything running"* ]]
}

@test "CONTROL: the wording assertions can fail — they are not matching everything" {
    # Every case above is a string match, and a string match that is always true
    # proves nothing. Each phrase pinned here is absent from a deliberately
    # different message.
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    # the clean run must NOT carry the drifted vocabulary...
    [[ "$output" != *"NOT IN THE HOST CHECKOUT"* ]]
    [[ "$output" != *"no checkout SHA was supplied"* ]]
    # ...and must not accidentally match a phrase nothing emits.
    [[ "$output" != *"verified the running image"* ]]
}

# ---------------------------------------------------------------------------
# COMPARING WHAT IS RUNNING, not what the checkout says.
#
# The wording fix (#162) made the alarm honest about its scope. This is the
# scope itself widening: CONTAINER_REVISIONS carries what each running container
# was created from, read from the `com.hill90.revision` label that
# scripts/deploy.sh now stamps.
#
# The case that matters is the one that bit on 2026-08-03: the checkout is
# CURRENT and a container is BEHIND. Under the old check that combination was
# indistinguishable from success, and was reported as the goal state.
# ---------------------------------------------------------------------------

@test "RUNNING: checkout current but a container behind is CAUGHT — the #158 case" {
    # Exactly the shape that produced a green alarm while two api fixes sat
    # unrun. The checkout equals the target; only the container is old.
    old=$(git rev-parse HEAD)
    commit_at 2 "services/api/x.ts" "fix(api): a bound nobody is running"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" CONTAINER_REVISIONS="app-api=${old}" bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"RUNNING CODE IS BEHIND"* ]]
    [[ "$output" == *"running OLD CODE"* ]]
}

@test "RUNNING: the old check would have passed that exact input" {
    # The control that proves the case above is not vacuous. Same tree, same
    # checkout SHA, no revisions supplied — the pre-#158 behaviour — passes.
    old=$(git rev-parse HEAD)
    commit_at 2 "services/api/x.ts" "fix(api): a bound nobody is running"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"NOT CHECKED"* ]]
}

@test "RUNNING: a container behind only on DOCS is not an alarm" {
    old=$(git rev-parse HEAD)
    commit_at 2 "docs/x.md" "docs: a note"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" CONTAINER_REVISIONS="app-api=${old}" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"none touch a deployable path"* ]]
}

@test "RUNNING: a container current with the target reports current" {
    sha=$(git rev-parse HEAD)
    run env DEPLOYED_SHA="$sha" CONTAINER_REVISIONS="app-api=${sha} app-ui=${sha}" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"app-api: ${sha:0:12} — current with"* ]]
    [[ "$output" == *"app-ui: ${sha:0:12} — current with"* ]]
}

# ---------------------------------------------------------------------------
# THE THREE ASSERTIONS BELOW CHANGED FROM `exit 1` TO `exit 3`, AND WHY THAT IS
# NOT EDITING A TEST TO MAKE IT PASS.
#
# This repository's rule is that a red test is never edited into a green one.
# From outside, that and this look identical: an assertion changed, a red run
# went green. The difference is which direction the truth moved.
#
# These three describe an UNSTAMPED or unreadable container — a state where the
# check has NO INFORMATION about the running code. They asserted `exit 1`, the
# same code as "this container is running old code", because the script used one
# flag and one message for both. That shared code IS the conflation this change
# removes: the assertions were a faithful record of a defect, so correcting the
# defect necessarily falsifies them.
#
# What is preserved is the property each was written to protect — that absence
# must never read as agreement. Each still asserts a NON-ZERO exit, and each now
# additionally asserts the output does NOT claim BEHIND, which is the thing the
# old code could not distinguish and the reason these had to move.
# ---------------------------------------------------------------------------

@test "RUNNING: an UNSTAMPED container is not a pass" {
    # A container created before the stamp existed, or by hand. Absence must not
    # read as agreement — the same rule the exit-2 path enforces for the checkout.
    sha=$(git rev-parse HEAD)
    run env DEPLOYED_SHA="$sha" CONTAINER_REVISIONS="app-api=unstamped" bash "$CHECK"
    [ "$status" -eq 3 ]          # 3 = cannot tell; still non-zero, still not a pass
    [ "$status" -ne 0 ]
    [[ "$output" == *"UNSTAMPED"* ]]
    [[ "$output" == *"Not a pass"* ]]
    [[ "$output" != *"RUNNING CODE IS BEHIND"* ]]
}

@test "RUNNING: docker's empty-label output is treated as unstamped, not as a SHA" {
    # `docker inspect --format` prints `<no value>` for a missing label. Passing
    # that through as if it were a revision would compare garbage and report it
    # as a mismatch for the wrong reason.
    sha=$(git rev-parse HEAD)
    run env DEPLOYED_SHA="$sha" CONTAINER_REVISIONS="app-api=<no value>" bash "$CHECK"
    [ "$status" -eq 3 ]
    [ "$status" -ne 0 ]
    [[ "$output" == *"UNSTAMPED"* ]]
    [[ "$output" != *"RUNNING CODE IS BEHIND"* ]]
}

@test "RUNNING: a revision this repo has never seen is reported, not silently skipped" {
    sha=$(git rev-parse HEAD)
    run env DEPLOYED_SHA="$sha" \
        CONTAINER_REVISIONS="app-api=0000000000000000000000000000000000000000" bash "$CHECK"
    [ "$status" -eq 3 ]
    [ "$status" -ne 0 ]
    [[ "$output" == *"is not a commit in this repository"* ]]
    [[ "$output" != *"RUNNING CODE IS BEHIND"* ]]
}

@test "RUNNING: with no revisions supplied it says so rather than implying agreement" {
    sha=$(git rev-parse HEAD)
    run env DEPLOYED_SHA="$sha" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"not reported"* ]]
    [[ "$output" == *"UNKNOWN, not agreement"* ]]
}

@test "RUNNING: the container check runs BEFORE the in-sync early exit" {
    # The bug this file would otherwise reproduce: the in-sync branch used to
    # exit 0 immediately, so a behind container was never examined when the
    # checkout matched — which is the only situation it matters in.
    old=$(git rev-parse HEAD)
    commit_at 2 "services/ui/x.ts" "fix(ui): a bound"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" CONTAINER_REVISIONS="app-ui=${old}" bash "$CHECK"
    [ "$status" -eq 1 ]
    # and the checkout line still printed, so the two facts stay separable
    [[ "$output" == *"host checkout"* ]]
}

@test "RUNNING: a commit in ANOTHER service does not mark this container behind" {
    # The false positive the first version produced against real data: a change
    # to services/ui made app-api report OLD CODE. A guard that fires on things
    # it does not describe gets relaxed, and then guards nothing.
    old=$(git rev-parse HEAD)
    commit_at 5 "services/ui/src/thing.ts" "fix(ui): unrelated to api"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" CONTAINER_REVISIONS="app-api=${old}" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"none touch a deployable path"* ]]
}

@test "RUNNING: a change to the CHECK ITSELF does not mark a container behind" {
    # It also counted scripts/checks/check_deploy_drift.sh against app-api. The
    # alarm is not inside any image.
    old=$(git rev-parse HEAD)
    commit_at 5 "scripts/checks/check_deploy_drift.sh" "fix(ci): the alarm"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" CONTAINER_REVISIONS="app-api=${old}" bash "$CHECK"
    [ "$status" -eq 0 ]
}

@test "RUNNING: a TEST-only change inside this service does not mark it behind" {
    # The container does not run the tests. a10f5d0 was exactly this shape.
    old=$(git rev-parse HEAD)
    commit_at 5 "services/api/src/__tests__/x.test.ts" "test(api): a case"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" CONTAINER_REVISIONS="app-api=${old}" bash "$CHECK"
    [ "$status" -eq 0 ]
}

@test "RUNNING: but this service's OWN runtime code still fires" {
    # The complement, so the three exclusions above cannot have muted the check.
    old=$(git rev-parse HEAD)
    commit_at 5 "services/api/src/routes/thing.ts" "fix(api): real runtime change"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" CONTAINER_REVISIONS="app-api=${old}" bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"running OLD CODE"* ]]
}

@test "RUNNING: this service's own COMPOSE file fires too" {
    old=$(git rev-parse HEAD)
    commit_at 5 "deploy/compose/prod/docker-compose.api.yml" "fix(api): change the container"
    git branch -f origin-main main
    current=$(git rev-parse HEAD)

    run env DEPLOYED_SHA="$current" CONTAINER_REVISIONS="app-api=${old}" bash "$CHECK"
    [ "$status" -eq 1 ]
}

# ---------------------------------------- BEHIND is not the same as UNKNOWN ---
# The alarm used to report both through one flag and one message, so an
# unstamped container produced the headline "RUNNING CODE IS BEHIND" — a
# specific finding, on evidence that was an absence of one. Someone acting on it
# would have deployed looking for old code and found none.
#
# These tests exist to keep the two distinguishable. The control that matters is
# the LAST one: the two states must not produce the same output, or the
# distinction has been lost again whatever the wording says.

@test "a stamped-but-older container says BEHIND, and exits 1" {
    commit_at 200 "services/api/src/app.ts" "old"
    local old_sha; old_sha=$(git rev-parse HEAD)
    commit_at 200 "services/api/src/app.ts" "new"
    git branch -f origin-main main

    run env CONTAINER_REVISIONS="app-api=${old_sha}" \
        DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"

    [ "$status" -eq 1 ]
    [[ "$output" == *"RUNNING CODE IS BEHIND"* ]]
    [[ "$output" == *"running OLD CODE"* ]]
    # It must NOT claim it could not identify the container: it could.
    [[ "$output" != *"RUNNING CODE UNKNOWN"* ]]
}

@test "an unstamped container says UNKNOWN, not BEHIND, and exits 3" {
    run env CONTAINER_REVISIONS="app-api=" \
        DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"

    [ "$status" -eq 3 ]
    [[ "$output" == *"RUNNING CODE UNKNOWN"* ]]
    [[ "$output" == *"UNSTAMPED"* ]]
    # The headline must not assert drift it has no evidence for.
    [[ "$output" != *"RUNNING CODE IS BEHIND"* ]]
}

@test "an unresolvable stamp is UNKNOWN too — a stamp that cannot be read is not a finding" {
    run env CONTAINER_REVISIONS="app-api=deadbeefdeadbeef" \
        DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"

    [ "$status" -eq 3 ]
    [[ "$output" == *"RUNNING CODE UNKNOWN"* ]]
    [[ "$output" != *"RUNNING CODE IS BEHIND"* ]]
}

@test "CONTROL: the two states produce DIFFERENT output and DIFFERENT exit codes" {
    commit_at 200 "services/api/src/app.ts" "old"
    local old_sha; old_sha=$(git rev-parse HEAD)
    commit_at 200 "services/api/src/app.ts" "new"
    git branch -f origin-main main
    local head_sha; head_sha=$(git rev-parse HEAD)

    run env CONTAINER_REVISIONS="app-api=${old_sha}" DEPLOYED_SHA="$head_sha" bash "$CHECK"
    local behind_status="$status" behind_output="$output"

    run env CONTAINER_REVISIONS="app-api=" DEPLOYED_SHA="$head_sha" bash "$CHECK"
    local unknown_status="$status" unknown_output="$output"

    # Both are failures — neither state is a pass.
    [ "$behind_status" -ne 0 ]
    [ "$unknown_status" -ne 0 ]
    # And they are TELLABLE APART, which is the whole point.
    [ "$behind_status" -ne "$unknown_status" ]
    [ "$behind_output" != "$unknown_output" ]
}

# ── #236: images are checked too, and the guard must be ABLE to fire ─────────
#
# The trap this covers: the per-thing path filter derives its pattern from the
# name. The container form (`${cname#app-}`) applied to an image name like
# `hill90/agentbox` yields `services/hill90/agentbox/`, which never matches —
# so n_dep stays 0, the script says "none touch a deployable path", and a stale
# image is reported as health. A guard that cannot fire is indistinguishable
# from a pass, which is the failure this whole check exists to avoid.

@test "a stale agentbox IMAGE says BEHIND, and exits 1" {
    local old; old=$(git rev-parse HEAD)
    commit_at 1 "services/agentbox/app/server.py" "feat(agentbox): change inside the image"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$(git rev-parse HEAD)" \
        CONTAINER_REVISIONS="hill90/agentbox=$old" bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"hill90/agentbox"* ]]
    [[ "$output" == *"OLD CODE"* ]]
}

@test "an agentbox image is stale when services/knowledge moves — it copies the akm CLI from it" {
    local old; old=$(git rev-parse HEAD)
    commit_at 1 "services/knowledge/app/main.py" "feat(knowledge): change the image depends on"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$(git rev-parse HEAD)" \
        CONTAINER_REVISIONS="hill90/agentbox=$old" bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"OLD CODE"* ]]
}

@test "an image is NOT stale for a change outside its build context" {
    local old; old=$(git rev-parse HEAD)
    commit_at 1 "services/ui/src/app/page.tsx" "feat(ui): unrelated to any agent image"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$(git rev-parse HEAD)" \
        CONTAINER_REVISIONS="hill90/agentbox=$old" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"none touch a deployable path"* ]]
}

@test "CONTROL: the image guard distinguishes the two, so it is not vacuous" {
    # Without this, the three tests above could all pass against a guard that
    # always said "none touch a deployable path" — the exact defect prevented.
    local base; base=$(git rev-parse HEAD)
    commit_at 2 "services/agentbox/app/server.py" "feat(agentbox): relevant"
    git branch -f origin-main main
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" \
        CONTAINER_REVISIONS="hill90/agentbox=$base" bash "$CHECK"
    local rc_relevant=$status

    local mid; mid=$(git rev-parse HEAD)
    commit_at 1 "services/ui/src/app/page.tsx" "feat(ui): irrelevant"
    git branch -f origin-main main
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" \
        CONTAINER_REVISIONS="hill90/agentbox=$mid" bash "$CHECK"
    local rc_irrelevant=$status

    [ "$rc_relevant" -ne "$rc_irrelevant" ]
}
