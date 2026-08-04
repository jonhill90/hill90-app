/**
 * A status the API could not verify must be reported as `unknown` (#238).
 *
 * THE DEFECT. Reconciliation ran once, at startup, and `index.ts:46` caught
 * whatever came out of it, logged it, and let the process carry on serving.
 * `inspectContainer` rethrows every fault that is not a 404 — an unreachable
 * docker-proxy, a permissions error — so that throw aborted the pass, and every
 * agent kept whatever status the database last recorded. `/agents` then served
 * those values to the UI as current. There were only two statuses to report and
 * neither of them means "I could not tell", so a reconciliation that never
 * happened looked exactly like one that ran and found everything in order.
 *
 * THE POSITIVE CONTROL, and why it is the whole test. With a working docker
 * dependency, broken and fixed are byte-identical: the reconciler checks the
 * containers, agrees with the database, and every assertion passes either way.
 * The only fixture that separates them is one where the dependency THROWS. So
 * each case here is paired with its twin on a working dependency — if the
 * `unknown` assertion ever passes for both, the test has stopped measuring
 * anything. That is the same rule as the drift check's exit codes 1 and 2: a
 * finding and an absence of evidence must not collapse into one another.
 *
 * NOT COVERED HERE: a `stopped` row whose container is really running. That is
 * #239, and it has its own file — `agent-reconcile-both-directions.test.ts`.
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
import {
  reportedStatus,
  isStatusVerified,
  resetStatusVerification,
} from '../services/agent-status-verification';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});
const adminToken = jwt.sign(
  { sub: 'admin-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
);

/** What the docker daemon returns for a healthy, running, managed container. */
function runningContainer() {
  return {
    Id: 'container-id-123',
    State: { Status: 'running', Health: { Status: 'healthy' } },
    Config: { Labels: { 'managed-by': 'hill90-api' } },
  };
}

/** A fault that is NOT a 404: the docker-proxy is unreachable. */
function proxyUnreachable() {
  const err: any = new Error('connect ECONNREFUSED /var/run/docker.sock');
  err.statusCode = 500;
  return err;
}

/**
 * The reconciler's SELECT. Since #239 it reads every agent row, not only the
 * ones recorded `running`, so the fixture carries the columns it now reads.
 */
