#!/usr/bin/env bash
# Ask Postgres to PARSE every static SQL statement in the api, without running it.
#
# WHY THIS EXISTS (#286). Two endpoints — /agents/:id/metrics and
# /agents/:id/artifacts — answered 500 on EVERY call since the day they were
# written, because their SQL named columns that do not exist: `created_at` on
# `agent_sessions`, `model` on `model_usage`. A third fault sat in the same
# statement: one parameter compared against a uuid column and a varchar column.
#
# NOTHING IN CI CAN SEE THIS, and that is the point. The api suite mocks the
# pool, so a statement never reaches a parser — a test asserting the route
# answers 200 passes just as happily with a broken column. The suite is 97 files
# and 1000+ tests; this class is invisible to all of them BY CONSTRUCTION.
#
# `PREPARE` parses and resolves identifiers and does not execute. Run against
# any database with the schema — the local stack will do.
#
# Exit codes, following check_deploy_drift.sh's contract:
#   0  every checkable statement parsed
#   1  IDENTIFIER OR TYPE ERROR in at least one statement
#   2  CANNOT DETERMINE (no database reachable)
# Statements built by interpolation are NOT checkable and are counted, never
# folded into the pass — an unchecked statement is not a passing one.
set -uo pipefail

# TWO WAYS TO REACH A DATABASE, because this runs in two places.
#
#   DATABASE_URL set  -> psql directly. This is the CI path: the workflow starts
#                        a Postgres service, applies src/db/migrations in order,
#                        and points this at it.
#   otherwise         -> docker exec into the local stack's container, which is
#                        what a developer has running.
#
# The SCHEMA COMES FROM THE MIGRATIONS in both, never from a checked-in dump. A
# dump would be a second source of truth that drifts silently, which is the
# defect this check exists to catch, one level up.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -n "${DATABASE_URL:-}" ]; then
  psql_run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=0 "$@"; }
  reachable() { psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; }
  WHERE="$DATABASE_URL"
else
  CONTAINER="${PG_CONTAINER:-hill90dev-app-postgres}"
  DB="${PG_DB:-hill90_api}"
  USER_="${PG_USER:-hill90}"
  psql_run() { docker exec -i "$CONTAINER" psql -U "$USER_" -d "$DB" "$@"; }
  reachable() { docker exec "$CONTAINER" psql -U "$USER_" -d "$DB" -c 'SELECT 1' >/dev/null 2>&1; }
  WHERE="container $CONTAINER / $DB"
fi

if ! reachable; then
  echo "CANNOT DETERMINE: no database at $WHERE"
  exit 2
fi

# EXCLUSIONS, each with the issue that removes it.
#
# An exclusion is visible debt, not a suppression: the list is printed on every
# run, and if an excluded file stops existing the check FAILS rather than
# quietly passing — an exclusion that outlives its file is a lie about what is
# covered, which is the shape this check exists to catch.
# Empty: routes/shared-knowledge.ts was excluded for #300 and no longer needs
# to be — its /graph handler now proxies to the service that owns the tables
# instead of querying its own database for them.
EXCLUDES=( )
for e in "${EXCLUDES[@]}"; do
  f="${e%%:*}"; issue="${e##*:}"
  if [ ! -f "$ROOT/services/api/src/routes/$f" ]; then
    echo "STALE EXCLUSION: routes/$f is excluded ($issue) but no longer exists"
    exit 1
  fi
  echo "EXCLUDED: routes/$f — $issue"
done

TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
node -e '
const fs=require("fs"), path=require("path");
const root=process.argv[1];
const excluded=(process.argv[3]||"").split(",").filter(Boolean);

// WALK THE TREE, do not list directories.
//
// The first version scanned `src/routes` only. That was not a short list, it
// was the WRONG KIND of list: SQL lives in five directories — routes (18
// files), services (6), db (2), helpers (1) and src itself (1) — so the gate
// covered 18 of 28 files while printing a healthy number, and a scheduler
// statement that cannot parse sat outside it.
//
// Extending the list to routes+services+helpers would have missed src/db and
// src/ for the same reason the first hole existed. A list must be maintained by
// whoever adds a directory; a walk need not be. The only exclusions are tests,
// which contain deliberately malformed SQL, and migrations, which are DDL run
// by the migration runner rather than statements this code prepares.
function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (["__tests__", "node_modules", "migrations"].includes(e.name)) continue;
      out.push(...walk(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

let checkable=0, dynamic=0, out=[], files=0;
for (const full of walk(root)) {
  if (excluded.includes(path.basename(full))) continue;
  files++;
  const src=fs.readFileSync(full,"utf8");
  // COMMENTS AND WHITESPACE BETWEEN `query(` AND THE LITERAL.
  //
  // The first version allowed only \s*, so any statement with an explanatory
  // comment above it was skipped SILENTLY — and this repository comments the
  // interesting statements, which are the ones worth checking. Documenting a
  // fix removed it from coverage: `checkable` slid 252 -> 245 while I annotated
  // the very statements this check had just found, and the positive control
  // then passed against a fault that was still in the tree.
  for (const m of src.matchAll(/query\(\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*([`\x27])([\s\S]*?)\1/g)) {
    const sql=m[2].trim();
    if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(sql)) continue;
    if (sql.includes("${")) { dynamic++; continue; }
    checkable++;
    // The trailing newline matters: a SQL line comment at the end of a
    // statement would otherwise swallow the separator and take the next
    // PREPARE with it.
    out.push(`PREPARE c${checkable} AS ${sql}\n;`);
  }
}
fs.writeFileSync(process.argv[2], out.join("\n"));
console.error(`files scanned: ${files}   checkable: ${checkable}   NOT CHECKABLE (interpolated): ${dynamic}`);
' "$ROOT/services/api/src" "$TMP" "$(IFS=,; echo "${EXCLUDES[*]%%:*}")"

OUT=$(psql_run < "$TMP" 2>&1)
ERRORS=$(printf '%s' "$OUT" | grep -c 'ERROR:' || true)

# THE CHECK CHECKS ITSELF, and this is not decoration.
#
# The first CI run of this job reported PASS with a known-broken statement in
# the tree: the batch had not run the way it does locally, no line matched the
# error pattern, and "no errors found" was indistinguishable from "nothing
# executed". That is precisely the defect this script exists to catch, in the
# script. So the count of statements Postgres CONFIRMS it prepared must equal
# the count generated — silence is not evidence.
PREPARED=$(printf '%s' "$OUT" | grep -c '^PREPARE' || true)
EXPECTED=$(grep -c '^PREPARE' "$TMP" || true)
if [ "$ERRORS" -gt 0 ]; then
  echo "IDENTIFIER OR TYPE ERRORS: $ERRORS"
  printf '%s' "$OUT" | grep -B 1 -A 1 'ERROR:' | head -60
  exit 1
fi

if [ "$PREPARED" -ne "$EXPECTED" ]; then
  echo "CANNOT DETERMINE: $EXPECTED statements were sent, $PREPARED were confirmed prepared."
  echo "The batch did not run as expected, so a clean result would mean nothing. Output:"
  printf '%s\n' "$OUT" | head -20
  exit 2
fi
echo "PASS — $PREPARED of $EXPECTED statements confirmed prepared against $WHERE"
