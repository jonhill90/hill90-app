/**
 * A model-router token nobody renewed is named — in the log at the moment of
 * failure, and to its owner afterwards (#255).
 *
 * THE DEFECT. A failed refresh left nothing on the API side: the 401 branch
 * wrote no row, incremented nothing and logged nothing, and there is no
 * request-logging middleware. A success logs. So the two were distinguishable
 * only by the absence of a line that is never written. The one trace that did
 * exist was a WARNING inside the agent's own container, reachable by someone
 * who already suspected it.
 *
 * The database did hold the signature — `model_router_exp` stops moving while
 * the row stays `running` — and `grep` found no reader for that column beyond
 * its writers and the revoke on stop. Same shape as `container_state` between
 * #239 and #253: correctly stored, read by nobody.
 *
 * WHY THE RECONCILER AND NOT A NEW WATCHER. It already runs every 60s over
 * every agent row and already escalates once per transition. A second watcher
 * would be a second definition of the same thing.
 *
 * WHAT IS DELIBERATELY NOT HERE: #256's orphaned JTI. The real fix there needs
 * the revoke-ordering decision that #245 records as unmade, and taking half of
 * it quietly would make an open decision look settled.
 *
 * NOT EXERCISED, and the same bounds as the issue: no refresh was made to fail
 * against a real service, no expired token was presented to the model-router,
 * no denylist was inspected. `can` means the code permits it.
 */
import request from 'supertest';

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

const mockNotify = jest.fn();
jest.mock('../services/notifications', () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

// The signing key is read into a module-level const at import time, so an env
// var set in `beforeEach` would arrive too late. Mocked rather than handing key
// material to a unit test.
const mockGenerateToken = jest.fn();
jest.mock('../services/model-router-token', () => ({
  isModelRouterConfigured: () => true,
  generateAgentModelRouterToken: (...args: unknown[]) => mockGenerateToken(...args),
}));

import { createApp } from '../app';
import { runReconcilePass, resetTokenExpiryEscalation } from '../services/agent-reconciler';
import { resetStatusVerification } from '../services/agent-status-verification';

const app = createApp({ issuer: 'https://auth.hill90.com/realms/hill90', getSigningKey: async () => 'unused' });

const NOW = Math.floor(Date.now() / 1000);
const EXPIRED = NOW - 60;
const STILL_VALID = NOW + 1800;

function agentRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'uuid-1',
    agent_id: 'test-agent',
    status: 'running',
    container_id: 'container-id-123',
    container_state: 'running',
    created_by: 'owner-sub',
    model_router_exp: STILL_VALID,
    ...over,
  };
}

function selectAgents(rows: Array<ReturnType<typeof agentRow>>) {
  mockQuery.mockResolvedValueOnce({ rows });
}

function runningContainer() {
  return {
    Id: 'container-id-123',
    State: { Status: 'running' },
    Config: { Labels: { 'managed-by': 'hill90-api' } },
  };
}

/** An unverified JWT whose payload names an agent — what the refresh loop sends. */
function bearerFor(sub: string) {
  const payload = Buffer.from(JSON.stringify({ sub, exp: EXPIRED })).toString('base64url');
  return `header.${payload}.signature`;
}

let warn: jest.SpyInstance;

beforeEach(() => {
  mockQuery.mockReset();
  mockContainerInspect.mockReset();
  mockNotify.mockReset();
  resetStatusVerification();
  resetTokenExpiryEscalation();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  warn.mockRestore();
  delete process.env.DATABASE_URL;
});

function warnings() {
  return warn.mock.calls.map((c) => String(c[0]));
}

describe('the refusal names the agent and what did not happen to it', () => {
  it('POSITIVE CONTROL: a refresh that matches no running agent warns, naming the agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });   // no agent matches

    const res = await request(app)
      .post('/internal/model-router/refresh-token')
      .set('Authorization', `Bearer ${bearerFor('test-agent')}`)
      .send({ refresh_secret: 'wrong-secret' });

    expect(res.status).toBe(401);

    const line = warnings().find((l) => l.includes('[model-router-refresh]'));
    expect(line).toBeDefined();
    // WHICH agent — a line nobody can act on is the same as none.
    expect(line).toContain('test-agent');
    // And what did not happen to it, not merely that a request failed.
    expect(line).toContain('NOT renewed');
    expect(line).toMatch(/expire/);
  });

  it('TWIN: a refresh that SUCCEEDS does not warn', async () => {
    // The real twin, not a different failure branch: a warn emitted on every
    // call would satisfy the assertion above while measuring nothing.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', agent_id: 'test-agent', model_router_jti: 'old-jti', model_router_exp: EXPIRED, created_by: 'owner-sub' }] })
      .mockResolvedValueOnce({ rows: [] });   // the rotation UPDATE
    mockGenerateToken.mockResolvedValue({
      token: 'new.jwt.token', jti: 'new-jti', refreshSecret: 'new-secret', expiresAt: STILL_VALID,
    });

    const res = await request(app)
      .post('/internal/model-router/refresh-token')
      .set('Authorization', `Bearer ${bearerFor('test-agent')}`)
      .send({ refresh_secret: 'correct-secret' });

    expect(res.status).toBe(200);
    expect(warnings().filter((l) => l.includes('NOT renewed'))).toHaveLength(0);
  });
});

