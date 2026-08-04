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
 * Originally added on the theory that the repeating CI failure was a crossed
 * body from the neighbouring test: every test shared one THREAD_ID, and the
 * test before the failing one returns exactly
 * `{ id: THREAD_ID, agent: { status: 'unknown' } }` — the observed value. With
 * shared ids that was indistinguishable from the test's own response.
 *
 * **That theory is REFUTED, and these ids are what refuted it.** On the next
 * run the id assertion PASSED against a per-test id, so the body did belong to
 * this test. They stay because an identity check on an identifier that cannot
 * distinguish anything is not a check — see
 * `docs/decisions/api-suite-flakiness.md`, where "is the response ours?" is the
 * central question. They are no longer evidence for a crossing.
 *
 * What survives is a contradiction, unresolved as of this commit: the stub
 * served `stopped` exactly once, the body carries this test's own id, and the
 * status came back `unknown`, which `reportedStatus` cannot produce from
 * `stopped`. `dumpResponse` below exists to read that instead of inferring it.
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
 * THE PROBE. The last assumption standing, made checkable.
 *
 * `servedParticipantStatuses` records the status string the stub *decided on*,
 * not the row object the route *read*. Those have been treated as identical
 * because they come from the same object literal — the only unexamined step
 * left between "served stopped" and a body saying "unknown".
 *
 * Two things are captured per served row, and the difference between them is
 * the finding:
 *
 *   snapshot — a deep copy taken at serve time, frozen in the past.
 *   live     — the very object handed to the route.
 *
 * If `live` has drifted from `snapshot` by the time the dump runs, something
 * MUTATED the row after the query returned. That is a live possibility rather
 * than a fishing expedition: the thread-detail and participants-update routes
 * in `chat.ts` deliberately mutate their participant rows in place
 * (`p.agent_status = status`), and a shared or reused row object would carry
 * that across.
 *
 * `sqlSeen` records every statement the route issued, so a second participants
 * query — or one taking a branch this stub does not model — is visible instead
 * of inferred.
 */
let servedParticipantRows: Array<{ snapshot: any; live: any }> = [];
let sqlSeen: string[] = [];

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
    sqlSeen.push(text.replace(/\s+/g, ' ').trim().slice(0, 90));
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
      const row = {
        thread_id: THREAD_ID,
        participant_id: AGENT_UUID,
        participant_type: 'agent',
        role: 'member',
        left_at: null,
        agent_id: AGENT_SLUG,
        agent_name: 'TestBot',
        agent_status: recordedStatus,
      };
      servedParticipantRows.push({ snapshot: JSON.parse(JSON.stringify(row)), live: row });
      return { rows: [row] };
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

/**
 * Everything needed to tell the candidate causes apart, printed on failure.
 *
 * This assertion has now failed four times in CI and zero times locally across
 * 15 runs and every worker configuration, so the body has never once been in a
 * debugger. Four rounds were spent narrowing by elimination when a single dump
 * would have decided it. That is the actual defect being fixed here.
 *
 * `x-test-app-id` is `jest.identityguard.js`'s stamp — `${pid}:${workerId}` of
 * whichever worker wrote the response. Reading it directly matters because
 * "the guard stayed silent" is an INFERENCE that the stamp was right, and this
 * record documents two holes found in that guard after it was working, with its
 * third arm still uncontrolled. A guard that has lost an arm reports clean.
 *
 * What the three outcomes mean (see docs/decisions/api-suite-flakiness.md):
 *
 *   stamp ABSENT      → not this suite at all; a foreign responder on a
 *                       colliding ephemeral port. The LogiPluginService class.
 *   stamp DIFFERENT   → a sibling jest worker answered. The mechanism the
 *                       investigation has demonstrated capable but never
 *                       observed occurring naturally.
 *   stamp OURS, body  → the falsifier the record names for the sibling-worker
 *   wrong               hypothesis: "a correct stamp with a wrong body". Would
 *                       be the first instance, and would move the whole
 *                       investigation — so it must be read, never inferred.
 */
function dumpResponse(res: request.Response): string {
  const stamp = res.headers?.['x-test-app-id'];
  const ours = `${process.pid}:${process.env.JEST_WORKER_ID || '0'}`;
  const verdict =
    stamp === undefined ? 'ABSENT — foreign responder, not this suite'
    : stamp === ours ? 'OURS — this worker wrote it'
    : `DIFFERENT — a sibling worker wrote it (ours is ${ours})`;
  const raw = typeof res.text === 'string' ? res.text.slice(0, 2000) : '<no raw text>';
  return [
    '',
    '--- response diagnostics (#251, docs/decisions/api-suite-flakiness.md) ---',
    `  identity stamp   : ${stamp ?? '<absent>'}`,
    `  stamp verdict    : ${verdict}`,
    `  http status      : ${res.status}`,
    `  content-type     : ${res.headers?.['content-type'] ?? '<none>'}`,
    `  expected thread  : ${THREAD_ID}`,
    `  expected agent   : ${AGENT_SLUG} (${AGENT_UUID})`,
    `  statuses served  : ${JSON.stringify(servedParticipantStatuses)}`,
    `  rows served      : ${servedParticipantRows.length}`,
    ...servedParticipantRows.flatMap((r, i) => {
      const liveNow = JSON.stringify(r.live);
      const atServe = JSON.stringify(r.snapshot);
      return [
        `    [${i}] at serve time : ${atServe}`,
        `    [${i}] live now      : ${liveNow}`,
        `    [${i}] MUTATED?      : ${liveNow === atServe ? 'no — identical' : 'YES — the route changed the row in place'}`,
      ];
    }),
    `  sql issued       : ${servedParticipantRows.length === 0 && sqlSeen.length === 0 ? '<none>' : ''}`,
    ...sqlSeen.map((q, i) => `    [${i}] ${q}`),
    `  parsed body      : ${JSON.stringify(res.body)}`,
    `  raw text         : ${raw}`,
    '--------------------------------------------------------------------------',
  ].join('\n');
}

/**
 * Assert the agent status, and make the failure readable in one pass.
 *
 * Wraps rather than replaces the assertions so jest still prints its own diff;
 * the dump is appended to the message. Covers `threadFrom`'s checks too, since
 * a wrong id and a wrong status need the same evidence to tell apart.
 */
function expectAgentStatus(res: request.Response, expected: string) {
  try {
    expect(threadFrom(res).agent.status).toBe(expected);
  } catch (err: any) {
    err.message = `${err.message}\n${dumpResponse(res)}`;
    throw err;
  }
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
  servedParticipantRows = [];
  sqlSeen = [];
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
    expectAgentStatus(res, 'unknown');
    const t = threadFrom(res);
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
    expectAgentStatus(res, 'running');
    const t = threadFrom(res);
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
    expectAgentStatus(res, 'unknown');
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
    expectAgentStatus(res, 'stopped');
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
