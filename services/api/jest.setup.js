// KEYCLOAK_ISSUER has no default in the code, deliberately: a default would let a
// misconfigured service look healthy, and one pointing at the old `hill90` realm is
// how a stale fallback becomes silently correct. Production sets it from compose;
// tests set it here, for the same reason and in the same spirit.
//
// Suites that need a specific issuer still pass one to createApp(); this only makes
// importing app.ts possible at all.
process.env.KEYCLOAK_ISSUER =
  process.env.KEYCLOAK_ISSUER || 'https://auth.hill90.com/realms/platform';
