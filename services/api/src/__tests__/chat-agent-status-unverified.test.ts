/**
 * The chat routes must report an unverified agent status as `unknown` too (#251).
 *
 * #250 added the third state and applied it in `routes/agents.ts` — the list
 * route and the detail route. But every chat surface in the UI reads its agent
 * status from `GET /chat/threads`, not from `/agents`: `ChatView`,
 * `AgentStatusBar`, `MentionInput` and `ThreadList` all render
 * `thread.agent` / `thread.agents`. On that path the status came straight out
 * of the join, unmapped, so the distinction the reconciler had already computed
 * was dropped one hop before the screen.
 *
 * That is the repo's named recurring cause, not a new one: #141 existed because
 * the clamp sat on the export endpoint and not its twin, and #153 because that
 * fix went to one route and not the other. This is the same shape — a correct
 * mechanism wired to one of its two consumers.
 *
 * THE POSITIVE CONTROL. A fixture whose docker dependency WORKS cannot separate
 * broken from fixed: the reconciler agrees with the database and `running` comes
 * out of both versions unchanged. Only a fixture where `inspectContainer` throws
 * a non-404 shows the difference, so every case below is paired with its twin on
 * a healthy dependency. If the `unknown` assertion ever passes for both, this
 * file has stopped measuring anything.
 *
 * NOT COVERED, on purpose: the dispatch gates. `POST /chat/threads` and
 * `POST /chat/threads/:id/messages` still test the RECORDED row, so an agent we
 * could not verify is still allowed a message. Unverifiable is not absent, and
 * refusing to dispatch on missing evidence would convert a reporting fix into a
 * functional restriction — a worse defect than the one being fixed. The last
 * test in this file pins that, so a later reader tidying the two into
 * consistency has to delete an assertion that says why not.
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

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});
const adminToken = jwt.sign(
  { sub: 'admin-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
);

/**
 * A DISTINCT thread and agent per test, which is the point rather than tidiness.
 *
 * Three CI runs failed here with `Expected "stopped", Received "unknown"` while
 * every local run passed. The instrumentation settled it: `expectServed`
 * passed, so the route was handed `stopped` exactly once — and `reportedStatus`
 * returns anything that is not `running` unchanged, so that run cannot have
 * produced `unknown`. The body being read therefore belonged to a different
 * request. The one immediately before it, `a pass that fails outright…`,
 * returns exactly `{ id: THREAD_ID, agent: { status: 'unknown' } }`.
 *
 * The id guard could not see that, because every test used the SAME thread id,
 * so a crossed response was indistinguishable from its own. Per-test ids close
 * that: a stale or crossed body now fails on identity, which is what the guard
 * was for. See `docs/decisions/api-suite-flakiness.md` — "is the response
 * ours?" only answers anything if the fixtures can tell each other apart.
 */
let AGENT_UUID = '';
let THREAD_ID = '';
let AGENT_SLUG = '';
let fixtureSeq = 0;

function freshFixtureIds() {
  fixtureSeq += 1;
  const n = String(fixtureSeq).padStart(12, '0');
  THREAD_ID = `11111111-2222-3333-4444-${n}`;
  AGENT_UUID = `aaaaaaaa-bbbb-cccc-dddd-${n}`;
  AGENT_SLUG = `test-agent-${fixtureSeq}`;
}

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
 * What the stub actually handed the route for the participants query, in order.
 *
 * This exists because a CI failure reported `Received: "unknown"` where the
 * fixture said `stopped`, and that symptom has two very different causes which
 * the assertion could not separate: the stub was not the active implementation,
 * or the route mapped a correct row wrongly. `reportedStatus` returns `unknown`
 * only when handed `running`, so recording what was served decides it. A test
 * that reports a symptom it cannot locate costs more than it saves.
 */
let servedParticipantStatuses: string[] = [];

/**
 * Route the pool by SQL shape rather than by call order. GET /chat/threads
 * issues its page and its COUNT through Promise.all, and an order-dependent
 * mock would pin an implementation detail instead of the behaviour.
 *
 * `recordedStatus` is what the DATABASE holds, and it is a parameter rather
 * than something a caller patches on afterwards. An earlier version of this
 * file built the stopped case by capturing `getMockImplementation()` and
 * wrapping it; that made one test's fixture depend on another's leftovers for
 * no benefit, and when it failed in CI the wrapper was one of two candidate
 * causes that could not be told apart. A parameter has no such failure mode.
 */
function stubChatQueries(recordedStatus = 'running') {
  mockQuery.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('COUNT(*) AS total')) return { rows: [{ total: '1' }] };
    if (text.includes('FROM chat_threads')) {
      return {
        rows: [{
          id: THREAD_ID,
          type: 'direct',
          title: 'Test Chat',
          created_by: 'admin-user',
          created_at: '2026-08-04T00:00:00Z',
          updated_at: '2026-08-04T00:00:00Z',
          last_message: 'hello',
        }],
      };
    }
    if (text.includes('FROM chat_participants')) {
      servedParticipantStatuses.push(recordedStatus);
      return {
        rows: [{
          thread_id: THREAD_ID,
          participant_id: AGENT_UUID,
          participant_type: 'agent',
          role: 'member',
          left_at: null,
          agent_id: AGENT_SLUG,
          agent_name: 'TestBot',
          agent_status: recordedStatus,
        }],
      };
    }
    return { rows: [] };
  });
}

