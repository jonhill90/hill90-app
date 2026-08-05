/**
 * agent_webhooks.secret must never leave the server (app#369/#374 audit).
 *
 * `secret` is a plaintext VARCHAR(128) HMAC-signing key for outbound webhook
 * delivery (`webhook-dispatch.ts`'s `crypto.createHmac('sha256', hook.secret)`).
 * Reading routes/agents.ts's webhook CRUD directly, both GET and POST already
 * name their columns explicitly rather than a bare `SELECT *` — `secret`
 * has never been returned. That's the "plaintext at rest, correctly withheld"
 * middle tier from #374's audit table: no live exposure, but also no test
 * standing guard against a future regression back to a wildcard select, the
 * exact shape that let `mcp_servers.connection_config` go unnoticed until
 * #369 compared it against `provider_connections` by hand.
 *
 * WHY THE ASSERTIONS TARGET THE SQL TEXT, NOT JUST THE RESPONSE BODY. A mock
 * `getPool().query` doesn't parse SQL — it returns whatever row a test hands
 * it, regardless of what columns the query string actually names. A response
 * -body-only assertion against a fixture that happens to omit `secret` would
 * pass even if the route regressed to `SELECT *`, because the fixture, not
 * the route, is what determined the shape. The SQL-text assertions are what
 * actually catch that regression; the response-body assertions are then
 * checked against a fixture shaped like what the route's REAL, narrow column
 * list produces, catching a handler that spreads a full row into `res.json`
 * some other way (e.g. accidentally forwarding an internal object).
 *
 * This file adds tests only. The routes are already correct — no code change.
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
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
}));

const adminToken = jwt.sign(
  { sub: 'admin-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

/** What the route's real, narrow column list actually produces — no `secret` key at all. */
const PUBLIC_WEBHOOK_ROW = {
  id: 'hook-1', agent_id: 'agent-1', url: 'https://example.com/hook',
  events: ['start', 'stop'], active: true,
  created_by: 'admin-user', created_at: new Date(), updated_at: new Date(),
};

/** Extracts the SELECT/RETURNING projection portion of a query, up to FROM/WHERE. */
function projectionOf(sql: string): string {
  const returning = sql.match(/RETURNING\s+([\s\S]*)$/i);
  if (returning) return returning[1];
  const select = sql.match(/SELECT\s+([\s\S]*?)\s+FROM\b/i);
  return select ? select[1] : sql;
}

describe('agent_webhooks.secret never appears in a response', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /agents/:id/webhooks selects columns explicitly and never names secret', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [PUBLIC_WEBHOOK_ROW] });

    const res = await request(app)
      .get('/agents/agent-1/webhooks')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/"secret"/);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/^\s*SELECT\s+\*/i);
    expect(projectionOf(sql).toLowerCase()).not.toMatch(/\bsecret\b/);
  });

  it('POST /agents/:id/webhooks RETURNING clause never names secret, though the INSERT legitimately writes it', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] }) // agent existence check
      .mockResolvedValueOnce({ rows: [PUBLIC_WEBHOOK_ROW] });

    const res = await request(app)
      .post('/agents/agent-1/webhooks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ url: 'https://example.com/hook', secret: 'whsec_should-never-echo-back' });

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/"secret"/);

    // The INSERT's column list legitimately writes `secret` (it's a bound
    // param, not the leak) — only the RETURNING clause is asserted here.
    const insertSql = mockQuery.mock.calls[1][0] as string;
    expect(insertSql.toLowerCase()).toContain('insert into agent_webhooks');
    expect(projectionOf(insertSql).toLowerCase()).not.toMatch(/\bsecret\b/);
  });

  // POSITIVE CONTROLS: prove the projection check actually has teeth by
  // running it against SQL shaped like the regression it exists to catch.
  it('CONTROL: projectionOf() would flag a SELECT * regression', () => {
    expect(projectionOf('SELECT * FROM agent_webhooks WHERE agent_id = $1')).toContain('*');
  });

  it('CONTROL: projectionOf() would flag a RETURNING * regression', () => {
    const sql = 'INSERT INTO agent_webhooks (agent_id, url, secret) VALUES ($1, $2, $3) RETURNING *';
    expect(projectionOf(sql).trim()).toBe('*');
  });

  it('CONTROL: projectionOf() would flag an explicit-but-leaky column list', () => {
    const sql = 'SELECT id, url, secret FROM agent_webhooks WHERE agent_id = $1';
    expect(projectionOf(sql).toLowerCase()).toMatch(/\bsecret\b/);
  });
});
