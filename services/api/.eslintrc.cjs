// There was no ESLint configuration in this service at all, so `npm run lint`
// (`eslint src --ext .ts`) exited saying it could not find one. The script has
// been declared in package.json the whole time and could never have worked.
//
// .cjs rather than .json so this reasoning can live as comments: eslintrc
// validates its schema strictly and rejects a top-level "//" key with
// `Unexpected top-level property "//"`.
//
// eslintrc rather than flat config because this service is on ESLint 8.57 with
// @typescript-eslint 6. The ui, on ESLint 9, uses flat config. Matching each
// service's own toolchain beats forcing one style across both.
//
// The ruleset is eslint:recommended plus @typescript-eslint/recommended, chosen
// to match what the code already is rather than to demand a rewrite. It is
// deliberately NOT the type-checked variant, which needs a project service and
// would surface a far larger set on first contact.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist/', 'node_modules/', '*.js'],

  // DEFERRED, NOT DISMISSED.
  //
  // Turning lint on for the first time surfaced 465 problems. Fixing them is a
  // separate change from making the tool run, so the rules with existing
  // violations are demoted to `warn`: they stay visible on every run, while the
  // job still fails on any NEW violation of every other recommended rule, all of
  // which currently have zero.
  //
  // Counts are as of 2026-07-31. If one reaches zero, promote it back to error.
  rules: {
    // 428 occurrences - 92% of everything found. Removing them is a typing
    // project across the service, with real decisions in it, not a lint fix.
    '@typescript-eslint/no-explicit-any': 'warn',
    // 20 occurrences. Each needs a judgement: delete, or prefix with _ to say
    // "deliberately unused".
    '@typescript-eslint/no-unused-vars': 'warn',
    // 6 occurrences, 5 of them in src. Auto-fixable, but still a source change.
    'prefer-const': 'warn',
    // 1, in src/routes/agents.ts.
    'no-useless-escape': 'warn',
    // 1, in src/services/docker.ts.
    '@typescript-eslint/ban-types': 'warn',
  },

  overrides: [
    {
      // Test idioms, scoped rather than demoted: require() re-imports a module
      // under a fresh jest mock, which is correct in a test and wrong in a
      // route. All 9 no-var-requires violations are in tests, so switching it
      // off here costs no coverage in application code.
      files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
      env: { jest: true },
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};
