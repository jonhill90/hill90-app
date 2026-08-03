module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // app.ts creates a module-level app, which now requires KEYCLOAK_ISSUER because the
  // fallback was removed. Set it before any suite imports anything.
  setupFiles: ['<rootDir>/jest.setup.js'],
  // CARRIER_AUDIT=1 enables the deterministic carrier audit (jest.audit.js).
  // Off by default: it is a diagnostic, not part of the suite's contract.
  // LOOP_AUDIT=1 enables the per-test event-loop delay audit (jest.loopdelay.js).
  // Also a diagnostic, also off by default. Both can be on at once.
  ...((process.env.CARRIER_AUDIT || process.env.LOOP_AUDIT)
    ? {
        setupFilesAfterEnv: [
          ...(process.env.CARRIER_AUDIT ? ['<rootDir>/jest.audit.js'] : []),
          ...(process.env.LOOP_AUDIT ? ['<rootDir>/jest.loopdelay.js'] : []),
        ],
      }
    : {}),
};
