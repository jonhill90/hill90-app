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
CONTAINER="${PG_CONTAINER:-hill90dev-app-postgres}"
DB="${PG_DB:-hill90_api}"
USER_="${PG_USER:-hill90}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

docker exec "$CONTAINER" psql -U "$USER_" -d "$DB" -c 'SELECT 1' >/dev/null 2>&1 || {
  echo "CANNOT DETERMINE: no database in container '$CONTAINER' — start the local stack"
  exit 2
}

TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
node -e '
const fs=require("fs"), path=require("path");
const dir=process.argv[1];
let checkable=0, dynamic=0, out=[];
for (const f of fs.readdirSync(dir).filter(f=>f.endsWith(".ts"))) {
  const src=fs.readFileSync(path.join(dir,f),"utf8");
  for (const m of src.matchAll(/query\(\s*([`\x27])([\s\S]*?)\1/g)) {
    const sql=m[2].trim();
    if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(sql)) continue;
    if (sql.includes("${")) { dynamic++; continue; }
    checkable++;
    out.push(`PREPARE c${checkable} AS ${sql};`);
  }
}
fs.writeFileSync(process.argv[2], out.join("\n"));
console.error(`checkable: ${checkable}   NOT CHECKABLE (interpolated): ${dynamic}`);
' "$ROOT/services/api/src/routes" "$TMP"

ERRORS=$(docker exec -i "$CONTAINER" psql -U "$USER_" -d "$DB" < "$TMP" 2>&1 | grep -c '^ERROR' || true)
if [ "$ERRORS" -gt 0 ]; then
  echo "IDENTIFIER OR TYPE ERRORS: $ERRORS"
  docker exec -i "$CONTAINER" psql -U "$USER_" -d "$DB" < "$TMP" 2>&1 | grep -A 1 '^ERROR' | head -40
  exit 1
fi
echo "PASS — every checkable statement parsed against $DB"
