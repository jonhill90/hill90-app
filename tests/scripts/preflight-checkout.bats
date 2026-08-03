#!/usr/bin/env bats

# Tests for scripts/preflight-checkout.sh
#
# Why this guard exists. /opt/hill90-app is a deploy target that people hand-edit,
# and reusable-deploy-service.yml runs `git reset --hard origin/main` on it, so a
# local edit there is destroyed silently — unstaged changes are never written to
# git's object database, so there is no blob, no stash and no reflog entry to
# recover from. Hill90 hit exactly that on 2026-07-29 and the content is gone.
#
# The tenant differs from Hill90 in one way that matters, established by Hill90's
# own assessment (#565): NOTHING in this repository is bind-mounted with
# `watch: true`. There is no Traefik file provider here. So this guard deliberately
# has no LIVE (WATCHED) tier — a tier that never fires trains people to ignore the
# output. The lost-edits hazard is the same; the live-config hazard is not present.
#
# These run against throwaway git repos. No VPS.

setup() {
  REPO="$BATS_TEST_TMPDIR/checkout"
  ORIGIN="$BATS_TEST_TMPDIR/origin.git"
  git init -q --bare "$ORIGIN"
  # Point the bare repo's HEAD at main. Without this `git clone` warns "remote
  # HEAD refers to nonexistent ref" and checks out an empty tree, which broke
  # the BEHIND-drift test in a way that looked like a script bug.
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  git init -q "$REPO"
  cd "$REPO"
  git config user.email t@t; git config user.name t
  mkdir -p docs platform/auth/keycloak platform/data/postgres
  echo "doc" > docs/readme.md
  echo '{"realm":"hill90"}' > platform/auth/keycloak/hill90-realm.json
  echo "#!/bin/sh" > platform/data/postgres/init.sh
  git add -A && git commit -qm init
  git remote add origin "$ORIGIN" && git push -q origin HEAD:main
  git fetch -q origin
  PF="$BATS_TEST_DIRNAME/../../scripts/preflight-checkout.sh"
}

@test "preflight passes on a clean tree" {
  run bash "$PF"
  [ "$status" -eq 0 ]
}

@test "preflight REFUSES when the tree is dirty" {
  echo "hand edit" >> docs/readme.md
  run bash "$PF"
  [ "$status" -eq 1 ]
  # Asserting the message as well as the status: a missing script also exits
  # non-zero (127), so `status -ne 0` alone passes when there is no script at all.
  [[ "$output" == *"REFUSING"* ]]
}

@test "preflight PRINTS THE FULL DIFF — the only record of the hand-edit" {
  echo "MAGIC_HAND_EDIT_MARKER" >> docs/readme.md
  run bash "$PF"
  [[ "$output" == *"MAGIC_HAND_EDIT_MARKER"* ]]
}

@test "a dirty bind-mounted path is distinguished from an ordinary one" {
  echo '{"realm":"edited"}' > platform/auth/keycloak/hill90-realm.json
  run bash "$PF"
  [ "$status" -ne 0 ]
  [[ "$output" == *"BIND-MOUNTED"* ]]
  [[ "$output" == *"hill90-realm.json"* ]]
}

@test "a dirty docs-only path is NOT labelled bind-mounted" {
  echo "hand edit" >> docs/readme.md
  run bash "$PF"
  [[ "$output" == *"not mounted"* ]]
  [[ "$output" != *"BIND-MOUNTED"* ]]
}

@test "there is no LIVE or WATCHED tier — nothing here is watched" {
  # Per Hill90 #565: the tenant has no Traefik file provider and nothing mounted
  # with watch: true. A tier that can never fire should not be in the output.
  echo '{"realm":"edited"}' > platform/auth/keycloak/hill90-realm.json
  run bash "$PF"
  # Positive anchor first. A test made only of negative assertions passes when the
  # script produces no output at all, including when it does not exist.
  [[ "$output" == *"BIND-MOUNTED"* ]]
  [[ "$output" != *"WATCHED"* ]]
  [[ "$output" != *"LIVE ("* ]]
}

