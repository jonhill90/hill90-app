#!/usr/bin/env node
/**
 * `npm ci` does not fail when an optional native dependency is lost to a
 * registry hiccup — `optionalDependencies` exist specifically so a platform
 * that does not need a binary can skip it without failing the install, and
 * npm's exit code cannot distinguish "skipped, wrong platform" from
 * "attempted, lost the fetch" (see the incident this guards, #329: 862
 * packages installed instead of 863 from an identical lockfile, a ~102s
 * silent stall in `npm ci`'s own output immediately before the summary
 * line, and `sharp` unloadable five suites later with an
 * ERR_DLOPEN_FAILED naming a missing `.so` — a crash that said nothing
 * about installation, in suites that have nothing to do with images).
 *
 * WHY THIS IS A SCRIPT AND NOT AN npm FLAG. There is no `npm ci` option that
 * turns a lost optional dependency into a failed install — that would defeat
 * the entire purpose of `optionalDependencies`, which is to let platforms
 * that do not need a binary (a Windows dev machine does not need
 * `@img/sharp-linux-x64`) skip it without erroring. Patching that behaviour
 * globally would make every genuinely-inapplicable optional package fatal
 * everywhere, on every platform. The fix has to be "did the ones THIS
 * platform needs actually load", which only the runtime can answer — hence a
 * script that requires the module, not a flag that changes how npm installs
 * it.
 *
 * Runs immediately after `npm ci`, before anything else, so a lost optional
 * native dependency fails HERE — once, with a message naming the cause —
 * instead of opaquely, later, in whichever suite happens to import it first.
 */
const modules = ['sharp'];

let failed = false;
for (const name of modules) {
  try {
    require(name);
  } catch (err) {
    failed = true;
    console.error(`::error::npm ci reported success but '${name}' cannot load its native binary.`);
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    console.error(
      `::error::This is npm silently dropping an optional native dependency during install ` +
      `(see verify-native-deps.js), not a defect in '${name}' or in whatever test happens to ` +
      `import it. Re-run the install.`,
    );
  }
}

if (failed) process.exit(1);
console.log(`native dependency check: ${modules.join(', ')} all loaded`);
