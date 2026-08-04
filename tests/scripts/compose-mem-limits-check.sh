#!/usr/bin/env bash
#
# Every service in a DEPLOYED prod compose file must declare a mem_limit.
#
# This is a tenant on a host shared with the platform, and the OOM killer does
# not respect tenancy boundaries — an unbounded app container can starve the
# Postgres and Keycloak this app consumes, breaking the contract that says the
# platform provides identity and data (#144).
#
# It guards the CLASS, not the three services fixed alongside it. `api` came to
# differ from its neighbours by drift: a limit was thought about for ai,
# litellm, knowledge and even the 128 MB docker-proxy sidecar, and the service
# that reads agent logs and holds SSE streams open got none. Nothing noticed,
# because nothing looked.
#
# WHICH FILES COUNT is read out of scripts/deploy.sh rather than listed here.
# A second list would drift from the first, which is the same defect this file
# exists to catch. Retiring a stack removes it from DEPLOY_ORDER and it stops
# being checked, automatically and in one place.
#
# Deliberately NOT covered:
#   - docker-compose.agentbox-images.yml — build targets, not running services
#     (no container_name, no networks). The agent containers built from those
#     images DO get a ceiling, applied per-agent at create time from the DB:
#     services/api/src/services/docker.ts:135 sets `Memory` from the agent's
#     own mem_limit column. A compose-level limit there would bound nothing.
#   - docker-compose.discord-bot.yml — not in DEPLOY_ORDER, so not live surface.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROD_DIR="${REPO_ROOT}/deploy/compose/prod"
DEPLOY_SH="${REPO_ROOT}/scripts/deploy.sh"

[ -f "$DEPLOY_SH" ] || { echo "COMPOSE_MEM_LIMITS_FAIL: cannot find scripts/deploy.sh"; exit 1; }

# Read the deployer's own stack lists. Quoting varies, so strip it.
#
# `[\"']*` rather than `[\"']\?`: BSD sed does not support \? in a basic regex,
# so the \? form parsed nothing on macOS while working on the GNU sed in CI —
# a check that silently inspects zero stacks and reports success. The vacuous
# -inspection guard below caught it locally, which is the only reason this is a
# comment rather than a green check that tested nothing.
read_list() {
  sed -n "s/^$1=[\"']*\([^\"']*\).*/\1/p" "$DEPLOY_SH" | head -1
}
STACKS="$(read_list DEPLOY_FIRST) $(read_list DEPLOY_REST)"

# shellcheck disable=SC2086
set -- $STACKS
if [ "$#" -eq 0 ]; then
  echo "COMPOSE_MEM_LIMITS_FAIL: parsed no stacks from deploy.sh — the check would pass vacuously"
  exit 1
fi

missing=0
checked=0
files=0

for stack in "$@"; do
  file="${PROD_DIR}/docker-compose.${stack}.yml"
  if [ ! -f "$file" ]; then
    echo "COMPOSE_MEM_LIMITS_FAIL: deploy.sh deploys '${stack}' but ${file##*/} does not exist"
    exit 1
  fi
  files=$((files + 1))
  base="$(basename "$file")"

  # Service keys sit at exactly two spaces under `services:`; anything deeper is
  # a property. Parsed with the shell rather than a YAML library so the runner
  # needs no extra dependency — same reason as the sibling mount check.
  in_services=0
  current=""
  has_limit=0

  flush() {
    if [ -n "$current" ] && [ "$has_limit" -eq 0 ]; then
      echo "MISSING mem_limit: ${base} -> ${current}"
      missing=$((missing + 1))
    fi
  }

  while IFS= read -r line; do
    if [[ "$line" =~ ^services: ]]; then in_services=1; continue; fi
    [ "$in_services" -eq 1 ] || continue
    if [[ "$line" =~ ^[a-zA-Z] ]]; then flush; current=""; in_services=0; continue; fi

    if [[ "$line" =~ ^\ \ ([a-zA-Z0-9_-]+): ]]; then
      flush
      current="${BASH_REMATCH[1]}"
      has_limit=0
      checked=$((checked + 1))
      continue
    fi

    [[ "$line" =~ ^\ \ \ \ mem_limit: ]] && has_limit=1
  done < "$file"

  flush
done

if [ "$checked" -eq 0 ]; then
  # A check that inspects nothing passes for the wrong reason and looks exactly
  # like health — the failure this repo keeps finding one layer down.
  echo "COMPOSE_MEM_LIMITS_FAIL: no services were inspected at all"
  exit 1
fi

if [ "$missing" -gt 0 ]; then
  echo "COMPOSE_MEM_LIMITS_FAIL: ${missing} deployed service(s) without a mem_limit"
  exit 1
fi

echo "COMPOSE_MEM_LIMITS_OK: ${files} deployed stacks, ${checked} services, all with a mem_limit"
