/**
 * POST /workflows/webhook/:token is documented as public — authenticated by
 * its own 256-bit token, not a Keycloak session — but the whole /workflows
 * router used to be mounted behind requireAuth in app.ts:
 *   app.use('/workflows', requireAuth, workflowsRouter)
 * requireAuth rejects any request with no Bearer token before Express ever
 * reaches a route inside that router, so a real external webhook sender —
 * GitHub, a monitoring system, anything outside this platform, which by
 * definition has no Keycloac session — got a 401 on every single attempt.
 * The feature could not work at all, not "worked without hardening."
 *
 * Fixed (#425) by splitting the route into its own router
 * (routes/workflows-webhook.ts), mounted ahead of the authenticated one at
 * the same '/workflows' prefix. This test pins two things at once: the
 * webhook route is reachable with NO Authorization header, and every other
 * /workflows/* route still requires one — the split must not have widened
 * the public surface beyond this one route.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
}));

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const userToken = jwt.sign(
  { sub: 'user-1', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' },
);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('POST /workflows/webhook/:token is reachable without a Keycloak session', () => {
  it('THE ASSERTION THAT MATTERS: an unknown token with NO Authorization header gets a 404 (reached the handler), not a 401 (blocked by requireAuth)', async () => {
    // No token lookup will match an empty rows response, so a request that
    // reaches the handler answers 404 "Webhook not found". A request that
    // never reaches the handler — blocked by requireAuth — answers 401
    // before the handler's own 404 logic ever runs. The two are
    // distinguishable by status code alone, which is exactly what makes
    // this the right assertion: it does not just check "not 401", it
    // confirms the handler's own code actually ran.
    const res = await request(app)
      .post('/workflows/webhook/some-random-token')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Webhook not found/);
  });

  it('a request WITH an Authorization header is also still accepted (the header is simply irrelevant here, not rejected)', async () => {
    const res = await request(app)
      .post('/workflows/webhook/some-random-token')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe('every other /workflows/* route still requires a Bearer token — the split did not widen the public surface', () => {
  it('GET /workflows (list) with no Authorization header is refused', async () => {
    const res = await request(app).get('/workflows');
    expect(res.status).toBe(401);
  });

  it('POST /workflows (create) with no Authorization header is refused', async () => {
    const res = await request(app).post('/workflows').send({});
    expect(res.status).toBe(401);
  });

  it('POST /workflows/:id/run with no Authorization header is refused', async () => {
    const res = await request(app).post('/workflows/some-id/run').send({});
    expect(res.status).toBe(401);
  });

  it('DELETE /workflows/:id with no Authorization header is refused', async () => {
    const res = await request(app).delete('/workflows/some-id');
    expect(res.status).toBe(401);
  });
});