@test "ALLOW_DIRTY_CHECKOUT=1 overrides the refusal but still prints the diff" {
  echo "OVERRIDE_MARKER" >> docs/readme.md
  ALLOW_DIRTY_CHECKOUT=1 run bash "$PF"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OVERRIDE_MARKER"* ]]
}

@test "preflight reports being up to date with origin/main" {
  run bash "$PF"
  [ "$status" -eq 0 ]
  [[ "$output" == *"up to date"* ]]
}

@test "drift wording is correct when only BEHIND origin/main" {
  # A second clone pushes a commit, so this checkout falls behind.
  other="$BATS_TEST_TMPDIR/other"
  git clone -q "$ORIGIN" "$other"
  (cd "$other" && git config user.email t@t && git config user.name t \
     && echo more >> docs/readme.md && git commit -qam second && git push -q origin HEAD:main)
  git fetch -q origin

  run bash "$PF"
  [ "$status" -eq 0 ]
  [[ "$output" == *"1 commits behind"* ]]
  [[ "$output" != *"AHEAD"* ]]
}

@test "drift wording is correct when only AHEAD of origin/main" {
  echo local-only >> docs/readme.md
  git commit -qam "only on this host"

  run bash "$PF"
  [[ "$output" == *"AHEAD"* ]]
  [[ "$output" == *"discard"* ]]
  [[ "$output" != *"commits behind"* ]]
}

@test "an untracked file is reported — reset leaves it, but it is undeployed" {
  echo "scratch" > platform/auth/keycloak/UNTRACKED_MARKER.json
  run bash "$PF"
  [[ "$output" == *"UNTRACKED_MARKER"* ]]
}

@test "the deploy path calls the preflight before git reset --hard" {
  cd "$BATS_TEST_DIRNAME/../.."
  run grep -q "preflight-checkout.sh" .github/workflows/reusable-deploy-service.yml
  [ "$status" -eq 0 ]

  # And it must come BEFORE the reset, or it guards nothing.
  #
  # THIS COMPARES STEP NAMES, not occurrences of the words. Two earlier versions
  # compared line numbers of text and both were dead:
  #
  #   v1 matched the literal "reset --hard origin/main". When the deploy moved to
  #      pinning a SHA the only match left was a COMMENT about the old form.
  #   v2 matched "git reset --hard" outside comments — and picked up
  #      "[ ] git fetch / git reset --hard on the VPS checkout", a line of the
  #      dry-run SUMMARY. Being last in the file, it made the comparison true no
  #      matter where the preflight sat. Its control did not fire.
  #
  # A step name is the thing that actually orders execution, so that is what is
  # asserted. The control below moves the step and must fail.
  local wf=.github/workflows/reusable-deploy-service.yml
  pf_line=$(grep -n '^      - name: Checkout preflight' "$wf" | head -1 | cut -d: -f1)
  deploy_line=$(grep -n '^      - name: Deploy \${{ inputs.service }}' "$wf" | head -1 | cut -d: -f1)

  [ -n "$pf_line" ]
  [ -n "$deploy_line" ]
  [ "$pf_line" -lt "$deploy_line" ]

  # And the deploy step is still the thing that resets, so the ordering matters.
  awk -v a="$deploy_line" 'NR>=a && NR<=a+20' "$wf" | grep -q "git reset --hard"
}

