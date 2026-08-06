#!/usr/bin/env bats
#
# app#565. check-test-module-scope.js used to skip worktrees by a single
# literal directory NAME ('.worktrees'), so a second real convention for
# agent worktrees — .claude/worktrees/<branch>/, a full checkout of another
# branch living inside this tree — was never matched. The check descended
# into it and FAILed on a clean tree with no mutation at all, over files
# that exist on no branch under test.
#
# Fixed by asking git itself (`git worktree list --porcelain`) for the
# authoritative set of worktree paths instead of guessing directory names —
# see the fix's own comment for why a gitignore-keyed skip was considered
# and rejected (it would also hide a genuinely untracked NEW test file).
#
# BOTH ARMS matter equally, because a skip rule that is too BROAD silences a
# real hit while looking green — worse than the original bug. This file
# proves both directions with real planted files, not by reasoning about
# the code.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  CHECK="${REPO_ROOT}/scripts/check-test-module-scope.js"
  PLANTED_COLLISION_DIR="${REPO_ROOT}/services/api/src/__tests__/zz_565_bats_control"
  WORKTREE_DIR="${REPO_ROOT}/.claude/worktrees/zz-565-bats-control"
}

teardown() {
  rm -rf "$PLANTED_COLLISION_DIR"
  if [ -d "$WORKTREE_DIR" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
  fi
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}

@test "a real collision in a normal source directory is still caught" {
  mkdir -p "$PLANTED_COLLISION_DIR"
  cat > "$PLANTED_COLLISION_DIR/zz-collide-a.test.ts" <<'EOF'
const ZZ_565_BATS_COLLIDE = 1;
test('a', () => { expect(ZZ_565_BATS_COLLIDE).toBe(1); });
EOF
  cat > "$PLANTED_COLLISION_DIR/zz-collide-b.test.ts" <<'EOF'
const ZZ_565_BATS_COLLIDE = 2;
test('b', () => { expect(ZZ_565_BATS_COLLIDE).toBe(2); });
EOF

  run node "$CHECK"

  # Assert WHERE the planted files landed and were reported, not just that
  # something failed — a check that fails for any reason would pass this
  # test as loosely written.
  [ "$status" -eq 1 ]
  [[ "$output" == *"zz_565_bats_control/zz-collide-a.test.ts"* ]]
  [[ "$output" == *"zz_565_bats_control/zz-collide-b.test.ts"* ]]
}

@test "a real git worktree inside this tree, colliding-named test files and all, is skipped" {
  git -C "$REPO_ROOT" worktree add --detach --quiet "$WORKTREE_DIR" HEAD

  mkdir -p "$WORKTREE_DIR/services/api/src/__tests__/zz_565_inside_worktree"
  cat > "$WORKTREE_DIR/services/api/src/__tests__/zz_565_inside_worktree/zz-collide-a.test.ts" <<'EOF'
const ZZ_565_WORKTREE_COLLIDE = 1;
test('a', () => { expect(ZZ_565_WORKTREE_COLLIDE).toBe(1); });
EOF
  cat > "$WORKTREE_DIR/services/api/src/__tests__/zz_565_inside_worktree/zz-collide-b.test.ts" <<'EOF'
const ZZ_565_WORKTREE_COLLIDE = 2;
test('b', () => { expect(ZZ_565_WORKTREE_COLLIDE).toBe(2); });
EOF

  run node "$CHECK"

  # A worktree lands at .claude/worktrees/<name> here, same convention as
  # app#565's own repro — this is the exact shape that used to FAIL clean.
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
  [[ "$output" != *"zz_565_inside_worktree"* ]]
}
