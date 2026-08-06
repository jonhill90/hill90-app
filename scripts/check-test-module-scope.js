#!/usr/bin/env node
/**
 * Every test file must be a MODULE, not a global script.
 *
 * THE DEFECT, twice now. TypeScript treats a file with no top-level `import`
 * or `export` as a script, so its top-level `const`s go into the GLOBAL scope.
 * Two such files declaring the same name is TS2451 — "Cannot redeclare
 * block-scoped variable" — and it fails the whole jest run, not just the two
 * files involved.
 *
 *   - a duplicate `OLD_ENV` did this once already (three CI failures, per the
 *     archive read in #350)
 *   - `workflow-scheduler-error-recording-guard.test.ts` (#465) and
 *     `workflow-scheduler-run.test.ts` both declared `mockQuery` and
 *     `WORKFLOW`, and turned `main` red on 2026-08-05
 *
 * The second one is why this exists rather than a third rename. The collision
 * is not between the NAMES — `mockQuery` is a reasonable name for a mocked
 * query in any scheduler test — it is between the file SCOPES. Fix the scope
 * once and the names stop mattering.
 *
 * WHY THIS AND NOT `tsc --noEmit`. The repo's tsconfig does not put these
 * files in one program, so the project typecheck passes while ts-jest's own
 * compilation fails — which is exactly how this reached `main` with green
 * checks on the PR that introduced it. This check looks at the files
 * directly and does not depend on which program includes them.
 *
 * Exit 0 clean, 1 on a violation, 2 CANNOT DETERMINE — the last so that
 * pointing this at an empty or moved directory reports blindness rather than
 * a clean run over nothing.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// REPO-WIDE, not services/api only. This started life guarding one service,
// which was the sibling-drift shape it exists to prevent, applied to itself.
//
// services/ui is exposed MORE than services/api was, not less, and that is
// measured rather than assumed: its tsconfig includes '**/*.ts'/'**/*.tsx'
// with only node_modules excluded, so test files are inside `next build`'s
// type program, and next.config.ts sets no `typescript.ignoreBuildErrors`.
// Two colliding ui test files therefore break the PRODUCTION IMAGE BUILD on
// the deploy path — not a test job. Demonstrated by planting a collision and
// running ui's own typecheck:
//
//   src/__tests__/zz-collide-a.test.ts(1,7): error TS2451: Cannot redeclare
//   src/__tests__/zz-collide-b.test.ts(1,7): error TS2451: Cannot redeclare
//
// vitest itself would NOT catch it — esbuild strips types per file and never
// builds a cross-file program — so ui's first sight of the fault is the build.
const REPO_ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.worktrees']);

/**
 * app#565. This used to be a single hardcoded name, '.worktrees' — but a
 * SECOND agent-worktree convention, `.claude/worktrees/<branch>/`, walks in
 * under '.claude', not '.worktrees', so the name-based skip never matched it.
 * The check descended into other branches' full checkouts and reported their
 * files as FAILing on main, on a clean tree, before anything was mutated.
 *
 * THE RULE CHOSEN, AND THE ONE REJECTED. Adding '.claude' to SKIP would have
 * "fixed" this specific convention while leaving the check exactly as
 * fragile against a third one — any future `git worktree add <anywhere>`
 * breaks it again the same way, and '.claude' is too broad besides: it holds
 * more than worktrees. The other option was skipping whatever `git` itself
 * ignores, which was rejected on purpose — a gitignore-keyed skip would also
 * silently skip a genuinely untracked NEW test file a developer just
 * created and hasn't `git add`ed yet, which is exactly the file this check
 * most needs to still catch. `git worktree list` has neither problem: it is
 * git's own authoritative registry of what a worktree IS, regardless of
 * where it lives or what convention named it, and it says nothing about
 * what is tracked or ignored.
 *
 * Failure is non-fatal by design — this check runs in CI too, where a fresh
 * checkout normally has no linked worktrees at all, and a `git` failure here
 * must not turn an unrelated environment problem into a false FAIL against
 * files that were never the issue.
 */
function linkedWorktreeRelativePaths(repoRoot) {
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (err) {
    console.error(
      `WARNING — 'git worktree list' failed (${err.message}); linked worktrees ` +
        'inside this tree will not be skipped this run.',
    );
    return [];
  }

  const relPaths = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const resolved = path.resolve(line.slice('worktree '.length).trim());
    if (resolved === repoRoot) continue; // the primary checkout — the tree under test, never skip it
    const rel = path.relative(repoRoot, resolved);
    // Worktrees git lists that live outside this tree (elsewhere on disk, a
    // common pattern this session) are never reachable by walk() anyway —
    // only ones INSIDE repoRoot need excluding.
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relPaths.push(rel);
  }
  return relPaths;
}

const WORKTREE_SKIP_PATHS = new Set(linkedWorktreeRelativePaths(REPO_ROOT));

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      if (WORKTREE_SKIP_PATHS.has(path.relative(REPO_ROOT, p))) continue;
      out.push(...walk(p));
    } else if (/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

if (!fs.existsSync(REPO_ROOT)) {
  console.error(`CANNOT DETERMINE — ${REPO_ROOT} does not exist`);
  process.exit(2);
}

const files = walk(REPO_ROOT);
if (files.length === 0) {
  console.error(
    'CANNOT DETERMINE — found zero *.test.ts(x) / *.spec.ts(x) files in the ' +
      'repository. Either the test layout moved and this check is looking at ' +
      'nothing, or something is wrong with the checkout. Not reporting a clean ' +
      'run over an empty set.',
  );
  process.exit(2);
}

// A top-level import/export — not one indented inside a block, and not the
// `import()` expression form, which does NOT make a file a module.
const TOP_LEVEL_MODULE_MARKER = /^(import\s|export\s|import\{|export\{)/m;

const offenders = files.filter((f) => !TOP_LEVEL_MODULE_MARKER.test(fs.readFileSync(f, 'utf8')));

if (offenders.length > 0) {
  console.error('FAIL — these test files are global scripts, not modules:\n');
  for (const f of offenders) console.error(`      ${path.relative(process.cwd(), f)}`);
  console.error(`
  A test file with no top-level 'import' or 'export' puts its top-level
  declarations in the GLOBAL scope. The moment two such files pick the same
  name — mockQuery, WORKFLOW, OLD_ENV — TypeScript raises TS2451 and the
  whole jest run fails, naming files that did nothing wrong.

  Fix: add 'export {}' at the top of the file. That is the entire change.
`);
  process.exit(1);
}

console.log(`PASS — all ${files.length} TypeScript test files across the repo are modules; no global-scope collisions possible.`);