function selectAgents(rows: Array<{ id: string; agent_id: string; status?: string }>) {
  mockQuery.mockResolvedValueOnce({
    rows: rows.map((r) => ({
      status: 'running', container_id: 'container-id-123', container_state: 'running', ...r,
    })),
  });
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

describe('reconciliation records what it could not verify', () => {
  it('POSITIVE CONTROL: a throwing docker dependency leaves the agent unverified', async () => {
    selectAgents([{ id: 'uuid-1', agent_id: 'test-agent' }]);
    mockContainerInspect.mockRejectedValue(proxyUnreachable());

    const result = await runReconcilePass();

    expect(result).not.toBeNull();
    expect(result!.unverified).toEqual(['test-agent']);
    expect(isStatusVerified('test-agent')).toBe(false);
    // The status it could not check is reported as unknown, NOT as the value
    // the database holds.
    expect(reportedStatus('test-agent', 'running')).toBe('unknown');

    // And it did not write a status it has no evidence for. It DOES clear the
    // last observation (#239's `container_state`), because a stale sighting
    // must not stand as though it were current — but the status is written
    // back unchanged.
    const updates = mockQuery.mock.calls.filter((c) => String(c[0]).includes('UPDATE agents'));
    expect(updates).toHaveLength(1);
    expect(updates[0][1][0]).toBe('running');   // status: unchanged
    expect(updates[0][1][1]).toBeNull();        // container_state: cannot tell
  });

  it('TWIN: the same fixture on a working dependency reports running', async () => {
    selectAgents([{ id: 'uuid-1', agent_id: 'test-agent' }]);
    mockContainerInspect.mockResolvedValue(runningContainer());

    const result = await runReconcilePass();

    expect(result!.unverified).toEqual([]);
    expect(isStatusVerified('test-agent')).toBe(true);
    expect(reportedStatus('test-agent', 'running')).toBe('running');
  });

  it('a 404 is an ANSWER, not an absence of evidence: the agent is demoted, not unknown', async () => {
    selectAgents([{ id: 'uuid-1', agent_id: 'gone-agent' }]);
    const notFound: any = new Error('no such container');
    notFound.statusCode = 404;
    mockContainerInspect.mockRejectedValue(notFound);

    const result = await runReconcilePass();

    expect(result!.unverified).toEqual([]);
    expect(result!.reconciled).toBe(1);
    const update = mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE agents'));
    expect(update![1][0]).toBe('stopped');
  });

  it('one unreachable container does not abandon the rest of the pass', async () => {
    selectAgents([
      { id: 'uuid-1', agent_id: 'broken-agent' },
      { id: 'uuid-2', agent_id: 'fine-agent' },
    ]);
    mockContainerInspect
      .mockRejectedValueOnce(proxyUnreachable())
      .mockResolvedValueOnce(runningContainer());

    const result = await runReconcilePass();

    expect(result!.checked).toBe(2);
    expect(result!.unverified).toEqual(['broken-agent']);
    expect(isStatusVerified('fine-agent')).toBe(true);
  });

  it('a pass that fails outright leaves EVERY agent unverified', async () => {
    // The SELECT itself fails, so the pass does not even know which agents it
    // would have covered. Nothing can be reported as verified.
    mockQuery.mockRejectedValueOnce(new Error('database is not accepting connections'));

    const result = await runReconcilePass();

    expect(result).toBeNull();
    expect(reportedStatus('any-agent-at-all', 'running')).toBe('unknown');
  });

  it('a later successful pass clears an agent that an earlier one could not check', async () => {
    selectAgents([{ id: 'uuid-1', agent_id: 'test-agent' }]);
    mockContainerInspect.mockRejectedValueOnce(proxyUnreachable());
    await runReconcilePass();
    expect(reportedStatus('test-agent', 'running')).toBe('unknown');

    // This is what the scheduled re-run buys: a transient fault self-corrects
    // instead of persisting until the next restart.
    selectAgents([{ id: 'uuid-1', agent_id: 'test-agent' }]);
    mockContainerInspect.mockResolvedValueOnce(runningContainer());
    await runReconcilePass();

    expect(reportedStatus('test-agent', 'running')).toBe('running');
  });
});

describe('the API reports the unverified status, not the recorded one', () => {
  /** The single row `GET /agents` selects, recorded as running. */
  function agentRow() {
    return {
      id: 'uuid-1',
      agent_id: 'test-agent',
      name: 'Test',
      status: 'running',
      created_by: 'admin-user',
      skills: [],
    };
  }

  it('POSITIVE CONTROL: GET /agents reports unknown after a failed pass', async () => {
    selectAgents([{ id: 'uuid-1', agent_id: 'test-agent' }]);
    mockContainerInspect.mockRejectedValue(proxyUnreachable());
    await runReconcilePass();

    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe('unknown');
    expect(res.body[0].status_verified).toBe(false);
  });

  it('TWIN: GET /agents reports running after a successful pass', async () => {
    selectAgents([{ id: 'uuid-1', agent_id: 'test-agent' }]);
    mockContainerInspect.mockResolvedValue(runningContainer());
    await runReconcilePass();

    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe('running');
    expect(res.body[0].status_verified).toBe(true);
  });

  it('POSITIVE CONTROL: GET /agents/:id reports unknown after a failed pass', async () => {
    selectAgents([{ id: 'uuid-1', agent_id: 'test-agent' }]);
    mockContainerInspect.mockRejectedValue(proxyUnreachable());
    await runReconcilePass();

    mockQuery
      .mockResolvedValueOnce({ rows: [agentRow()] })   // agent detail
      .mockResolvedValueOnce({ rows: [] });            // skills
    const res = await request(app)
      .get('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
    expect(res.body.status_verified).toBe(false);
  });

  it('TWIN: GET /agents/:id reports running after a successful pass', async () => {
    selectAgents([{ id: 'uuid-1', agent_id: 'test-agent' }]);
    mockContainerInspect.mockResolvedValue(runningContainer());
    await runReconcilePass();

    mockQuery
      .mockResolvedValueOnce({ rows: [agentRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.status_verified).toBe(true);
  });

  it('a stopped row is ALSO reported unknown when nothing was verified — this changed with #239', async () => {
    // This asserted `stopped` until #239. The reason was not that a stopped row
    // is more trustworthy: it was that the reconciler examined only `running`
    // rows, so a stopped row was unverified by construction and would have read
    // `unknown` forever. #239 made the pass read every row and correct in both
    // directions, so a stopped row is now a claim the reconciler backs — and an
    // unchecked one is exactly as unbacked as an unchecked running one.
    mockQuery.mockRejectedValueOnce(new Error('database is not accepting connections'));
    await runReconcilePass();

    mockQuery.mockResolvedValueOnce({ rows: [{ ...agentRow(), status: 'stopped' }] });
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body[0].status).toBe('unknown');
    expect(res.body[0].status_verified).toBe(false);
  });
});
