#!/usr/bin/env node
/**
 * Same defect class as services/api's verify-native-deps.js (#331):
 * `npm ci` does not fail when it loses an optional native dependency to a
 * registry hiccup, and the failure otherwise surfaces opaquely, later,
 * wherever the missing binary is first needed.
 *
 * WHICH TWO, AND WHY NOT THE OTHERS — established by running `npm test`
 * with each candidate's actual platform binary removed, one at a time, not
 * guessed from the lockfile. `services/ui`'s lockfile carries SEVEN native
 * binary families (`@esbuild`, `@rollup/rollup-*`, `@img/sharp` — pulled in
 * transitively by `next`, `@next/swc-*`, `@tailwindcss/oxide-*`,
 * `lightningcss-*`, `@unrs/resolver-binding-*`), and presence in the
 * lockfile is not the same claim as reachability from `npm test` — a check
 * for one that `vitest run` never touches is a check that can never fire,
 * the same dead shape this repository has already removed twice today.
 *
 *   REQUIRED  — removing the binary broke `npx vitest run` itself:
 *     - esbuild:  Vite bundles vite.config.ts with it before anything else
 *                 runs. `require('esbuild')` alone is LAZY and does not
 *                 touch the binary — this must actually invoke it
 *                 (`transformSync`), or the check is inert.
 *     - rollup:   required, eagerly, by Vite's own dependency chain.
 *                 `require('rollup')` alone is enough; rollup resolves its
 *                 platform binary at module-load time, and its own error
 *                 message names the identical npm bug class this guards:
 *                 "npm has a bug related to optional dependencies"
 *                 (https://github.com/npm/cli/issues/4828).
 *
 *   NOT REQUIRED — removed, `npx vitest run` still passed 89/89, 939/946,
 *   unchanged:
 *     - @next/swc:  Next's own compiler; `vitest run` never starts Next's
 *                   build or dev server.
 *     - sharp:      pulled in by `next` for next/image's server-side
 *                   optimizer, never invoked by a jsdom component test.
 *     - @tailwindcss/oxide, lightningcss:  Tailwind v4's CSS engine; no
 *                   test file here routes a stylesheet through it.
 *     - @unrs/resolver-binding:  used by eslint's import resolver
 *                   (`eslint .`), a separate CI job from this one.
 *
 * Re-run this reachability sweep if any of those five ever becomes
 * genuinely exercised by a test — the boundary is empirical, not fixed.
 */

let failed = false;

try {
  require('rollup');
} catch (err) {
  failed = true;
  console.error(`::error::npm ci reported success but 'rollup' cannot load its native binary.`);
  console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
}

try {
  require('esbuild').transformSync('1+1');
} catch (err) {
  failed = true;
  console.error(`::error::npm ci reported success but 'esbuild' cannot run its native binary.`);
  console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
}

if (failed) {
  console.error(
    `::error::This is npm silently dropping an optional native dependency during ` +
    `install (see verify-native-deps.js), not a defect in rollup, esbuild, or ` +
    `whatever test happens to import them. Re-run the install.`,
  );
  process.exit(1);
}

console.log('native dependency check: esbuild, rollup both loaded');
