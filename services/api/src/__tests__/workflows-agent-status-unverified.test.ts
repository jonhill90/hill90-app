/**
 * The workflows route must not report an agent status nobody verified (#262).
 *
 * THE DEFECT. `routes/workflows.ts` selects `a.status AS agent_status` in both
 * the list and the detail response and serialized it straight out of the join.
 * #250 added the third state in `routes/agents.ts`; #251 added it in
 * `routes/chat.ts`; this route kept reporting a `running` row that
 * reconciliation could not check as fact, after two rounds of fixing exactly
 * that. #141/#153 again: the fix goes to one route and not its twin.
 *
 * WHY IT WAS FOUND LATE, which is the part that transfers. #251 enumerated five
 * UI surfaces by reading the components it already had open and never swept for
 * routes that SERVE a status, so a sixth was unreachable by that method. Rerun
 * the method, never the number:
 *
 *   grep -rnE "a\.status|agent_status" services/api/src/routes/
 *   grep -rn  "agent_status\|\.status === 'running'" services/ui/src
 *
 * POSITIVE CONTROL. With a working docker dependency the reconciler agrees with
 * the database and every assertion here passes against the unfixed route too —
 * so each case runs a pass whose `inspectContainer` THROWS a non-404, and is
 * paired with a twin on a working one.
 *
 * NOT EXERCISED: `dockerode` and the pool are mocked; no container was
 * inspected and no workflow was run.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const mockContainerInspect = jest.fn();
jest.mock('dockerode', () =>
  jest.fn().mockImplementation(() => ({
    getContainer: () => ({ inspect: mockContainerInspect }),
  })),
);

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { createApp } from '../app';
import { runReconcilePass } from '../services/agent-reconciler';
import { resetStatusVerification } from '../services/agent-status-verification';

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

function runningContainer() {
  return {
    Id: 'container-id-123',
    State: { Status: 'running' },
    Config: { Labels: { 'managed-by': 'hill90-api' } },
  };
}

function proxyUnreachable() {
  const err: any = new Error('connect ECONNREFUSED /var/run/docker.sock');
  err.statusCode = 500;
  return err;
}

/** Run one reconcile pass over a single running agent. */
async function reconcileWith(inspect: () => unknown) {
  mockQuery.mockResolvedValueOnce({
    rows: [{
      id: 'uuid-1', agent_id: 'test-agent', status: 'running',
      container_id: 'container-id-123', container_state: 'running',
      created_by: 'admin-user', model_router_exp: null,
    }],
  });
  mockContainerInspect.mockImplementation(inspect as any);
  await runReconcilePass();
}

const WORKFLOW_ROW = {
  id: 'wf-1',
  name: 'Nightly report',
  agent_id: 'uuid-1',
  agent_name: 'Test Agent',
  agent_slug: 'test-agent',
  agent_status: 'running',
  created_by: 'admin-user',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockContainerInspect.mockReset();
  resetStatusVerification();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('GET /workflows', () => {
  it('POSITIVE CONTROL: an unverified agent status is reported as unknown', async () => {
    await reconcileWith(() => Promise.reject(proxyUnreachable()));

    mockQuery.mockResolvedValueOnce({ rows: [WORKFLOW_ROW] });
    const res = await request(app)
      .get('/workflows')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body[0].agent_status).toBe('unknown');
    expect(res.body[0].agent_status_verified).toBe(false);
    // The workflow itself is untouched — this is a status fix, not a filter.
    expect(res.body[0].name).toBe('Nightly report');
  });

  it('TWIN: a verified agent status is reported as running', async () => {
    await reconcileWith(() => Promise.resolve(runningContainer()));

    mockQuery.mockResolvedValueOnce({ rows: [WORKFLOW_ROW] });
    const res = await request(app)
      .get('/workflows')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body[0].agent_status).toBe('running');
    expect(res.body[0].agent_status_verified).toBe(true);
  });
});

describe('GET /workflows/:id', () => {
  it('POSITIVE CONTROL: the detail response is mapped too, not only the list', async () => {
    // The twin route. #141 and #153 were both "the fix landed on one and not
    // the other", and this route has two selects.
    await reconcileWith(() => Promise.reject(proxyUnreachable()));

    mockQuery.mockResolvedValueOnce({ rows: [WORKFLOW_ROW] });
    const res = await request(app)
      .get('/workflows/wf-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agent_status).toBe('unknown');
    expect(res.body.agent_status_verified).toBe(false);
  });

  it('TWIN: verified detail reports running', async () => {
    await reconcileWith(() => Promise.resolve(runningContainer()));

    mockQuery.mockResolvedValueOnce({ rows: [WORKFLOW_ROW] });
    const res = await request(app)
      .get('/workflows/wf-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.agent_status).toBe('running');
    expect(res.body.agent_status_verified).toBe(true);
  });

  it('a row whose join produced no agent status is left alone', async () => {
    await reconcileWith(() => Promise.reject(proxyUnreachable()));

    mockQuery.mockResolvedValueOnce({
      rows: [{ ...WORKFLOW_ROW, agent_slug: undefined, agent_status: undefined }],
    });
    const res = await request(app)
      .get('/workflows/wf-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agent_status).toBeUndefined();
  });
});

describe('GET /mcp-servers/:id — the payload with no reader', () => {
  it('POSITIVE CONTROL: assigned agents carry the reported status, not the recorded one', async () => {
    // #262 asked for this to be decided rather than left silent. Mapping a
    // payload nobody reads costs nothing; the next reader finding a raw status
    // here is the whole of #238 again.
    await reconcileWith(() => Promise.reject(proxyUnreachable()));

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'mcp-1', name: 'files' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', name: 'Test Agent', agent_id: 'test-agent', status: 'running', enabled: true }],
      });
    const res = await request(app)
      .get('/mcp-servers/mcp-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agents[0].status).toBe('unknown');
    expect(res.body.agents[0].status_verified).toBe(false);
  });

  it('TWIN: a verified agent is reported as running', async () => {
    await reconcileWith(() => Promise.resolve(runningContainer()));

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'mcp-1', name: 'files' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', name: 'Test Agent', agent_id: 'test-agent', status: 'running', enabled: true }],
      });
    const res = await request(app)
      .get('/mcp-servers/mcp-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.agents[0].status).toBe('running');
    expect(res.body.agents[0].status_verified).toBe(true);
  });
});
