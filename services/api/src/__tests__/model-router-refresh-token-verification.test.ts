/**
 * POST /internal/model-router/refresh-token verifies the bearer token it is
 * handed, rather than base64-decoding it and trusting the payload.
 *
 * THE DEFECT (#459). The handler read:
 *
 *     const parts = token.split('.');
 *     const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
 *     sub = payload.sub;
 *
 * No signature check, no `alg` check, no `iss`/`aud` check. `sub` was
 * whatever the caller wrote, and the comment said as much.
 *
 * WHAT THIS IS AND IS NOT. It is not an authorization bypass, and the tests
 * below are written so as not to imply one: the boundary is the
 * refresh-secret hash compared against the agent's row, and an attacker
 * without that secret gets nowhere no matter what `sub` they forge. It IS an
 * unforced asymmetry — the knowledge service's equivalent refresh endpoint
 * (`routes/internal.py`, `refresh_token`) has always called the real EdDSA
 * verifier with `allow_expired=True`, and this file's own header claims to
 * mirror that pattern while doing materially less.
 *
 * So `mockQuery` below deliberately returns a MATCHING agent row for every
 * lookup — the refresh secret is treated as already correct. That isolates
 * the one variable under test: given a caller who clears the real boundary,
 * does the token's signature matter at all? Before the fix, no. After, yes.
 *
 * WHY THE KEY IS GENERATED HERE. Ed25519's public half derives from the
 * private key, so the fix needs no new configuration — the test proves that
 * by configuring only MODEL_ROUTER_SIGNING_PRIVATE_KEY, exactly as
 * production does, and never supplying a public key anywhere.
 */
import request from 'supertest';
import * as crypto from 'crypto';

const { privateKey } = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// A DIFFERENT key, never known to the service — the forger's key.
const { privateKey: attackerKey } = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

process.env.MODEL_ROUTER_SIGNING_PRIVATE_KEY = privateKey as string;

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));

jest.mock('../services/model-router-revoke', () => ({
  revokeAgentModelRouterToken: jest.fn().mockResolvedValue(undefined),
}));

import { createApp } from '../app';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint(signWith: string | null, claims: Record<string, unknown>, alg = 'EdDSA') {
  const header = b64({ alg, typ: 'JWT' });
  const payload = b64(claims);
  if (signWith === null) return `${header}.${payload}.`; // alg:none forgery
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`), crypto.createPrivateKey(signWith));
  return `${header}.${payload}.${sig.toString('base64url')}`;
}

const CLAIMS = {
  sub: 'victim-agent',
  principal_type: 'agent',
  iss: 'hill90-api',
  aud: 'hill90-model-router',
  exp: Math.floor(Date.now() / 1000) - 60, // EXPIRED — the refresh case
  iat: Math.floor(Date.now() / 1000) - 3660,
  jti: 'jti-1',
  owner: 'owner-1',
  scopes: [],
};

function refresh(token: string) {
  return request(createApp())
    .post('/internal/model-router/refresh-token')
    .set('Authorization', `Bearer ${token}`)
    .send({ refresh_secret: 'the-correct-secret' });
}

beforeEach(() => {
  mockQuery.mockReset();
  // Every lookup matches: the caller is treated as having cleared the real
  // boundary, so only the token's signature is in question.
  mockQuery.mockResolvedValue({
    rows: [{ id: 'uuid-1', agent_id: 'victim-agent', model_router_jti: 'jti-1', model_router_exp: 1, created_by: 'owner-1' }],
  });
});

describe('model-router refresh — the bearer token must be verified, not decoded', () => {
  it('THE ASSERTION THAT MATTERS: a token signed with an unknown key is refused', async () => {
    const res = await refresh(mint(attackerKey as string, CLAIMS));
    expect(res.status).toBe(401);
    // And nothing was issued.
    expect(res.body.token).toBeUndefined();
  });

  it('an unsigned alg:none token is refused', async () => {
    const res = await refresh(mint(null, CLAIMS));
    expect(res.status).toBe(401);
  });

  it('a token for another audience is refused', async () => {
    const res = await refresh(mint(privateKey as string, { ...CLAIMS, aud: 'hill90-akm' }));
    expect(res.status).toBe(401);
  });

  it('a token from another issuer is refused', async () => {
    const res = await refresh(mint(privateKey as string, { ...CLAIMS, iss: 'somebody-else' }));
    expect(res.status).toBe(401);
  });

  it('POSITIVE CONTROL: a genuinely-signed but EXPIRED token still refreshes', async () => {
    // The whole point of the flow. If this fails, the fix has broken refresh
    // for every agent rather than hardened it — which is the way a change
    // like this does real damage.
    const res = await refresh(mint(privateKey as string, CLAIMS));
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.refresh_secret).toBe('string');
  });

  it('the refusal names a cause and never echoes the token', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const forged = mint(attackerKey as string, CLAIMS);
    await refresh(forged);

    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/signature does not verify/);
    // #114's rule, held here: a refusal says why, and says it without the credential.
    expect(logged).not.toContain(forged);
    warn.mockRestore();
  });
});
