/**
 * A container that VANISHED is escalated to its owner; one that exited is not.
 *
 * WHY THIS EXISTS AT ALL. #239 stopped the reconciler from flattening "the
 * container is gone" and "the container exited" into a single `stopped`, and
 * kept the difference in `container_state`. Nothing then read it — a grep for
 * `container_state` across the repo returned writers, two passthrough lines in
 * `routes/agents.ts`, and its own tests. A distinction that is computed and
 * discarded is the same waste as the one #238 fixed, one layer up.
 *
 * THE DISTINCTION, which is the whole reason this is worth surfacing rather
 * than merely storing: an `exited` container is an agent that stopped. An
 * `absent` one is a container that someone or something DELETED out from under
 * the API. Only the second is a case a human should hear about.
 *
 * NO-SPAM IS ASSERTED, NOT ARGUED. The claim that this fires once per
 * transition rests on #239's steady-state rule — a pass that agrees with the
 * row writes nothing — and a rule is not evidence. So the second pass is run
 * for real, against the row as the first pass left it.
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

const mockNotify = jest.fn();
jest.mock('../services/notifications', () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
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

function agentRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'uuid-1',
    agent_id: 'test-agent',
    status: 'running',
    container_id: 'container-id-123',
    container_state: 'running',
    created_by: 'owner-sub',
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

function vanished() {
  const err: any = new Error('no such container');
  err.statusCode = 404;
  return err;
}

function statusUpdates() {
  return mockQuery.mock.calls.filter((c) => String(c[0]).startsWith('UPDATE agents'));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockContainerInspect.mockReset();
  mockNotify.mockReset();
  resetStatusVerification();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('deleted is escalated, stopped is not', () => {
  it('POSITIVE CONTROL: a vanished container notifies the agent OWNER', async () => {
    selectAgents([agentRow({ created_by: 'owner-sub' })]);
    mockContainerInspect.mockRejectedValue(vanished());

    await runReconcilePass();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [userId, message, type, metadata] = mockNotify.mock.calls[0];
    expect(userId).toBe('owner-sub');            // the owner, not the actor
    expect(message).toContain('deleted');
    expect(type).toBe('agent_error');
    expect(metadata).toMatchObject({ agent_slug: 'test-agent', container_state: 'absent' });
  });

  it('TWIN: an exited container is demoted in silence', async () => {
    // The same demotion, the same `stopped`, no escalation — which is the
    // entire point of having kept the two apart. If this ever notifies, the
    // distinction has collapsed again and the test above proves nothing.
    selectAgents([agentRow()]);
    mockContainerInspect.mockResolvedValue(container('exited'));

    await runReconcilePass();

    expect(statusUpdates()).toHaveLength(1);   // it WAS demoted
    expect(mockNotify).not.toHaveBeenCalled(); // and said nothing about it
  });

  it('an unverifiable container is not escalated either — cannot tell is not deleted', async () => {
    const proxyDown: any = new Error('connect ECONNREFUSED /var/run/docker.sock');
    proxyDown.statusCode = 500;
    selectAgents([agentRow()]);
    mockContainerInspect.mockRejectedValue(proxyDown);

    await runReconcilePass();

    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('it fires once, and the second pass is run to prove it', () => {
  it('a second pass over the row the first pass wrote notifies nothing and writes nothing', async () => {
    // Pass one: recorded running, container gone.
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockRejectedValue(vanished());
    await runReconcilePass();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const firstUpdate = statusUpdates();
    expect(firstUpdate).toHaveLength(1);
    expect(firstUpdate[0][1][0]).toBe('stopped');
    expect(firstUpdate[0][1][1]).toBe('absent');

    // Pass two, over the row AS THE FIRST PASS LEFT IT — status `stopped`,
    // container_state `absent` — with the container still gone.
    mockQuery.mockReset();
    mockNotify.mockReset();
    selectAgents([agentRow({ status: 'stopped', container_id: null, container_state: 'absent' })]);
    const result = await runReconcilePass();

    expect(result!.reconciled).toBe(0);
    expect(statusUpdates()).toHaveLength(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a third and fourth pass stay quiet too', async () => {
    // Because "fires once" must mean once, not once per two passes.
    mockContainerInspect.mockRejectedValue(vanished());
    for (const _pass of [1, 2]) {
      selectAgents([agentRow({ status: 'stopped', container_id: null, container_state: 'absent' })]);
      await runReconcilePass();
    }

    expect(statusUpdates()).toHaveLength(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('but a NEW vanishing is escalated again', async () => {
    // The agent was restarted and its container deleted a second time. Fire
    // once per transition, not once per lifetime.
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockRejectedValue(vanished());
    await runReconcilePass();
    expect(mockNotify).toHaveBeenCalledTimes(1);

    mockQuery.mockReset();
    mockNotify.mockReset();
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    await runReconcilePass();

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});

describe('the published spec describes what the API actually returns', () => {
  it('the Agent schema admits `unknown` and documents `container_state`', async () => {
    // The spec is the document a consumer reads FIRST, so a spec that describes
    // a status the API no longer returns is the same defect as the code — it
    // said `enum: [stopped, running, error]` after #250 began serving `unknown`.
    const res = await request(app)
      .get('/openapi.json')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const agent = res.body.components.schemas.Agent.properties;
    expect(agent.status.enum).toContain('unknown');
    expect(agent.container_state).toBeDefined();
    expect(agent.container_state.enum).toContain('absent');
    expect(agent.status_verified).toBeDefined();
  });
});
