/**
 * Two endpoints that answered 500 on every call, and the reason nobody knew.
 *
 * `GET /agents/:id/metrics` and `GET /agents/:id/artifacts` each contained SQL
 * that Postgres refuses. Not a rare branch, not a race — the first statement on
 * the happy path, every time, since the day each was written.
 *
 * FOUR FAULTS, THREE OF THEM IN ONE STATEMENT:
 *   metrics   `created_at` — a column `agent_sessions` has never had;
 *             the outer `MAX(created_at)` then names a column the UNION stops
 *             producing once that is fixed, because a UNION takes its names
 *             from the first branch;
 *             `$1` compared against a uuid column AND a varchar column —
 *             `operator does not exist: character varying = uuid`.
 *   artifacts `COUNT(DISTINCT model)`, where the column is `model_name`.
 *
 * HOW THEY SURVIVED REVIEW AND CI, which is the more interesting defect: **no
 * test has ever called either route.** Measured over `routes/agents.ts` — 34
 * routes registered, **17 never requested by any test**, including these two.
 * The suite is 97 files and 1000+ tests, which reads as thorough; half of one
 * router had never been asked to answer anything.
 *
 * A test that MENTIONS a path is not a test that calls it, either. The first
 * count I ran said zero uncovered, because `docs.test.ts` lists `/metrics` in
 * an OpenAPI path assertion — the spec says the endpoint exists, and the spec
 * was right that it exists and silent that it fails.
 *
 * So these tests do the one thing that was missing: they call the routes.
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
  createAndStartContainer: jest.fn(), stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(), getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(), reconcileAgentStatuses: jest.fn(),
}));
jest.mock('../services/agent-files', () => ({ writeAgentFiles: jest.fn(), removeAgentFiles: jest.fn() }));

import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
const adminToken = jwt.sign(
  { sub: 'admin-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
);

const AGENT = { id: 'uuid-1', agent_id: 'a1', created_by: 'admin-user', created_at: '2026-08-01T00:00:00Z' };

beforeEach(() => {
  mockQuery.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('GET /agents/:id/metrics — called by a test for the first time', () => {
  it('POSITIVE CONTROL: it answers 200, not 500', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AGENT] })
      .mockResolvedValueOnce({ rows: [{ total_messages: '4' }] })
      .mockResolvedValueOnce({ rows: [{ total_events: '9' }] })
      .mockResolvedValueOnce({ rows: [{ last_active: '2026-08-04T09:00:00Z' }] });

    const res = await request(app)
      .get('/agents/uuid-1/metrics')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total_messages: 4,
      total_events: 9,
      last_active: '2026-08-04T09:00:00Z',
    });
  });

  it('the last-active union aliases its column and uses three parameters', async () => {
    // Pins all three faults at once, because fixing only the column name moves
    // the error into the outer MAX() and fixing only that leaves the type
    // mismatch. The statement has to be right as a whole.
    mockQuery
      .mockResolvedValueOnce({ rows: [AGENT] })
      .mockResolvedValueOnce({ rows: [{ total_messages: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total_events: '0' }] })
      .mockResolvedValueOnce({ rows: [{ last_active: null }] });

    await request(app)
      .get('/agents/uuid-1/metrics')
      .set('Authorization', `Bearer ${adminToken}`);

    const call = mockQuery.mock.calls.find((c) => /last_active/.test(String(c[0])));
    expect(call).toBeDefined();
    const sql = String(call![0]);
    expect(sql).not.toMatch(/SELECT created_at FROM agent_sessions/);
    expect(sql).toMatch(/started_at AS ts/);
    expect(sql).toMatch(/MAX\(ts\)/);
    expect(call![1]).toHaveLength(3);          // not two, or $1 straddles two types
  });
});

describe('GET /agents/:id/artifacts — likewise', () => {
  it('POSITIVE CONTROL: it answers 200, not 500', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AGENT] })
      .mockResolvedValueOnce({ rows: [{ total_inferences: '12', distinct_models: '2' }] })
      .mockResolvedValueOnce({ rows: [{ total_messages: '5' }] })
      .mockResolvedValueOnce({ rows: [{ total_uptime_seconds: '3600', estimated_uptime_seconds: '0', open_sessions: '0' }] });

    const res = await request(app)
      .get('/agents/uuid-1/artifacts')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.artifacts)).toBe(true);
    expect(typeof res.body.earned_count).toBe('number');
  });

  it('it counts distinct models by the column that exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AGENT] })
      .mockResolvedValueOnce({ rows: [{ total_inferences: '0', distinct_models: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total_messages: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total_uptime_seconds: '0', estimated_uptime_seconds: '0', open_sessions: '0' }] });

    await request(app)
      .get('/agents/uuid-1/artifacts')
      .set('Authorization', `Bearer ${adminToken}`);

    const sql = mockQuery.mock.calls.map((c) => String(c[0])).find((s) => /distinct_models/.test(s));
    expect(sql).toMatch(/COUNT\(DISTINCT model_name\)/);
    expect(sql).not.toMatch(/COUNT\(DISTINCT model\)/);
  });
});

describe('the ownership boundary still applies to both', () => {
  it.each([['metrics'], ['artifacts']])('a non-owner gets 404 from /%s', async (route) => {
    // These routes were never called, so their scoping was never exercised
    // either. Worth pinning while they are finally reachable.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const userToken = jwt.sign(
      { sub: 'someone-else', resource_access: { 'hill90-ui': { roles: ['user'] } } },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
    );

    const res = await request(app)
      .get(`/agents/uuid-1/${route}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
  });
});