describe('the signature in the database now has a reader', () => {
  it('POSITIVE CONTROL: a running agent whose token expired is escalated to its OWNER', async () => {
    selectAgents([agentRow({ model_router_exp: EXPIRED, created_by: 'owner-sub' })]);
    mockContainerInspect.mockResolvedValue(runningContainer());

    await runReconcilePass();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [userId, message, type, metadata] = mockNotify.mock.calls[0];
    expect(userId).toBe('owner-sub');
    expect(message).toContain('test-agent');
    expect(message).toContain('not renewed');
    expect(type).toBe('agent_error');
    expect(metadata).toMatchObject({ agent_slug: 'test-agent', model_router_exp: EXPIRED });
  });

  it('TWIN: a token that has not expired is not escalated', async () => {
    // The consistent fixture: with a live token, escalating and not escalating
    // are indistinguishable.
    selectAgents([agentRow({ model_router_exp: STILL_VALID })]);
    mockContainerInspect.mockResolvedValue(runningContainer());

    await runReconcilePass();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('an agent with no model-router token at all is not escalated', async () => {
    selectAgents([agentRow({ model_router_exp: null })]);
    mockContainerInspect.mockResolvedValue(runningContainer());

    await runReconcilePass();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('an agent that is not running is not escalated', async () => {
    selectAgents([agentRow({ status: 'stopped', container_state: 'absent', model_router_exp: EXPIRED })]);
    const gone: any = new Error('no such container');
    gone.statusCode = 404;
    mockContainerInspect.mockRejectedValue(gone);

    await runReconcilePass();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('an agent this pass just demoted is not ALSO told about its token', async () => {
    // It has a louder problem, and two notifications for one event is how a
    // signal becomes noise.
    selectAgents([agentRow({ status: 'running', model_router_exp: EXPIRED })]);
    mockContainerInspect.mockResolvedValue({
      Id: 'container-id-123',
      State: { Status: 'exited' },
      Config: { Labels: { 'managed-by': 'hill90-api' } },
    });

    await runReconcilePass();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('an agent this pass could not verify is not escalated — #250 refuses to claim', async () => {
    const proxyDown: any = new Error('connect ECONNREFUSED /var/run/docker.sock');
    proxyDown.statusCode = 500;
    selectAgents([agentRow({ model_router_exp: EXPIRED })]);
    mockContainerInspect.mockRejectedValue(proxyDown);

    await runReconcilePass();

    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('once per expiry, and the later passes are run to prove it', () => {
  it('a second and third pass over the same stranded token say nothing', async () => {
    mockContainerInspect.mockResolvedValue(runningContainer());

    selectAgents([agentRow({ model_router_exp: EXPIRED })]);
    await runReconcilePass();
    expect(mockNotify).toHaveBeenCalledTimes(1);

    mockNotify.mockReset();
    for (const _pass of [2, 3]) {
      selectAgents([agentRow({ model_router_exp: EXPIRED })]);
      await runReconcilePass();
    }

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('but a NEW expiry escalates again — once per expiry, not once per lifetime', async () => {
    mockContainerInspect.mockResolvedValue(runningContainer());

    selectAgents([agentRow({ model_router_exp: EXPIRED })]);
    await runReconcilePass();
    expect(mockNotify).toHaveBeenCalledTimes(1);

    // A refresh succeeded in between and wrote a new expiry, which has since
    // passed as well. Still in the past — a future expiry would be caught by
    // the TWIN above and would prove nothing here.
    mockNotify.mockReset();
    selectAgents([agentRow({ model_router_exp: EXPIRED + 30 })]);
    await runReconcilePass();

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('a restart forgets, and escalates once more — the stated cost of keeping this in memory', async () => {
    mockContainerInspect.mockResolvedValue(runningContainer());

    selectAgents([agentRow({ model_router_exp: EXPIRED })]);
    await runReconcilePass();
    expect(mockNotify).toHaveBeenCalledTimes(1);

    // What a process restart does to the map. Asserted rather than left as a
    // caveat in a comment, so the cost is visible if it ever stops being
    // acceptable.
    mockNotify.mockReset();
    resetTokenExpiryEscalation();
    selectAgents([agentRow({ model_router_exp: EXPIRED })]);
    await runReconcilePass();

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});
