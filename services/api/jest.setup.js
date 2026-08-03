// KEYCLOAK_ISSUER has no default in the code, deliberately: a default would let a
// misconfigured service look healthy, and one pointing at the old `hill90` realm is
// how a stale fallback becomes silently correct. Production sets it from compose;
// tests set it here, for the same reason and in the same spirit.
//
// Suites that need a specific issuer still pass one to createApp(); this only makes
// importing app.ts possible at all.
process.env.KEYCLOAK_ISSUER =
  process.env.KEYCLOAK_ISSUER || 'https://auth.hill90.com/realms/platform';

// The SSE inference poll is 3000ms in production. A test that must observe one
// poll therefore cannot finish in under 3s and lands near 4s, against jest's
// 5000ms default — about one second of margin, which round four of
// docs/decisions/api-suite-flakiness.md measured as why TIMEOUT is in this
// suite's symptom set. Tests do not need production's cadence to prove the poll
// happens, so they get a small one. Production leaves this unset.
process.env.INFERENCE_POLL_MS = process.env.INFERENCE_POLL_MS || '50';
