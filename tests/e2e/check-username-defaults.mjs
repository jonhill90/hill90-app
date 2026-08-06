#!/usr/bin/env node
/**
 * app#514's positive control: does any authenticated tests/e2e/*.spec.ts
 * file resolve E2E_USERNAME to something other than the designated test
 * account when a human sets ONLY E2E_PASSWORD — the single obvious act of
 * "turning the tests on"?
 *
 * WHY THIS DOESN'T JUST ASSERT "THE SPECS SKIP TODAY". They already skip
 * today (test.skip(!E2E_PASSWORD, ...) is true whenever E2E_PASSWORD is
 * unset), so that assertion would pass against the broken files too and
 * prove nothing about the actual defect. The defect is that the skip
 * condition and the username default are independent: the guard keys on
 * the PASSWORD, so setting only E2E_PASSWORD arms a spec whose username
 * silently resolved to a real production account (jon / jon@hill90.com),
 * not the estate's designated test account (testuser01).
 *
 * So this simulates exactly that scenario — E2E_PASSWORD set,
 * E2E_USERNAME left unset — against the REAL, EXTRACTED source lines from
 * each spec file (via node:vm, not a hand-copied reimplementation of the
 * logic), and asserts that either the spec would skip, or the username it
 * would actually use is the designated test account. A spec that resolves
 * to any other identity while NOT skipping is a finding.
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DESIGNATED_TEST_ACCOUNT = "testuser01";

// The eight specs that carry a test.skip(...) auth guard at all. smoke.spec.ts
// and auth-theme.spec.ts need no credentials and are out of scope.
const SPECS = [
  "chat.spec.ts",
  "agent-chat-flow.spec.ts",
  "secrets.spec.ts",
  "workflows.spec.ts",
  "mcp-servers.spec.ts",
  "library-search.spec.ts",
  "topbar-features.spec.ts",
  "storage-upload.spec.ts",
];

const USERNAME_LINE = /^const E2E_USERNAME\s*=.*;$/m;
const PASSWORD_LINE = /^const E2E_PASSWORD\s*=.*;$/m;
const SKIP_CONDITION = /test\.skip\(\s*([\s\S]+?),\s*"/;

function extract(source, pattern, label, file, group = 0) {
  const m = source.match(pattern);
  if (!m) {
    throw new Error(`${file}: could not find ${label} — extraction pattern is stale, fix the regex, not the assertion`);
  }
  return m[group];
}

function resolveUnder(file, env) {
  const path = join(__dirname, file);
  const source = readFileSync(path, "utf8");

  const usernameStmt = extract(source, USERNAME_LINE, "the E2E_USERNAME assignment", file);
  const passwordStmt = extract(source, PASSWORD_LINE, "the E2E_PASSWORD assignment", file);
  const skipCondExpr = extract(source, SKIP_CONDITION, "the test.skip(...) condition", file, 1);

  const sandbox = { process: { env }, result: undefined };

  runInNewContext(
    `${usernameStmt}\n${passwordStmt}\nresult = { E2E_USERNAME, E2E_PASSWORD, willSkip: Boolean(${skipCondExpr}) };`,
    sandbox
  );

  return sandbox.result;
}

let failures = [];

for (const file of SPECS) {
  // THE ASSERTION THAT MATTERS: the scenario this whole finding is about
  // — a human sets ONLY the password (the one obvious act of "turning the
  // tests on") and never touches E2E_USERNAME.
  const passwordOnly = resolveUnder(file, { E2E_PASSWORD: "a-real-password-someone-set" });
  const safe = passwordOnly.willSkip || passwordOnly.E2E_USERNAME === DESIGNATED_TEST_ACCOUNT;
  if (!safe) {
    failures.push(
      `  - ${file}: setting only E2E_PASSWORD does NOT skip, and resolves ` +
      `E2E_USERNAME to "${passwordOnly.E2E_USERNAME}" — not "${DESIGNATED_TEST_ACCOUNT}"`
    );
  }

  // CONTROL: the fix must not over-correct into a permanent skip. With
  // BOTH vars explicitly set to the real designated account, the suite
  // must actually run — a check that only ever proves "it skips more" is
  // as vacuous, in the other direction, as one that never fires.
  const bothSet = resolveUnder(file, {
    E2E_USERNAME: DESIGNATED_TEST_ACCOUNT,
    E2E_PASSWORD: "a-real-password-someone-set",
  });
  if (bothSet.willSkip) {
    failures.push(
      `  - ${file}: CONTROL FAILED — skips even when both E2E_USERNAME=` +
      `"${DESIGNATED_TEST_ACCOUNT}" and E2E_PASSWORD are explicitly set`
    );
  } else if (bothSet.E2E_USERNAME !== DESIGNATED_TEST_ACCOUNT) {
    failures.push(
      `  - ${file}: CONTROL FAILED — explicit E2E_USERNAME=` +
      `"${DESIGNATED_TEST_ACCOUNT}" was overridden to "${bothSet.E2E_USERNAME}"`
    );
  }
}

if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} problem(s):\n`);
  console.error(failures.join("\n"));
  console.error(
    `\nEach spec must skip unless BOTH E2E_USERNAME and E2E_PASSWORD are ` +
    `explicitly set, with no default for either, and must actually run ` +
    `(not skip) once both are set.`
  );
  process.exit(1);
}

console.log(
  `PASS — all ${SPECS.length} specs skip when E2E_USERNAME is unset, and ` +
  `all ${SPECS.length} actually run as "${DESIGNATED_TEST_ACCOUNT}" when ` +
  `both vars are explicitly set.`
);
process.exit(0);