@test "the bind-mount list matches the prod compose files it is derived from" {
  cd "$BATS_TEST_DIRNAME/../.."

  # Every ../../../ bind mount in deploy/compose/prod must be classified by the
  # script, or the guard silently stops covering a mounted path when compose
  # changes. This is the drift check, not a copy of the list.
  while IFS= read -r host; do
    rel="${host#../../../}"
    grep -qF "$rel" scripts/preflight-checkout.sh \
      || { echo "prod compose mounts '$rel' but preflight-checkout.sh does not list it"; return 1; }
  done < <(grep -rhoE '^[[:space:]]+- \.\./\.\./\.\./[^:]+' deploy/compose/prod/*.yml \
           | sed -E 's/^[[:space:]]+- //' | sort -u)
}

# ---------------------------------------------------------------------------
# The missing-preflight message must survive four levels of parsing.
#
# This property is ported from Hill90 #40. It belongs here because THIS is where
# its absence did damage: #35 added the existence check with an escaped
# double-quoted example command inside the message —
#
#     Run: ssh deploy@<host> \\"cd ${VPS_APP_PATH} && git pull\\"
#
# which passes through YAML, the runner's shell, the ssh argument, and finally the
# remote shell. The escaped quotes came apart on the last one and the remote bash
# died with `unexpected EOF while looking for matching quote` before running
# anything. Both api and mcp deploys failed that way: a guard added to make deploys
# safer prevented them entirely. #42 fixed the message.
#
# The quotes were BALANCED, which is why it reads as correct on inspection. Depth of
# nesting was the defect, not pairing — so the only reliable property is that the
# message contains no quote character at all.
#
# When the same pattern was ported to Hill90 this was made a tested property there
# and not here. That gap is what these tests close.
# ---------------------------------------------------------------------------

# The three tests that used to sit here asserted properties of the
# "preflight-checkout.sh is missing from the VPS checkout" message: no double
# quote, no backslash, and that it still named `git pull` as the remedy.
#
# That message is gone. The workflow no longer runs the host's copy of the
# preflight — it pipes this repository's copy over ssh with `bash -s` — so the
# script cannot be missing from the host, and there is no remedy to name. The
# message was removed with the guard it belonged to, not because the lesson
# expired.
#
# THE LESSON IS STILL TESTED, and by tests that fire against the workflow as it
# stands rather than against one deleted string:
#
#   - "the remote payload the workflow sends parses as shell" — the property the
#     original failure actually violated;
#   - "no ::error:: message in the deploy workflow carries a backslash escape" —
#     the generalised form of the three tests removed here.
#
# Deleting a test whose subject no longer exists is correct. Deleting one whose
# subject still exists is how a suite quietly stops checking.

repo_root() { cd "${BATS_TEST_DIRNAME}/../.." && pwd; }

@test "the remote payload the workflow sends parses as shell" {
  # The real property, tested the way the failure actually presented: extract the
  # remote command the ssh step sends and ask bash to parse it.
  cd "$(repo_root)"
  payload="$(awk '/^ *"cd \$\{VPS_APP_PATH\}/,/deploy\.sh/' \
              .github/workflows/reusable-deploy-service.yml \
             | sed 's/\\$//' | tr -d '\n')"
  [ -n "$payload" ]
  run bash -n <<< "$payload"
  [ "$status" -eq 0 ]
}

@test "no ::error:: message in the deploy workflow carries a backslash escape" {
  # Generalised: every message this workflow echoes crosses the same boundaries, so
  # the property is not specific to the preflight one.
  #
  # The first version of this test extracted each message with `::error::[^\']*`,
  # which runs past the end of a DOUBLE-quoted message to the next single quote and
  # swept up `"; exit 1; \` from the unhealthy-containers check. It reported a
  # finding that was an artefact of its own extraction. Messages are quoted both
  # ways here, so the terminator has to be either quote character.
  cd "$(repo_root)"
  offenders=0
  while IFS= read -r msg; do
    case "$msg" in
      *'\'*) offenders=$((offenders+1)); echo "backslash in: ${msg:0:70}" ;;
    esac
  done < <(grep -o -- "::error::[^'\"]*" .github/workflows/reusable-deploy-service.yml)
  [ "$offenders" -eq 0 ]
}
