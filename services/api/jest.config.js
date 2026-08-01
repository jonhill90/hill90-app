module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // app.ts creates a module-level app, which now requires KEYCLOAK_ISSUER because the
  // fallback was removed. Set it before any suite imports anything.
  setupFiles: ['<rootDir>/jest.setup.js'],
  // CARRIER_AUDIT=1 enables the deterministic carrier audit (jest.audit.js).
  // Off by default: it is a diagnostic, not part of the suite's contract.
  ...(process.env.CARRIER_AUDIT
    ? { setupFilesAfterEnv: ['<rootDir>/jest.audit.js'] }
    : {}),
};
