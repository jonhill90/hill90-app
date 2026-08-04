/**
 * The reconciler must correct in BOTH directions, and keep what it saw (#239).
 *
 * THE DEFECT. It looped over `SELECT ... WHERE status = 'running'` and the only
 * write it could make was to `stopped`. So an agent recorded `stopped` whose
 * container was actually running was invisible to it *by construction, not by
 * accident*: no code path would ever look at that row. Unlike #238 it needs no
 * failure to occur — a start that created the container and died before its
 * status update, or a status written by one process while another started the
 * container, lands there permanently.
 *
 * AND THE SECOND HALF. `inspectContainer` separates absence from ill-health
 * correctly (404 → null, everything else rethrows). Reconciliation preserved
 * that for exactly one expression — `state ? \`Container ${state.status}\` :
 * 'Container not found'` — and then collapsed both into `status = 'stopped'`,
 * leaving the difference in a free-text `error_message` nothing queries. So
 * "was this agent stopped, or did its container vanish?" was answerable for the
 * duration of one ternary. `container_state` carries it out queryably.
 *
 * THE FIXTURE DISCIPLINE, same as #238's. With a database and a docker daemon
 * that AGREE, broken and fixed are identical — the old reconciler looked at the
 * running rows, found running containers, wrote nothing, and so does this one.
 * The only fixtures that separate them are the ones where the two disagree in
 * the direction the old code could not express. Every such case below is paired
 * with a TWIN on a consistent fixture, which must pass either way; if a
 * promotion assertion ever passes on its twin, this file has stopped measuring
 * anything.
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

/** One row, as the reconciler now reads it: every agent, whatever its status. */
function agentRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'uuid-1',
    agent_id: 'test-agent',
    status: 'stopped',
    container_id: null,
    container_state: null,
    ...over,
  };
}

function selectAgents(rows: Array<ReturnType<typeof agentRow>>) {
  mockQuery.mockResolvedValueOnce({ rows });
}

function container(status: string) {
  return {
    Id: 'container-id-123',
    State: { Status: status },
    Config: { Labels: { 'managed-by': 'hill90-api' } },
  };
}

function absent() {
  const err: any = new Error('no such container');
  err.statusCode = 404;
  return err;
}

