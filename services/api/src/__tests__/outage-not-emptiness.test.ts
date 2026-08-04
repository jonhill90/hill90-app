/**
 * Three surfaces a person reads WHEN SOMETHING IS WRONG, each of which answered a
 * failed dependency with a plausible, healthy-looking body (#289).
 *
 * They are three distinct faults and are fixed three different ways, because the
 * right replacement depends on who consumes the answer:
 *
 *   1. app.ts       a `.catch()` that FABRICATES a row — a failed workflows query
 *                   read as a system with zero workflows. A reader who sees 0 stops
 *                   looking; a reader who sees "unknown" does not.
 *   2. secrets.ts   vault unreachable -> HTTP 200 `{available:false}` with no cause.
 *   3. secrets.ts   vault returned something unparseable -> HTTP 200
 *                   `{available:TRUE}`. The worst of the three: "available" is an
 *                   assertion the code has no basis for. Nobody could read the
 *                   reply; that is not availability.
 *
 * WHY THE STATUS CODES DIFFER BETWEEN 1 AND 2/3, established from the consumers
 * rather than from taste:
 *
 *   - `/health/detailed` is read by `MonitoringClient.tsx`, which does
 *     `if (detRes.ok) setDetailed(...)` inside a try/catch that deliberately ignores
 *     failure, and never renders the platform stats at all. A non-2xx there would make
 *     the outage LESS visible, not more — the body would be dropped. So: keep 200,
 *     fix the body so zero and unknown are different things.
 *   - `/admin/secrets/status` is read by `probeService()`, which has no body reader
 *     for this call and judges the service purely on `res.ok`. **A 200 saying
 *     `available:false` therefore renders vault as HEALTHY during a vault outage.**
 *     Only a status change fixes that, so these two get one.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
  closePool: jest.fn(),
}));
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(), stopAndRemoveContainer: jest.fn(), inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(), removeAgentVolumes: jest.fn(), reconcileAgentStatuses: jest.fn(),
}));
jest.mock('../services/agent-files', () => ({ writeAgentFiles: jest.fn(), removeAgentFiles: jest.fn() }));

const { createApp } = require('../app');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_ISSUER = 'https://test-issuer.example.com/realms/platform';
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const adminToken = jwt.sign(
  { sub: 'admin-1', resource_access: { 'hill90-ui': { roles: ['admin'] } } },
  privateKey, { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h', keyid: 'k' }
);

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  mockQuery.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.DATABASE_URL; });

describe('1. /health/detailed must not fabricate a statistic', () => {
  it('reports the workflows count as UNKNOWN when its query fails, not as zero', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM workflows/i.test(sql)) return Promise.reject(new Error('relation "workflows" does not exist'));
      if (/FROM agents/i.test(sql)) return Promise.resolve({ rows: [{ total: '3', running: '1' }] });
      if (/FROM chat_threads/i.test(sql)) return Promise.resolve({ rows: [{ total: '7' }] });
      return Promise.resolve({ rows: [{}] });
    });

    const res = await request(app).get('/health/detailed').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // The counts that DID work are still reported — a partial answer is useful.
    expect(res.body.platform.agents).toEqual({ total: 3, running: 1 });
    expect(res.body.platform.threads).toBe(7);
    // The one that failed must not read as a real number.
    expect(res.body.platform.workflows).toBeNull();
    // And the reader must be told which figures are missing rather than having to
    // notice a null.
    expect(res.body.stats_unavailable).toContain('workflows');
    expect(logged.join('\n')).toMatch(/workflows/);
  });

  it('POSITIVE CONTROL: a genuinely empty system still reports zero, not unknown', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agents/i.test(sql)) return Promise.resolve({ rows: [{ total: '0', running: '0' }] });
      if (/FROM chat_threads/i.test(sql)) return Promise.resolve({ rows: [{ total: '0' }] });
      if (/FROM workflows/i.test(sql)) return Promise.resolve({ rows: [{ total: '0', enabled: '0' }] });
      return Promise.resolve({ rows: [{}] });
    });

    const res = await request(app).get('/health/detailed').set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.platform.workflows).toEqual({ total: 0, enabled: 0 });
    expect(res.body.stats_unavailable ?? []).toEqual([]);
    // Zero and unknown are now different answers. That is the whole fix.
  });
});

describe('2 & 3. /admin/secrets/status must not report an outage as health', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('an unreachable vault is NOT a 200 — the UI judges this endpoint on res.ok alone', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:8200')) as never;

    const res = await request(app).get('/admin/secrets/status').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
    // The cause, which the old body never carried anywhere.
    expect(String(res.body.error)).toMatch(/ECONNREFUSED/);
    expect(logged.join('\n')).toMatch(/secrets/);
  });

  it('an UNPARSEABLE reply is not availability — the worst of the three', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 502,
      text: async () => '<html>502 Bad Gateway</html>',
    }) as never;

    const res = await request(app).get('/admin/secrets/status').set('Authorization', `Bearer ${adminToken}`);

    // It used to answer 200 { available: true }. Nobody could read the reply; that
    // is an assertion the code has no basis for.
    expect(res.status).toBe(502);
    expect(res.body.available).toBeNull();
    expect(String(res.body.error)).toMatch(/HTTP 502/);
    expect(logged.join('\n')).toMatch(/secrets/);
  });

  it('POSITIVE CONTROL: a healthy vault is still 200 and still reports its state', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ sealed: false, initialized: true, version: '2.6.1', cluster_name: 'bao' }),
    }) as never;

    const res = await request(app).get('/admin/secrets/status').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, sealed: false, initialized: true, version: '2.6.1' });
    expect(logged).toEqual([]);
  });

  it('POSITIVE CONTROL: a SEALED vault is reachable and reports sealed, not an error', async () => {
    // The endpoint deliberately forces 200 for sealed/uninit/standby so the body can
    // be read. That must keep working — sealed is a state, not a failure to reach.
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ sealed: true, initialized: true, version: '2.6.1' }),
    }) as never;

    const res = await request(app).get('/admin/secrets/status').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, sealed: true });
  });
});
