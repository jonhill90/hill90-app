#!/usr/bin/env bash
# Branch protection for `main`, as configuration rather than as clicks.
#
#   ./scripts/branch-protection.sh show     what GitHub currently enforces
#   ./scripts/branch-protection.sh apply    make GitHub match this file
#   ./scripts/branch-protection.sh verify   do the required names still exist?
#
# WHY THIS FILE EXISTS. Protection lived only in GitHub's settings UI, so it was
# invisible in review, unreproducible if lost, and undocumented as to WHY it is
# shaped this way. It became available at all only on 2026-08-02, when the
# repository went public — before that both the branch-protection and rulesets
# APIs returned "Upgrade to GitHub Pro or make this repository public".
#
# THE NAMES BELOW ARE RENDERED NAMES, NOT WORKFLOW KEYS. The pytest jobs are a
# matrix — ci.yml declares `name: ${{ matrix.service }} (pytest)` — so reading the
# workflow gives you a template, and GitHub matches the rendered string. These
# were taken from a completed run and cross-checked against the check-runs API on
# a main commit. That distinction is not pedantry: a required check whose name
# never appears is never satisfied, so it blocks every pull request forever. Run
# `verify` after touching ci.yml job names or the matrix.

set -euo pipefail

REPO="jonhill90/hill90-app"
BRANCH="main"

# ---------------------------------------------------------------------------
# THE DECISIONS, and why. A small ruleset that matches how the repo is actually
# worked beats a maximal one that gets switched off the first time it is
# inconvenient.
#
# required checks — all 8. They run on every pull request, take ~3 minutes, and
#   were green on main when this was set. Requiring a subset would leave the rest
#   as decoration.
#
# strict = false — a pull request need NOT be up to date with main to merge.
#   Deliberately DIFFERENT from Hill90, which uses strict = true. Hill90 has one
#   check and low pull-request volume, so strict is cheap there. Here several
#   land a day across eight suites, and strict would force every open branch to
#   rebase and re-run all eight whenever another merged. The risk it trades away
#   is two independently-green branches breaking main together; the services are
#   independent enough that this is the better side of the trade. Revisit if that
#   ever actually happens.
#
# required pull request = yes, with ZERO required approvals — the repo is already
#   worked entirely through pull requests (74 merged before this was set), so this
#   makes the existing practice enforceable rather than customary, and stops an
#   accidental push to main. Zero approvals because there is ONE maintainer:
#   GitHub does not let an author approve their own pull request, so requiring one
#   approval would deadlock the repository permanently.
#
# enforce_admins = false — the admin can still override. This is the honest
#   choice for a single-maintainer repository: the alternative to a bypass is
#   disabling the whole rule in an emergency, which leaves no trace, whereas an
#   admin override is deliberate and recorded. Matches Hill90. NOTE the real
#   consequence: `gh pr merge --admin` WILL merge a failing pull request. The
#   protection is a gate for the normal path, not a wall.
#
# force pushes / deletions = false — this one carries more weight than usual.
#   The repository is public and the decision in #105 was NOT to rewrite history;
#   blocking force-push to main makes that decision enforceable instead of a
#   convention someone could undo in one command.
# ---------------------------------------------------------------------------

read -r -d '' PAYLOAD <<'JSON' || true
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "services/api (jest)",
      "services/ui (vitest)",
      "services/mcp (pytest)",
      "services/agentbox (pytest)",
      "services/ai (pytest)",
      "services/knowledge (pytest)",
      "lint (api, ui, python)",
      "scripts (bats)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": false
}
JSON

cmd_show() {
  gh api "repos/${REPO}/branches/${BRANCH}/protection" \
    -q '"strict:            \(.required_status_checks.strict)
enforce_admins:    \(.enforce_admins.enabled)
required_PR:       \(.required_pull_request_reviews != null)  approvals: \(.required_pull_request_reviews.required_approving_review_count // "n/a")
force_pushes:      \(.allow_force_pushes.enabled)
deletions:         \(.allow_deletions.enabled)"'
  echo "required contexts:"
  gh api "repos/${REPO}/branches/${BRANCH}/protection" \
    -q '.required_status_checks.contexts[]' | sed 's/^/  /'
}

cmd_apply() {
  printf '%s' "$PAYLOAD" \
    | gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" --input - >/dev/null
  echo "applied. current state:"
  cmd_show
}

# The hazard this guards: a required name that no job ever produces blocks every
# pull request, and it fails SILENTLY — the check simply never reports, so the
# branch sits "expected" forever rather than showing an error.
cmd_verify() {
  local run rendered required missing=0
  run=$(gh run list --repo "$REPO" --workflow=ci.yml --status=completed --limit 1 \
        --json databaseId -q '.[0].databaseId')
  [ -n "$run" ] || { echo "no completed ci.yml run to compare against"; exit 1; }
  rendered=$(gh run view "$run" --repo "$REPO" --json jobs -q '.jobs[].name' | sort -u)
  required=$(gh api "repos/${REPO}/branches/${BRANCH}/protection" \
             -q '.required_status_checks.contexts[]' | sort -u)

  echo "comparing required contexts against the job names in run ${run}"
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if grep -Fxq "$name" <<<"$rendered"; then
      echo "  ok      ${name}"
    else
      echo "  MISSING ${name}  <- no job produces this name; it would block every PR"
      missing=$((missing + 1))
    fi
  done <<<"$required"

  while IFS= read -r name; do
    [ -z "$name" ] && continue
    grep -Fxq "$name" <<<"$required" || echo "  note    ${name} runs but is not required"
  done <<<"$rendered"

  [ "$missing" -eq 0 ] || { echo "${missing} required check name(s) match no job."; exit 1; }
  echo "every required check name is produced by a real job"
}

case "${1:-show}" in
  show)   cmd_show ;;
  apply)  cmd_apply ;;
  verify) cmd_verify ;;
  *)      echo "usage: $0 {show|apply|verify}" >&2; exit 2 ;;
esac
