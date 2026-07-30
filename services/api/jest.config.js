module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // app.ts creates a module-level app, which now requires KEYCLOAK_ISSUER because the
  // fallback was removed. Set it before any suite imports anything.
  setupFiles: ['<rootDir>/jest.setup.js'],
};
