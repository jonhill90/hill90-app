/**
 * A token with no `sub` is not a principal (#278).
 *
 * `requireAuth` assigned the verified payload straight through and required only
 * `exp`. `req.user.sub` is then read at 158 sites in this service to answer "is this
 * yours?" — `owner = $1`, `created_by = $1`, the ownership scoping in agents and
 * chat. With `sub` undefined those reads match nothing and return a clean empty
 * answer, and the writes store NULL — which is exactly how this codebase marks a
 * PLATFORM resource that only an admin may create.
 *
 * Reproduced before this change: a non-admin `POST /provider-connections` created a
 * row with `created_by = NULL`, and the `if (platform && !isAdmin) 403` guard was
 * never reached, because the request never claimed to be platform-scoped.
 *
 * WHY REFUSING IS SAFE, and each was checked rather than assumed:
 *   - production's `hill90-ui` carries the `basic` scope that emits `sub`
 *     (`web-origins, acr, profile, roles, basic, email`, read 2026-08-04), so no
 *     production caller loses access;
 *   - every `requireAuth` mount is a human-facing product surface. `/internal/discord`
 *     is the only router without it and authenticates by shared service token;
 *   - `serviceAccountsEnabled` is false on both app clients, so there is no
 *     client-credentials principal to lose;
 *   - agent tokens are Ed25519 and already refused by `algorithms: ['RS256']`.
 *
 * The one thing it does break is a local stack whose realm omits `basic` — which was
 * silently writing NULL-owned rows, and now says so.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(), stopAndRemoveContainer: jest.fn(), inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(), removeAgentVolumes: jest.fn(), reconcileAgentStatuses: jest.fn(),
}));
jest.mock('../services/agent-files', () => ({ writeAgentFiles: jest.fn(), removeAgentFiles: jest.fn() }));

const { createApp } = require('../app');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_ISSUER = 'https://test-issuer.example.com/realms/platform';

/** Mirrors a real hill90-ui token, minus whichever claim the test is about. */
function token(claims: Record<string, unknown>) {
  return jwt.sign(
    { resource_access: { 'hill90-ui': { roles: ['user'] } }, ...claims },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h', keyid: 'test' }
  );
}

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});
afterEach(() => { delete process.env.DATABASE_URL; });

describe('a token with no sub', () => {
  it('is refused, and the refusal names the claim rather than saying "invalid"', async () => {
    const res = await request(app).get('/usage').set('Authorization', `Bearer ${token({})}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token missing sub claim');
  });

  it('is refused before any query runs — nothing is read or written for a NULL owner', async () => {
    await request(app).get('/usage').set('Authorization', `Bearer ${token({})}`);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an empty-string sub is refused too — it is the same undefined by another name', async () => {
    const res = await request(app).get('/usage').set('Authorization', `Bearer ${token({ sub: '' })}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token missing sub claim');
  });

  it('the write path is refused as well, which is where NULL ownership was created', async () => {
    const res = await request(app)
      .post('/provider-connections')
      .set('Authorization', `Bearer ${token({})}`)
      .send({ name: 'x', provider: 'anthropic', api_key: 'unused' });
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('POSITIVE CONTROL — a normal token still passes', () => {
  it('a token WITH sub reaches the route', async () => {
    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${token({ sub: 'a-real-subject' })}`);
    expect(res.status).not.toBe(401);
    expect(mockQuery).toHaveBeenCalled();
  });

  it('the subject reaches the route as the identity it will be scoped by', async () => {
    mockQuery.mockResolvedValue({ rows: [{ total_requests: '0' }], rowCount: 1 });
    await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${token({ sub: 'subject-abc' })}`);
    // /usage filters non-admins by owner = $1. The value must be the subject, not
    // undefined — this is the assertion that would have caught #278 originally.
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('subject-abc');
  });

  it('the other refusals are unchanged: no header is still its own 401', async () => {
    const res = await request(app).get('/usage');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authorization header/);
  });
});
