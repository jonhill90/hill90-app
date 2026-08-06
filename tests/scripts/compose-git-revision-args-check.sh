#!/usr/bin/env bash
#
# A deployed service whose Dockerfile accepts `ARG GIT_REVISION` must have its
# compose `build:` block pass `args: GIT_REVISION: ${DEPLOY_REVISION:-unstamped}`
# — app#558.
#
# hill90/knowledge has TWO build paths: docker-compose.knowledge.yml (this
# script's concern) and build-agentbox-images.yml (agentbox copies the akm CLI
# out of it). Only the latter passed --build-arg GIT_REVISION; the compose
# build had no `args:` at all, so the Dockerfile's `ARG GIT_REVISION=unstamped`
# default applied and the IMAGE came out labelled the literal string
# "unstamped" on every deploy, regardless of what commit built it. The
# CONTAINER label, set separately by compose `labels:`, was correctly stamped
# the whole time — which is why nobody noticed: check_deploy_drift.sh reads
# the container's label, not the image's.
#
# THE SHAPE, NOT JUST THE ONE INSTANCE. A `build:` block with no `args:` is
# not itself wrong — most of this repo's services never defined
# `ARG GIT_REVISION` in the first place, and there is nothing for `args:` to
# feed there. What's wrong is a Dockerfile that DOES define the ARG paired
# with a compose block that doesn't pass it — the two drift independently, and
# nothing catches them doing so. This check reads each deployed stack's own
# Dockerfile to decide whether it applies, rather than hardcoding a service
# list that would itself drift.
#
# WHICH FILES COUNT is read out of scripts/deploy.sh, same reasoning as the
# sibling compose-mem-limits-check.sh: a second list here would drift from the
# first, which is the exact defect this file exists to catch.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROD_DIR="${REPO_ROOT}/deploy/compose/prod"
DEPLOY_SH="${REPO_ROOT}/scripts/deploy.sh"

[ -f "$DEPLOY_SH" ] || { echo "COMPOSE_GIT_REVISION_ARGS_FAIL: cannot find scripts/deploy.sh"; exit 1; }

read_list() {
  sed -n "s/^$1=[\"']*\([^\"']*\).*/\1/p" "$DEPLOY_SH" | head -1
}
STACKS="$(read_list DEPLOY_FIRST) $(read_list DEPLOY_REST)"

# shellcheck disable=SC2086
set -- $STACKS
if [ "$#" -eq 0 ]; then
  echo "COMPOSE_GIT_REVISION_ARGS_FAIL: parsed no stacks from deploy.sh — the check would pass vacuously"
  exit 1
fi

missing=0
dockerfiles_with_arg=0
files=0

for stack in "$@"; do
  file="${PROD_DIR}/docker-compose.${stack}.yml"
  if [ ! -f "$file" ]; then
    echo "COMPOSE_GIT_REVISION_ARGS_FAIL: deploy.sh deploys '${stack}' but ${file##*/} does not exist"
    exit 1
  fi
  files=$((files + 1))
  base="$(basename "$file")"

  # This repo's own build: blocks are always `context: ../../../services/<x>`
  # with an optional `dockerfile:` override, immediately under `build:`.
  context_line="$(grep -A3 '^\s*build:' "$file" | grep 'context:' | head -1)"
  [ -n "$context_line" ] || continue  # no build: block in this file at all

  context="$(echo "$context_line" | sed 's/.*context: *//')"
  dockerfile_name="$(grep -A3 '^\s*build:' "$file" | grep 'dockerfile:' | head -1 | sed 's/.*dockerfile: *//')"
  dockerfile_name="${dockerfile_name:-Dockerfile}"
  dockerfile_path="$(cd "$(dirname "$file")" && cd "$context" && pwd)/${dockerfile_name}"

  if [ ! -f "$dockerfile_path" ]; then
    echo "COMPOSE_GIT_REVISION_ARGS_FAIL: ${base} builds from ${dockerfile_path}, which does not exist"
    exit 1
  fi

  grep -q '^ARG GIT_REVISION' "$dockerfile_path" || continue  # this service never stamps its image — nothing to check
  dockerfiles_with_arg=$((dockerfiles_with_arg + 1))

  # The build: block runs from its own line to the next line at <=4 spaces of
  # indentation (the next service property, or the next service key).
  in_build=0
  has_git_revision_arg=0
  while IFS= read -r line; do
    if [[ "$line" =~ ^\ \ \ \ build: ]]; then in_build=1; continue; fi
    if [ "$in_build" -eq 1 ]; then
      if [[ "$line" =~ ^\ \ \ \ [a-zA-Z] ]]; then break; fi  # next service property
      [[ "$line" =~ GIT_REVISION: ]] && has_git_revision_arg=1
    fi
  done < "$file"

  if [ "$has_git_revision_arg" -eq 0 ]; then
    echo "MISSING GIT_REVISION build arg: ${base} -> ${stack} (Dockerfile at ${dockerfile_path} defines ARG GIT_REVISION, compose build: block does not pass it)"
    missing=$((missing + 1))
  fi
done

if [ "$dockerfiles_with_arg" -eq 0 ]; then
  # A check that finds no Dockerfile to apply to is not evidence of health —
  # it means the check itself stopped matching anything.
  echo "COMPOSE_GIT_REVISION_ARGS_FAIL: no deployed Dockerfile defines ARG GIT_REVISION — the check has nothing to inspect"
  exit 1
fi

if [ "$missing" -gt 0 ]; then
  echo "COMPOSE_GIT_REVISION_ARGS_FAIL: ${missing} deployed service(s) whose Dockerfile stamps an image but whose compose build does not pass GIT_REVISION"
  exit 1
fi

echo "COMPOSE_GIT_REVISION_ARGS_OK: ${files} deployed stacks, ${dockerfiles_with_arg} with ARG GIT_REVISION, all passing it through compose"
