/**
 * An admin must reach the routes gated on `user` (#277).
 *
 * THE DEFECT. `requireRole` is a flat membership test — `roles.includes(role)` —
 * and `hill90-ui` has exactly two client roles, `user` and `admin`. A principal
 * holding only `admin` therefore fails every one of the 117 `requireRole('user')`
 * gates in this service.
 *
 * WHY THAT IS THE CODE'S OWN INTENT, not a preference: **ten route files contain 61
 * branches on `includes('admin')` / `isAdmin(req)` sitting BEHIND a
 * `requireRole('user')` gate** — usage widens its query for admins, chat and agents
 * scope ownership, model-policies and provider-connections allow platform-owned
 * rows. For an admin-only principal every one of those branches is dead code that
 * cannot be reached. A service that writes `if (admin)` behind a gate admins cannot
 * pass has already decided the question.
 *
 * NOT A HYPOTHETICAL. In production `hill90admin` holds `admin` alone, so this 403 is
 * reachable there today; `jon` holds `user,admin` and is unaffected. Locally every
 * seeded admin account holds `admin` alone.
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

function tokenWith(roles: string[]) {
  return jwt.sign(
    { sub: 'subject-1', resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h', keyid: 'test' }
  );
}

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{}], rowCount: 1 });
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});
afterEach(() => { delete process.env.DATABASE_URL; });

describe('an admin-only principal on a user-gated route', () => {
  it('reaches GET /usage — the route that branches on admin inside', async () => {
    const res = await request(app).get('/usage').set('Authorization', `Bearer ${tokenWith(['admin'])}`);
    expect(res.status).not.toBe(403);
  });

  it('reaches GET /agents', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get('/agents').set('Authorization', `Bearer ${tokenWith(['admin'])}`);
    expect(res.status).not.toBe(403);
  });

  it('reaches GET /eligible-models', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get('/eligible-models').set('Authorization', `Bearer ${tokenWith(['admin'])}`);
    expect(res.status).not.toBe(403);
  });
});

describe('what must NOT change — the implication runs one way only', () => {
  it('a user-only principal is still refused an admin route', async () => {
    const res = await request(app)
      .post('/agents/some-id/start')
      .set('Authorization', `Bearer ${tokenWith(['user'])}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/);
  });

  it('a principal with neither role is refused a user route', async () => {
    const res = await request(app).get('/usage').set('Authorization', `Bearer ${tokenWith([])}`);
    expect(res.status).toBe(403);
  });

  it('a principal with no token at all is unauthenticated, not unauthorised', async () => {
    const res = await request(app).get('/usage');
    expect(res.status).toBe(401);
  });

  it('realm roles still grant nothing — authorisation is by CLIENT role', async () => {
    // The platform realm role `admin` grants Grafana Admin and OpenBao. It must
    // never be read here, and rolesFrom() only looks at resource_access.
    const token = jwt.sign(
      { sub: 'subject-2', realm_access: { roles: ['admin'] }, resource_access: {} },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h', keyid: 'test' }
    );
    const res = await request(app).get('/usage').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('the implication map is pinned, so a third role forces a decision', () => {
  it('states exactly which roles imply which, and nothing else', () => {
    const { ROLE_IMPLIES } = require('../middleware/role');
    // hill90-ui has exactly two client roles in the platform realm: user, admin.
    // If a third is ever added, this fails and whoever adds it must decide whether
    // it belongs in the hierarchy — rather than inheriting an answer by accident.
    expect(ROLE_IMPLIES).toEqual({ admin: ['user'] });
  });

  it('resolves the effective set without inventing membership', () => {
    const { effectiveRoles } = require('../middleware/role');
    expect([...effectiveRoles(['admin'])].sort()).toEqual(['admin', 'user']);
    expect([...effectiveRoles(['user'])].sort()).toEqual(['user']);
    expect([...effectiveRoles([])].sort()).toEqual([]);
    expect([...effectiveRoles(['user', 'admin'])].sort()).toEqual(['admin', 'user']);
    // An unknown role passes through unchanged: it grants itself and nothing more.
    expect([...effectiveRoles(['auditor'])].sort()).toEqual(['auditor']);
  });
});
