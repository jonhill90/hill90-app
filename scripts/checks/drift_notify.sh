#!/usr/bin/env bash
#
# Give the deploy drift alarm a reader.
#
# THE DEFECT (app#511). `Deploy Drift Alarm` failed five consecutive scheduled
# runs on 2026-08-05 — 06:40, 10:45, 14:31, 17:52, 21:31 — reporting real drift
# every time. Nothing was wrong with the check. Four services were running code
# 58 to 72 commits behind main, including every fix merged that day, and the
# only place that verdict appeared was a red run in the Actions tab. Nobody was
# looking at the Actions tab.
#
# The estate has already paid for this lesson once in a different currency:
# `ServiceDown` fired for at least 48 hours in the week to 2026-07-26 and
# reached nobody, which is what docs/decisions/alerting-audit.md exists to
# record. A check whose verdict nobody reads is not meaningfully different from
# a check that cannot fail.
#
# WHAT THIS DOES. Turns the alarm's verdict into a GitHub issue, which is a
# channel that actually notifies. One issue, reused: a fresh issue every four
# hours would be its own kind of unreadable, so an already-open alarm issue gets
# a comment instead. When drift clears, the issue is closed with the run that
# cleared it, so an open issue always means "drift right now" rather than
# "drift at some point in the past".
#
# WHY NOT ALERTMANAGER. The estate has a proven email path to ACME_EMAIL, but it
# runs on the VPS and this runs on a GitHub runner that reaches the host only
# through Tailscale. Pushing an alert from here would mean exposing a receiver
# or holding another credential. GitHub already has a notification channel to
# the one person who needs it, and the repository is where the fix happens.
#
# Usage:
#   drift_notify.sh drifted <body-file>   # open, or comment on, the alarm issue
#   drift_notify.sh clear                 # close the alarm issue if one is open
#
# Requires GH_TOKEN with issues:write. Exits non-zero only if the notification
# itself failed — the caller's own drift verdict is passed through separately,
# because "we could not tell you" must never be confused with "nothing to tell".
set -euo pipefail

TITLE="Deploy drift alarm: production is running code older than main"
REPO="${DRIFT_NOTIFY_REPO:-${GITHUB_REPOSITORY:-jonhill90/hill90-app}}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/actions/runs/${GITHUB_RUN_ID:-unknown}"

mode="${1:-}"

# Exact-title match, not a search query. `gh issue list --search` applies
# fuzzy full-text matching, so a different issue that merely mentions the
# phrase would be adopted as the alarm issue and commented on forever.
find_open_issue() {
  gh issue list --repo "$REPO" --state open --limit 100 \
    --json number,title \
    --jq "[.[] | select(.title == \"$TITLE\")] | .[0].number // empty"
}

case "$mode" in
  drifted)
    body_file="${2:?drifted requires a body file}"
    [ -f "$body_file" ] || { echo "drift_notify: body file $body_file does not exist" >&2; exit 1; }

    existing="$(find_open_issue)"
    if [ -n "$existing" ]; then
      {
        echo "Still drifting, as of [this run]($RUN_URL)."
        echo
        echo '```'
        cat "$body_file"
        echo '```'
      } | gh issue comment "$existing" --repo "$REPO" --body-file -
      echo "drift_notify: commented on existing issue #$existing"
    else
      {
        echo "The deploy drift alarm is reporting that production is running code older than \`main\`."
        echo
        echo "Opened automatically by [this run]($RUN_URL). This issue is reused rather than"
        echo "reopened per run: subsequent alarms comment here, and it closes itself when drift clears."
        echo
        echo "Deploy the affected stacks, or record why not."
        echo
        echo '```'
        cat "$body_file"
        echo '```'
      } | gh issue create --repo "$REPO" --title "$TITLE" --body-file -
      echo "drift_notify: opened a new alarm issue"
    fi
    ;;

  clear)
    existing="$(find_open_issue)"
    if [ -n "$existing" ]; then
      gh issue close "$existing" --repo "$REPO" \
        --comment "Drift cleared — [this run]($RUN_URL) found nothing actionable. Closing so that an open alarm issue always means drift right now."
      echo "drift_notify: closed issue #$existing"
    else
      echo "drift_notify: no open alarm issue, nothing to close"
    fi
    ;;

  *)
    echo "usage: drift_notify.sh {drifted <body-file>|clear}" >&2
    exit 2
    ;;
esac