/**
 * Assert the route was fed exactly what this test intended before judging what
 * it produced. Separates "the fixture did not apply" from "the mapping is
 * wrong" — see `servedParticipantStatuses`.
 */
function expectServed(recordedStatus: string) {
  expect(servedParticipantStatuses).toEqual([recordedStatus]);
}

/**
 * Assert the response is the one THIS test set up before reading anything out
 * of it.
 *
 * This suite runs under `jest.identityguard.js`, but the api suite has a long
 * history of answers arriving from somewhere else — a sibling worker, or a
 * foreign daemon on the port supertest bound (see
 * `docs/decisions/api-suite-flakiness.md`). A body that is merely *shaped*
 * right can satisfy a status assertion while belonging to another test; this
 * pins the thread id so that case fails as a wrong id rather than as a
 * confusing wrong status.
 */
function threadFrom(res: request.Response) {
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body[0]?.id).toBe(THREAD_ID);
  return res.body[0];
}

/** Drive one reconcile pass over a single running agent. */
async function reconcileWith(inspect: () => any, rejects: boolean) {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_UUID, agent_id: AGENT_SLUG }] });
  if (rejects) mockContainerInspect.mockRejectedValue(inspect());
  else mockContainerInspect.mockResolvedValue(inspect());
  await runReconcilePass();
}

beforeEach(() => {
  freshFixtureIds();
  mockQuery.mockReset();
  mockContainerInspect.mockReset();
  servedParticipantStatuses = [];
  resetStatusVerification();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('GET /chat/threads carries the third state to the chat surfaces', () => {
  it('POSITIVE CONTROL: an unverifiable agent is reported unknown, not running', async () => {
    await reconcileWith(proxyUnreachable, true);
    stubChatQueries();

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`);

    // The database still says `running`. The API must not repeat that as fact.
    expectServed('running');
    const t = threadFrom(res);
    expect(t.agent.status).toBe('unknown');
    expect(t.agent.status_verified).toBe(false);
    expect(t.agents[0].status).toBe('unknown');
  });

  it('TWIN: the same fixture on a working dependency reports running', async () => {
    await reconcileWith(runningContainer, false);
    stubChatQueries();

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`);

    expectServed('running');
    const t = threadFrom(res);
    expect(t.agent.status).toBe('running');
    expect(t.agent.status_verified).toBe(true);
    expect(t.agents[0].status).toBe('running');
  });

  it('a pass that fails outright leaves the thread payload unknown as well', async () => {
    // The reconciler's own SELECT fails, so it does not even know which agents
    // it would have covered.
    mockQuery.mockRejectedValueOnce(new Error('database is not accepting connections'));
    await runReconcilePass();
    stubChatQueries();

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`);

    expectServed('running');
    expect(threadFrom(res).agent.status).toBe('unknown');
  });

  it('a stopped row stays stopped — #239 is a different defect, not this one', async () => {
    mockQuery.mockRejectedValueOnce(new Error('database is not accepting connections'));
    await runReconcilePass();
    // Nothing is verified, and the row still must not be reported as unknown:
    // only a `running` claim is one this reconciler backs.
    stubChatQueries('stopped');

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`);

    expectServed('stopped');
    expect(threadFrom(res).agent.status).toBe('stopped');
  });

  it('a thread with no agent participant is untouched, not crashed', async () => {
    await reconcileWith(proxyUnreachable, true);
    stubChatQueries();
    const withParticipants = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM chat_participants') ? { rows: [] } : withParticipants(sql)
    );

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`);

    const t = threadFrom(res);
    expect(t.agent).toBeUndefined();
    expect(t.agents).toEqual([]);
  });
});

describe('the dispatch gate is deliberately NOT wired to verification', () => {
  it('an unverifiable agent is still allowed to be messaged', async () => {
    // If someone "tidies" the gate into consistency with the reporting change,
    // a docker-proxy blip stops being a yellow dot and starts being an outage.
    // That is a worse defect than the one #251 fixes, so it is pinned here.
    await reconcileWith(proxyUnreachable, true);

    mockQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      // getThreadType — a direct thread, so "all agents unavailable" is the
      // 409 branch this test exists to stay out of.
      if (text.includes('FROM chat_threads')) {
        return { rows: [{ id: THREAD_ID, type: 'direct', lead_agent_id: null }] };
      }
      // getThreadAgents
      if (text.includes('FROM chat_participants')) {
        return { rows: [{ participant_id: AGENT_UUID }] };
      }
      // getAgentForDispatch — the RECORDED row, which is what the gate reads.
      // The agent has been left unverified by the failed pass above, so if the
      // gate ever consulted verification this would be classified not_running.
      if (text.includes('FROM agents a')) {
        return {
          rows: [{
            id: AGENT_UUID,
            agent_id: AGENT_SLUG,
            name: 'TestBot',
            status: 'running',
            work_token: 'tok-123',
            models: [],
          }],
        };
      }
      // Per-agent concurrency guard: nothing pending.
      if (text.includes('FROM chat_messages')) return { rows: [] };
      if (text.includes('INSERT INTO chat_messages')) {
        return { rows: [{ id: 'msg-1', seq: 1 }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`/chat/threads/${THREAD_ID}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'are you there?' });

    // The gate did not consult verification state, so the request got past it.
    // Asserting only `not 409` would also pass on an early 400, which would be
    // a test that cannot fail for the reason it exists — so pin the success.
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('not running');
  });
});
