// Next 16 removed the `next lint` subcommand, so linting is plain ESLint against
// this config. `npm run lint` invokes `eslint .`.
//
// TWO THINGS HAD TO BE FIXED BEFORE THIS COULD RUN AT ALL.
//
// 1. The previous version pulled the Next configs in through FlatCompat, which
//    is the shim for consuming OLD eslintrc-style shareable configs from a flat
//    config. eslint-config-next 16 already ships native flat configs, so routing
//    it through the compat layer made ESLint fail before linting a single file:
//
//      TypeError: Converting circular structure to JSON
//          --- property 'react' closes the circle
//
//    Importing the flat configs directly is the supported path; each subpath
//    export is an array of flat config objects, so they spread.
//
// 2. package.json pinned eslint 10.0.0, which is ahead of what this Next release
//    supports. eslint-config-next 16.1.6 bundles eslint-plugin-react 7.37.5,
//    whose peer range ends at ^9.7, and on ESLint 10 it threw:
//
//      TypeError: Error while loading rule 'react/display-name':
//                 contextOrFilename.getFilename is not a function
//
//    eslint is now ^9.37.0, inside the range the config actually supports.
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

export default [
  ...coreWebVitals,
  ...typescript,
  {
    // Build output and generated files. A bare `ignores` object applies globally
    // in flat config, which is what is wanted here.
    ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts'],
  },

  // --------------------------------------------------------------------------
  // DEFERRED, NOT DISMISSED.
  //
  // Turning lint on for the first time surfaced 445 problems. Fixing them is a
  // separate change from making the tool run, so the rules with existing
  // violations are demoted to `warn`: they stay visible on every run, and the
  // job still fails on any NEW violation of the ~100 other rules in the Next
  // config, which currently have zero.
  //
  // Counts are as of 2026-07-31. If one reaches zero, promote it back to error.
  // --------------------------------------------------------------------------
  {
    rules: {
      // 375 occurrences — 84% of everything found. Removing them is a typing
      // project across the whole UI, with real decisions in it, not a lint fix.
      '@typescript-eslint/no-explicit-any': 'warn',

      // 5 occurrences, in EventTimeline.tsx and MobileDrawer.tsx. THIS IS THE
      // MOST IMPORTANT ITEM IN THIS LIST. Conditionally-called hooks are a real
      // correctness bug in React, not a style preference, and this is demoted
      // only because fixing it means restructuring two components and proving
      // their behaviour is unchanged. It should be the first one fixed.
      'react-hooks/rules-of-hooks': 'warn',

      // 10 occurrences. Each is a setState called synchronously in an effect,
      // which causes cascading renders. Every one needs individual reasoning
      // about that component's render behaviour; several are legitimate
      // reads of localStorage on mount.
      'react-hooks/set-state-in-effect': 'warn',

      // 2 occurrences in SessionPane.tsx, and 1 no-html-link-for-pages in
      // AuthButtons.tsx. Small and safe, but still source changes, so they
      // belong with the others rather than smuggled into a tooling PR.
      'react/no-unescaped-entities': 'warn',
      '@next/next/no-html-link-for-pages': 'warn',
    },
  },

  // --------------------------------------------------------------------------
  // Test files. These three are NOT deferrals — they are idioms that are correct
  // in tests and wrong in application code, so they are scoped rather than
  // demoted, and stay as errors everywhere else.
  // --------------------------------------------------------------------------
  {
    files: ['src/__tests__/**/*.{ts,tsx}'],
    rules: {
      // `require()` inside a test to re-import a module under a fresh mock.
      '@typescript-eslint/no-require-imports': 'off',
      // `const self = this` in a hand-rolled stub.
      '@typescript-eslint/no-this-alias': 'off',
      // bare `Function` when asserting on a mock's shape.
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
];
