module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // app.ts creates a module-level app, which now requires KEYCLOAK_ISSUER because the
  // fallback was removed. Set it before any suite imports anything.
  setupFiles: ['<rootDir>/jest.setup.js'],
  // CARRIER_AUDIT=1 enables the deterministic carrier audit (jest.audit.js).
  // Off by default: it is a diagnostic, not part of the suite's contract.
  // The response IDENTITY guard is ON BY DEFAULT. It SUPERSEDES the Server-header
  // guard of round fifteen: a foreign daemon carries no stamp, so NO STAMP covers
  // that case, and FOREIGN STAMP additionally covers a sibling worker, which the
  // old guard could not see. Two overlapping guards is how one rots unnoticed. It is a guard, not a diagnostic:
  // a test that asserts on a response the app never wrote is worse than a failing
  // test. See docs/decisions/api-suite-flakiness.md, round fifteen.
  setupFilesAfterEnv: ['<rootDir>/jest.identityguard.js'],
  // LOOP_AUDIT=1 enables the per-test event-loop delay audit (jest.loopdelay.js).
  // Also a diagnostic, also off by default. Both can be on at once.
  //
  // app#605: PROBE_400 and PROBE_TIMEOUT close the two failure classes none of
  // the four existing instruments covers (verified by reading each one, not
  // assumed — see that issue). Same toggle shape as AUTH_401_PROBE: off by
  // default, matching jest.auth401.js's own design exactly.
  ...((process.env.CARRIER_AUDIT || process.env.LOOP_AUDIT || process.env.AUTH_401_PROBE || process.env.PROBE_400 || process.env.PROBE_TIMEOUT)
    ? {
        setupFilesAfterEnv: [
          '<rootDir>/jest.identityguard.js',
          ...(process.env.CARRIER_AUDIT ? ['<rootDir>/jest.audit.js'] : []),
          ...(process.env.LOOP_AUDIT ? ['<rootDir>/jest.loopdelay.js'] : []),
          ...(process.env.AUTH_401_PROBE ? ['<rootDir>/jest.auth401.js'] : []),
          ...(process.env.PROBE_400 ? ['<rootDir>/jest.probe400.js'] : []),
          ...(process.env.PROBE_TIMEOUT ? ['<rootDir>/jest.timeoutprobe.js'] : []),
        ],
      }
    : {}),
  // PROBE_TIMEOUT's other half: a Reporter, not a setupFilesAfterEnv file —
  // see jest.timeoutprobe.js's header for why the detector has to live here.
  // 'default' keeps jest's normal console output; this only adds a listener.
  ...(process.env.PROBE_TIMEOUT
    ? { reporters: ['default', '<rootDir>/jest.timeoutprobe.reporter.js'] }
    : {}),
};
