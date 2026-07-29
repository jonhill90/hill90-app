#!/usr/bin/env bash
# Assert stack_secrets lists every variable its prod compose file interpolates
# without a default. Used by secrets-loader.bats.
#
# Every grep carries `|| true` because scripts/_common.sh sets `set -euo pipefail`
# and a grep matching nothing would otherwise abort the loop — which silently
# truncated an earlier version of this check.
cd "$1" || exit 2
# shellcheck source=/dev/null
source scripts/_common.sh >/dev/null 2>&1
eval "$(sed -n '/^stack_secrets()/,/^}/p' scripts/deploy.sh)"

set +e
rc=0
for f in deploy/compose/prod/docker-compose.*.yml; do
    stack=$(basename "$f" .yml); stack=${stack#docker-compose.}
    case "$stack" in agentbox-images|discord-bot) continue ;; esac
    want=$(grep -oE '\$\{[A-Z_][A-Z0-9_]*\}' "$f" 2>/dev/null | tr -d '${}' | sort -u | grep -v '^$' || true)
    got=$(stack_secrets "$stack" 2>/dev/null | tr ' ' '\n' | grep -v '^NONE$' | sort -u | grep -v '^$' || true)
    miss=$(comm -23 <(printf '%s\n' "$want" | grep -v '^$' || true) \
                    <(printf '%s\n' "$got"  | grep -v '^$' || true) || true)
    if [ -n "$(printf '%s' "$miss" | tr -d '[:space:]')" ]; then
        printf '%s MISSING: %s\n' "$stack" "$(printf '%s' "$miss" | tr '\n' ' ')"
        rc=1
    fi
done
exit $rc