/** The UPDATE the reconciler issues, if it issued one. */
function statusUpdate() {
  return mockQuery.mock.calls.find((c) => String(c[0]).startsWith('UPDATE agents'));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockContainerInspect.mockReset();
  resetStatusVerification();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('the direction that did not exist', () => {
  it('the pass looks at every row, not only the ones marked running', async () => {
    // The fixture feeds rows regardless of the SQL, so nothing else in this
    // file can see the WHERE clause — and the WHERE clause IS the defect. A
    // reconciler that still selects `status = 'running'` cannot promote
    // anything no matter how the branch below is written.
    selectAgents([agentRow({ status: 'stopped' })]);
    mockContainerInspect.mockResolvedValue(container('running'));

    await runReconcilePass();

    const select = String(mockQuery.mock.calls[0][0]);
    expect(select).toContain('FROM agents');
    expect(select).not.toContain("status = 'running'");
  });

  it('POSITIVE CONTROL: a stopped row whose container IS running is promoted', async () => {
    selectAgents([agentRow({ status: 'stopped' })]);
    mockContainerInspect.mockResolvedValue(container('running'));

    const result = await runReconcilePass();

    expect(result!.promoted).toBe(1);
    expect(result!.demoted).toBe(0);
    const update = statusUpdate();
    expect(update![0]).toContain('status = $1');
    expect(update![1][0]).toBe('running');
    expect(update![1]).toContain('container-id-123');
  });

  it('TWIN: a stopped row whose container is absent is left alone', async () => {
    // The consistent fixture. The old reconciler and this one behave
    // identically here — which is exactly why it cannot be the only test.
    selectAgents([agentRow({ status: 'stopped', container_state: 'absent' })]);
    mockContainerInspect.mockRejectedValue(absent());

    const result = await runReconcilePass();

    expect(result!.promoted).toBe(0);
    expect(result!.reconciled).toBe(0);
    expect(statusUpdate()).toBeUndefined();
  });

  it('an error row whose container IS running is promoted too', async () => {
    // A start that created the container and then failed on a later step wrote
    // `error`; the container it created is still there.
    selectAgents([agentRow({ status: 'error', container_state: null })]);
    mockContainerInspect.mockResolvedValue(container('running'));

    const result = await runReconcilePass();

    expect(result!.promoted).toBe(1);
    expect(statusUpdate()![1][0]).toBe('running');
  });

  it('a promotion is recorded in status history, since nothing else can see it', async () => {
    selectAgents([agentRow({ status: 'stopped' })]);
    mockContainerInspect.mockResolvedValue(container('running'));

    await runReconcilePass();

    const history = mockQuery.mock.calls.find((c) => String(c[0]).includes('agent_status_history'));
    expect(history).toBeDefined();
    expect(history![1]).toEqual(['uuid-1', 'stopped', 'running', 'reconciler']);
  });

  it('the old direction still works: a running row with an exited container is demoted', async () => {
    selectAgents([agentRow({ status: 'running', container_id: 'container-id-123', container_state: 'running' })]);
    mockContainerInspect.mockResolvedValue(container('exited'));

    const result = await runReconcilePass();

    expect(result!.demoted).toBe(1);
    expect(statusUpdate()![1][0]).toBe('stopped');
  });

  it('a steady state writes nothing at all', async () => {
    // No churn: reconciliation running every 60s must not rewrite rows it
    // agrees with, or `updated_at` becomes meaningless.
    selectAgents([agentRow({ status: 'running', container_id: 'container-id-123', container_state: 'running' })]);
    mockContainerInspect.mockResolvedValue(container('running'));

    const result = await runReconcilePass();

    expect(result!.reconciled).toBe(0);
    expect(statusUpdate()).toBeUndefined();
  });
});

describe('absence and ill-health stay distinguishable after the fact', () => {
  it('POSITIVE CONTROL: a vanished container records absent, an exited one records exited', async () => {
    // Same recorded status, same demotion, two different observations — the
    // difference that used to survive only in prose in `error_message`.
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockRejectedValue(absent());
    await runReconcilePass();
    const vanished = statusUpdate();

    mockQuery.mockReset();
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockReset();
    mockContainerInspect.mockResolvedValue(container('exited'));
    await runReconcilePass();
    const exited = statusUpdate();

    expect(vanished![1][0]).toBe('stopped');
    expect(exited![1][0]).toBe('stopped');
    // Identical status, distinguishable observation.
    expect(vanished![1][1]).toBe('absent');
    expect(exited![1][1]).toBe('exited');
    expect(vanished![1][1]).not.toBe(exited![1][1]);
  });

  it('an observation it could not make is NULL, which is not a synonym for absent', async () => {
    const proxyDown: any = new Error('connect ECONNREFUSED /var/run/docker.sock');
    proxyDown.statusCode = 500;
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockRejectedValue(proxyDown);

    const result = await runReconcilePass();

    expect(result!.unverified).toEqual(['test-agent']);
    const update = statusUpdate();
    expect(update![1][0]).toBe('running');  // status untouched
    expect(update![1][1]).toBeNull();       // and no claim about the container
  });

  it('GET /agents carries the observation, so it is queryable rather than prose', async () => {
    selectAgents([agentRow({ status: 'stopped', container_state: 'exited' })]);
    mockContainerInspect.mockResolvedValue(container('exited'));
    await runReconcilePass();

    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow({ status: 'stopped', container_state: 'exited' }), name: 'Test', created_by: 'admin-user' }],
    });
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body[0].container_state).toBe('exited');
  });

  it('an unverified agent reports no observation at the boundary either', async () => {
    const proxyDown: any = new Error('connect ECONNREFUSED /var/run/docker.sock');
    proxyDown.statusCode = 500;
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockRejectedValue(proxyDown);
    await runReconcilePass();

    // The row still holds whatever was written last; the API must not serve it
    // as a current sighting.
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow({ status: 'running', container_state: 'running' }), name: 'Test', created_by: 'admin-user' }],
    });
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body[0].status).toBe('unknown');
    expect(res.body[0].container_state).toBeNull();
  });
});
