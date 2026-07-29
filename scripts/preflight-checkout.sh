#!/usr/bin/env bash
# Checkout preflight — run on the VPS immediately BEFORE `git reset --hard`.
#
# WHY THIS EXISTS
#
# /opt/hill90-app is a deploy target that people hand-edit, and
# .github/workflows/reusable-deploy-service.yml runs `git reset --hard origin/main`
# on it. A local edit there is therefore destroyed silently, by design, with no
# record of what it was — unstaged changes are never written to git's object
# database, so there is no blob, no stash and no reflog entry to recover from.
#
# Hill90 hit exactly this on 2026-07-29: an uncommitted change to
# platform/edge/dynamic/middlewares.yml was discarded during a routine `git fetch
# && git reset --hard origin/main`, and its contents are gone permanently. That
# checkout had also been sitting 12 commits behind main for three days, so
# production config genuinely differed from the repository and nobody knew.
#
# This is the tenant-side equivalent, deliberately modelled on Hill90's
# scripts/preflight-checkout.sh rather than designed afresh.
#
# HOW THE TENANT DIFFERS, AND WHY THERE IS NO "WATCHED" TIER
#
# Hill90's version has a LIVE (WATCHED) tier, because platform/edge/dynamic is
# mounted into Traefik with `watch: true` — editing a file there is simultaneously
# a live production change and a doomed one.
#
# This repository has nothing equivalent. It has no Traefik file provider and no
# bind mount with `watch: true`; Hill90's own assessment of the tenant side (#565)
# established that and recommended dropping the tier rather than carrying an empty
# one, because a tier that never fires trains people to ignore the output.
#
# So the tenant's exposure is "an edit is silently lost and silently reverted",
# without the "and it was live in production while it existed" part. Same lost
# work, less blast radius.
#
# WHAT THIS CANNOT SEE
#
# docker-compose.api.yml bind-mounts AGENTBOX_CONFIG_HOST_PATH, default
# /opt/hill90/agentbox-configs, which is OUTSIDE the checkout and not
# version-controlled at all. `git reset --hard` cannot touch it, and neither can
# this script. Its failure mode is the mirror image of the one guarded here: edits
# survive every deploy and drift permanently with no record. Named so nobody
# concludes this script covers it.
#
# BEHAVIOUR
#
#   clean tree                -> report drift, exit 0
#   dirty tree                -> print the FULL diff, classify each path, exit 1
#   ALLOW_DIRTY_CHECKOUT=1    -> print the FULL diff, classify, exit 0
#
# The diff is printed in every case, including the override, because it is the
# only record that will survive the reset.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths that are bind-mounted into running containers.
#
# Derived from the `../../../<path>:` bind mounts in deploy/compose/prod/*.yml.
# tests/scripts/preflight-checkout.bats fails if a mount is added there and not
# listed here, so this cannot silently fall behind compose.
#
# Only the prod files are represented. deploy/compose/overrides/local.auth.yml
# also mounts compose/local/keycloak/realm-local.json, but the overrides never run
# on the VPS, and a local checkout is not a deploy target.
# ---------------------------------------------------------------------------

BIND_MOUNTED_PATHS=(
    "platform/ai/litellm_config.yaml"
    "platform/auth/keycloak/hill90-realm.json"
    "platform/auth/keycloak/themes/hill90"
    "platform/data/postgres/init.sh"
    "platform/vault/secrets-schema.yaml"
)

classify_path() {
    local path="$1" p
    for p in "${BIND_MOUNTED_PATHS[@]}"; do
        case "$path" in "$p"|"$p"/*) printf 'BIND-MOUNTED (in-container now, active at next restart)'; return ;; esac
    done
    printf 'not mounted'
}

# ---------------------------------------------------------------------------
# Drift
# ---------------------------------------------------------------------------

report_drift() {
    local behind ahead
    git rev-parse --verify -q origin/main >/dev/null 2>&1 || {
        echo "  drift: origin/main not fetched — cannot determine"
        return 0
    }
    behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
    ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)

    if [ "$behind" -eq 0 ] && [ "$ahead" -eq 0 ]; then
        echo "  drift: up to date with origin/main"
        return 0
    fi

    echo ""
    echo "  ################################################################"
    if [ "$behind" -gt 0 ]; then
        echo "  # DRIFT: this checkout is ${behind} commits behind origin/main"
        echo "  #"
        echo "  # Production has been running config that differs from the"
        echo "  # repository. Commits not yet deployed:"
    fi
    if [ "$ahead" -gt 0 ]; then
        [ "$behind" -gt 0 ] && echo "  #"
        echo "  # DRIFT: this checkout is ${ahead} commits AHEAD of origin/main."
        echo "  # Those commits exist only on this host and \`git reset --hard\`"
        echo "  # will discard them. Push them before deploying."
    fi
    echo "  ################################################################"
    if [ "$behind" -gt 0 ]; then
        git --no-pager log --oneline HEAD..origin/main 2>/dev/null | sed 's/^/    /' | head -20
    fi
    if [ "$ahead" -gt 0 ]; then
        echo "    commits only on this host:"
        git --no-pager log --oneline origin/main..HEAD 2>/dev/null | sed 's/^/      /' | head -20
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "=============================================="
echo "Checkout preflight — $(pwd)"
echo "=============================================="

report_drift

if [ -z "$(git status --porcelain)" ]; then
    echo "  working tree clean — safe to reset"
    exit 0
fi

echo ""
echo "  ################################################################"
echo "  # THE WORKING TREE IS DIRTY"
echo "  #"
echo "  # \`git reset --hard\` will destroy the changes below and they are"
echo "  # NOT RECOVERABLE — unstaged changes are not git objects, so there"
echo "  # is no stash, no blob and no reflog entry to restore from."
echo "  #"
echo "  # This diff is the only record. Copy it before continuing."
echo "  ################################################################"
echo ""

echo "  Modified paths, by how live they are:"
echo ""
mounted_count=0
while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="${line:3}"
    class="$(classify_path "$path")"
    printf '    %-56s %s\n' "$path" "$class"
    case "$class" in BIND-MOUNTED*) mounted_count=$((mounted_count + 1)) ;; esac
done < <(git status --porcelain)

if [ "$mounted_count" -gt 0 ]; then
    echo ""
    echo "  *** ${mounted_count} of these are mounted into running containers. ***"
    echo "  *** The edit is already visible inside the container and becomes"
    echo "  *** active at its next restart. Resetting it is another undocumented"
    echo "  *** change, in the opposite direction, with no review."
fi

echo ""
echo "  ---------------- FULL DIFF (tracked files) ----------------"
git --no-pager diff | sed 's/^/  /'
echo "  ---------------- END DIFF ----------------"
echo ""

untracked=$(git ls-files --others --exclude-standard)
if [ -n "$untracked" ]; then
    echo "  Untracked files (git reset --hard leaves these, but they are undeployed):"
    echo "$untracked" | sed 's/^/    /'
    echo ""
fi

if [ "${ALLOW_DIRTY_CHECKOUT:-0}" = "1" ]; then
    echo "  ALLOW_DIRTY_CHECKOUT=1 — proceeding and discarding the above."
    exit 0
fi

echo "  REFUSING to continue."
echo ""
echo "  Land the change in the repository, or re-run with"
echo "  ALLOW_DIRTY_CHECKOUT=1 if you genuinely mean to discard it."
exit 1
