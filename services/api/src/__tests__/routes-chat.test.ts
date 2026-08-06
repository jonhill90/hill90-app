import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

// Generate RSA keypair for test signing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

// Mock pg pool
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  // `connect` is backed by the SAME mockQuery as the pool, so the transactional
  // paths (thread create) and the non-transactional ones are asserted through one
  // mock — every existing expectation keeps testing what it tested before.
  // BEGIN/COMMIT/ROLLBACK fall through to the default implementation.
  getPool: () => ({
    query: mockQuery,
    connect: async () => ({
      // BEGIN/COMMIT/ROLLBACK are answered WITHOUT consuming the mock queue.
      // These tests queue responses in order with mockResolvedValueOnce, so
      // letting transaction control take a slot would shift every subsequent
      // expectation by two and fail them for a reason that has nothing to do
      // with what they assert. Data statements still go to mockQuery, so each
      // test exercises the same sequence it always did.
      query: (sql: unknown, params?: unknown) =>
        typeof sql === 'string' && /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)
          ? Promise.resolve({ rows: [], rowCount: 0 })
          : mockQuery(sql, params),
      release: () => {},
    }),
  }),
}));

// Mock docker service (needed because agents.ts is imported transitively)
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: jest.fn(),
}));

jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn(),
  reconcileToolInstalls: jest.fn(),
}));

// Mock chat dispatch
const mockDispatchChatWork = jest.fn().mockResolvedValue({ accepted: true, work_id: 'work-123' });
jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: (...args: any[]) => mockDispatchChatWork(...args),
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);
const userToken = makeToken('regular-user', ['user']);
const otherUserToken = makeToken('other-user', ['user']);
const noRoleToken = makeToken('no-role-user', []);

// ── Thread CRUD (Phase 1 preserved + Phase 1B extensions) ──

describe('Chat thread CRUD', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('GET /chat/threads requires auth', async () => {
    const res = await request(app).get('/chat/threads');
    expect(res.status).toBe(401);
  });

  it('GET /chat/threads requires user role', async () => {
    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /chat/threads returns threads for participant with agent info', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: 'thread-1', type: 'direct', title: 'Test', created_by: 'regular-user',
            created_at: new Date(), updated_at: new Date(), last_message: 'Hello', last_author_type: 'human' },
        ],
      })
      // The count query now runs alongside the page query (Promise.all), so
      // it is the SECOND call and the participant enrichment is the third.
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          { thread_id: 'thread-1', participant_id: 'agent-uuid', participant_type: 'agent',
            role: 'member', left_at: null, agent_id: 'test-agent', agent_name: 'Test Agent', agent_status: 'running' },
        ],
      });

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('thread-1');
    expect(res.body[0].agents).toHaveLength(1);
    expect(res.body[0].agent.name).toBe('Test Agent');
  });

  it('GET /chat/threads admin sees all', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // Admin query should NOT join participants
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).not.toContain('participant_id = $1');
  });

  // ── #185: the list is bounded, and the total is not the page ──────────
  //
  // The issue title said "volume". Checked before assuming: the admin branch
  // having no WHERE is DELIBERATE and matches scopeToOwner (admin -> no
  // filter) and isParticipant (admin bypass), so this is a volume bound, not
  // an authorization change. Both facts are asserted below so a later reader
  // does not "fix" the admin branch into scoping and silently change who can
  // see what.

  it('caps the page and reports a total that DIFFERS from it', async () => {
    // Two rows on the page, forty thousand in the world. The numbers must
    // disagree or a `rows.length` implementation passes this unnoticed.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 't1' }, { id: 't2' }] })
      .mockResolvedValueOnce({ rows: [{ total: '40000' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/chat/threads?limit=2')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.headers['x-total-count']).toBe('40000');
  });

  it('counts the SAME scope as the page it returned', async () => {
    // A count over a different scope reports someone else's thread count to
    // this user. Both statements must carry the participant predicate.
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`);

    const pageSql = mockQuery.mock.calls[0][0];
    const countSql = mockQuery.mock.calls[1][0];
    expect(pageSql).toContain("cp.participant_type = 'human'");
    expect(countSql).toContain("cp.participant_type = 'human'");
    expect(countSql).toContain('COUNT(*)');
    expect(mockQuery.mock.calls[1][1]).toEqual(['regular-user']);
  });

  it('the admin count is over every thread, matching the admin page', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 't1' }] })
      .mockResolvedValueOnce({ rows: [{ total: '9' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/chat/threads?limit=1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.headers['x-total-count']).toBe('9');
    // Still no participant filter — admin scope is unchanged by this PR.
    expect(mockQuery.mock.calls[1][0]).not.toContain('participant_id');
  });

  it('pages deterministically, with an id tiebreak on a non-unique sort key', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/chat/threads?limit=10&offset=20')
      .set('Authorization', `Bearer ${userToken}`);

    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('ORDER BY t.updated_at DESC, t.id DESC');
    expect(sql).toContain('LIMIT');
    expect(mockQuery.mock.calls[0][1]).toEqual(['regular-user', 10, 20]);
  });

  it.each([
    ['limit=0', 'limit must be between'],
    ['limit=5000', 'limit must be between'],
    ['limit=abc', 'limit must be an integer'],
    ['offset=-1', 'offset must be >= 0'],
  ])('rejects %s rather than silently clamping', async (qs, message) => {
    const res = await request(app)
      .get(`/chat/threads?${qs}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(message);
  });

  it('POST /chat/threads creates direct thread and dispatches', async () => {
    mockQuery
      .mockResolvedValueOnce({  // getAgentForDispatch
        rows: [{
          id: 'agent-uuid', agent_id: 'test-agent', name: 'Test Agent', status: 'running',
          work_token: 'wt-123', models: ['gpt-4o-mini'],
        }],
      })
      .mockResolvedValueOnce({ rows: [] })  // getAgentElevatedScope
      .mockResolvedValueOnce({  // INSERT thread
        rows: [{
          id: 'thread-uuid', type: 'direct', title: null,
          created_by: 'regular-user', created_at: new Date(), updated_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })  // INSERT participants
      .mockResolvedValueOnce({  // INSERT user message
        rows: [{ id: 'user-msg-uuid', seq: 1 }],
      })
      .mockResolvedValueOnce({  // INSERT assistant placeholder
        rows: [{ id: 'placeholder-uuid' }],
      });

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid', message: 'Hello agent' });

    expect(res.status).toBe(201);
    expect(res.body.thread.id).toBe('thread-uuid');
    expect(res.body.message_id).toBe('placeholder-uuid');

    // Verify dispatch was called
    expect(mockDispatchChatWork).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'test-agent',
      workToken: 'wt-123',
      threadId: 'thread-uuid',
      messageId: 'placeholder-uuid',
      model: 'gpt-4o-mini',
    }));
  });

  it('POST /chat/threads creates group thread with agent_ids', async () => {
    mockQuery
      // getAgentForDispatch for agent 1
      .mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', agent_id: 'agent-alpha', name: 'Alpha', status: 'running',
          work_token: 'wt-1', models: ['gpt-4o-mini'],
        }],
      })
      // getAgentForDispatch for agent 2
      .mockResolvedValueOnce({
        rows: [{
          id: 'agent-2', agent_id: 'agent-beta', name: 'Beta', status: 'running',
          work_token: 'wt-2', models: ['gpt-4o'],
        }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope agent 1
      .mockResolvedValueOnce({ rows: [] })  // elevated scope agent 2
      .mockResolvedValueOnce({  // INSERT thread
        rows: [{
          id: 'group-thread', type: 'group', title: null,
          created_by: 'regular-user', created_at: new Date(), updated_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })  // INSERT participants
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 1 }] })  // user message
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder agent 1
      .mockResolvedValueOnce({ rows: [{ id: 'ph-2' }] });  // placeholder agent 2

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_ids: ['agent-1', 'agent-2'], message: 'Hello group' });

    expect(res.status).toBe(201);
    expect(res.body.thread.type).toBe('group');
    expect(res.body.dispatched).toHaveLength(2);
    expect(res.body.skipped).toHaveLength(0);
    expect(res.body.failed).toHaveLength(0);
  });

  it('POST /chat/threads rejects >8 agents (I4)', async () => {
    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_ids: ['a1','a2','a3','a4','a5','a6','a7','a8','a9'],
        message: 'Too many agents',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Maximum 8');
  });

  it('POST /chat/threads rejects missing agent_id', async () => {
    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agent_id');
  });

  it('POST /chat/threads rejects missing message', async () => {
    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('message');
  });

  it('POST /chat/threads returns 403 for elevated agent + non-admin (strict deny)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', name: 'Test', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] }); // elevated scope found

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid', message: 'Hello' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host_docker');
  });

  it('POST /chat/threads group: strict elevated deny rejects entire request if ANY target agent is elevated (I13)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'safe', name: 'Safe Agent', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-2', agent_id: 'elevated', name: 'Elevated Agent', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // safe agent — no elevated scope
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] });  // elevated agent

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_ids: ['agent-1', 'agent-2'], message: 'Hello' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Elevated');
  });

  it('POST /chat/threads group: skips stopped agents, dispatches running (I3 + skipped[])', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'running-one', name: 'Running', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-2', agent_id: 'stopped-one', name: 'Stopped', status: 'stopped', work_token: null, models: [] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope 1
      .mockResolvedValueOnce({ rows: [] })  // elevated scope 2
      .mockResolvedValueOnce({  // INSERT thread
        rows: [{ id: 'group-thread', type: 'group', title: null, created_by: 'regular-user', created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [] })  // INSERT participants
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 1 }] })  // user message
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] });  // placeholder for running agent

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_ids: ['agent-1', 'agent-2'], message: 'Hello' });

    expect(res.status).toBe(201);
    expect(res.body.dispatched).toHaveLength(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toBe('not_running');
  });

  it('GET /chat/threads/:id returns thread with messages', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({  // thread
        rows: [{ id: 'thread-1', type: 'direct', title: 'Test', created_by: 'regular-user',
                 created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [  // participants
        { participant_id: 'regular-user', participant_type: 'human', role: 'owner',
          joined_at: new Date(), left_at: null, agent_id: null, agent_name: null, agent_status: null },
      ]})
      .mockResolvedValueOnce({ rows: [  // messages page
        { id: 'msg-1', seq: 1, author_id: 'regular-user', author_type: 'human', role: 'user',
          content: 'Hello', status: 'complete', reply_to: null, target_agents: null,
          created_at: new Date().toISOString() },
      ]})
      // The page and its COUNT(*) now run together (#203).
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app)
      .get('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  // Cleanup path 3 (thread load) said "Response timed out" — a claim about
  // WHY that the code has no way to know is true. agentbox's own callback
  // delivery is fire-and-forget with no retry, so a message stuck 'pending'
  // this long may just as easily be one whose agent already answered and
  // whose callback got lost, as one that is genuinely still unanswered.
  // Found alongside the interval sweeper below, which said the identical
  // false thing for the identical reason — this is the other of the two
  // places that write it.
  it('a stale pending message reconciled on thread load says only what was observed, not a claim about why', async () => {
    const staleCreatedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // > STALE_TIMEOUT_MS (2m)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({
        rows: [{ id: 'thread-1', type: 'direct', title: 'Test', created_by: 'regular-user',
                 created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [] })  // participants
      .mockResolvedValueOnce({ rows: [
        { id: 'msg-stale', seq: 1, author_id: 'agent-1', author_type: 'agent', role: 'assistant',
          content: '', status: 'pending', reply_to: null, target_agents: null,
          created_at: staleCreatedAt },
      ]})
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [] });  // the reconciliation UPDATE itself

    const res = await request(app)
      .get('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages[0].status).toBe('error');
    // THE ASSERTION THAT MATTERS: an observation, not a diagnosis.
    expect(res.body.messages[0].error_message).toBe('No response received within 2 minutes');
    expect(res.body.messages[0].error_message).not.toMatch(/timed out/i);

    const updateCall = mockQuery.mock.calls.find(
      ([sql, params]) => typeof sql === 'string'
        && sql.includes("SET status = 'error'")
        && sql.includes('chat_messages')
        && Array.isArray(params) && params.includes('No response received within 2 minutes')
    );
    expect(updateCall).toBeDefined();
  });

  // ── #203: the thread body is bounded, and the truncation is not silent ──
  //
  // Two things must hold together, and a fixture that checks only one is
  // passed by a different broken implementation:
  //   * the total DISAGREES with the page (3 vs 2) — else `messages.length`
  //     passes, and a total derived from the page always agrees with itself;
  //   * the page is the NEWEST end — else a naive `LIMIT` on the existing
  //     `ORDER BY seq ASC` passes while showing a user the start of a
  //     conversation instead of the message just sent.

  function threadPreamble() {
    return mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({                        // thread
        rows: [{ id: 'thread-1', type: 'direct', title: 'Test', created_by: 'regular-user',
                 created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [] });           // participants
  }

  function msg(seq: number) {
    return { id: `msg-${seq}`, seq, author_id: 'regular-user', author_type: 'human',
             role: 'user', content: `m${seq}`, status: 'complete', reply_to: null,
             target_agents: null, created_at: new Date().toISOString() };
  }

  it('returns the NEWEST page and a total that DIFFERS from it', async () => {
    // The route selects seq DESC then reverses, so the driver hands back
    // newest-first exactly as Postgres would.
    threadPreamble()
      // limit=2, so the route asks for 3; the third row is the probe that
      // proves older messages exist without a second query.
      .mockResolvedValueOnce({ rows: [msg(3), msg(2), msg(1)] })
      .mockResolvedValueOnce({ rows: [{ total: '3' }] });  // COUNT over the same WHERE

    const res = await request(app)
      .get('/chat/threads/thread-1?limit=2')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.message_total).toBe(3);
    expect(res.body.has_older).toBe(true);

    // Newest two, presented oldest-first for display. Seq 1 is absent: that is
    // the point — the tail is what a reader needs, not the head.
    expect(res.body.messages.map((m: any) => m.seq)).toEqual([2, 3]);
  });

  it('asks the database for the newest rows, not the oldest', async () => {
    threadPreamble()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    await request(app)
      .get('/chat/threads/thread-1?limit=10')
      .set('Authorization', `Bearer ${userToken}`);

    const sql = mockQuery.mock.calls[3][0];
    expect(sql).toContain('ORDER BY seq DESC');
    expect(sql).toContain('LIMIT');
  });

  it('counts the same WHERE as the page', async () => {
    threadPreamble()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    await request(app)
      .get('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`);

    const countSql = mockQuery.mock.calls[4][0];
    expect(countSql).toContain('COUNT(*)');
    expect(countSql).toContain('thread_id = $1');
    expect(mockQuery.mock.calls[4][1]).toEqual(['thread-1']);
  });

  it('walks backwards with before_seq rather than an offset', async () => {
    threadPreamble()
      .mockResolvedValueOnce({ rows: [msg(1)] })
      .mockResolvedValueOnce({ rows: [{ total: '3' }] });

    const res = await request(app)
      .get('/chat/threads/thread-1?limit=2&before_seq=2')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls[3][0];
    // seq is bumped by the stale reconcile (`seq = nextval(...)`), so the head
    // of this table reorders. An OFFSET over that skips and repeats rows.
    expect(sql).toContain('seq <');
    expect(sql).not.toContain('OFFSET');
    expect(res.body.has_older).toBe(false);  // 1 message at seq 1, nothing older
  });

  it('says has_older is false when the page IS the whole thread', async () => {
    threadPreamble()
      .mockResolvedValueOnce({ rows: [msg(2), msg(1)] })   // fewer than the probe asked for
      .mockResolvedValueOnce({ rows: [{ total: '2' }] });

    const res = await request(app)
      .get('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.body.message_total).toBe(2);
    expect(res.body.has_older).toBe(false);
  });

  it.each([
    ['limit=0', 'limit must be between'],
    ['limit=5000', 'limit must be between'],
    ['before_seq=abc', 'before_seq must be an integer'],
  ])('rejects %s rather than silently clamping', async (qs, message) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // isParticipant

    const res = await request(app)
      .get(`/chat/threads/thread-1?${qs}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(message);
  });

  it('GET /chat/threads/:id returns 404 for non-participant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not a participant

    const res = await request(app)
      .get('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT /chat/threads/:id updates title for owner', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({  // UPDATE
        rows: [{ id: 'thread-1', type: 'direct', title: 'New Title', created_by: 'regular-user',
                 created_at: new Date(), updated_at: new Date() }],
      });

    const res = await request(app)
      .put('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ title: 'New Title' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New Title');
  });

  it('DELETE /chat/threads/:id works for owner', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({ rowCount: 1 });  // DELETE

    const res = await request(app)
      .delete('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ── Participant management ──

describe('Chat participant management', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('PUT /chat/threads/:id/participants adds agent (I5)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({ rows: ['agent-1'] })  // getThreadAgents (count check)
      .mockResolvedValueOnce({ rows: [] })  // elevated scope check
      .mockResolvedValueOnce({ rows: [] })  // INSERT participant
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-1' }, { participant_id: 'agent-2' }] })  // getThreadAgents (auto-promote)
      .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE type = 'group'
      .mockResolvedValueOnce({ rows: [  // return participants
        { participant_id: 'agent-1', participant_type: 'agent', role: 'member',
          joined_at: new Date(), left_at: null, agent_id: 'alpha', agent_name: 'Alpha', agent_status: 'running' },
      ]});

    const res = await request(app)
      .put('/chat/threads/thread-1/participants')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ add: ['agent-1'] });
    expect(res.status).toBe(200);
    expect(res.body.participants).toHaveLength(1);
  });

  it('PUT /chat/threads/:id/participants removes agent and marks pending as error (I6)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({ rowCount: 1 })  // mark pending as error
      .mockResolvedValueOnce({ rowCount: 1 })  // set left_at
      .mockResolvedValueOnce({ rows: [] });  // return participants (empty after removal)

    const res = await request(app)
      .put('/chat/threads/thread-1/participants')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ remove: ['agent-1'] });
    expect(res.status).toBe(200);

    // Verify pending messages were marked as error
    const errorSql = mockQuery.mock.calls[1][0];
    expect(errorSql).toContain("status = 'error'");
    expect(errorSql).toContain("status = 'pending'");
  });

  it('PUT /chat/threads/:id/participants rejects >8 agents', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({  // getThreadAgents — already 7
        rows: ['a1','a2','a3','a4','a5','a6','a7'].map(id => ({ participant_id: id })),
      });

    const res = await request(app)
      .put('/chat/threads/thread-1/participants')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ add: ['a8', 'a9'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Maximum 8');
  });

  it('PUT /chat/threads/:id/participants rejects elevated agent for non-admin', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({ rows: [] })  // getThreadAgents
      .mockResolvedValueOnce({ rows: [{ scope: 'vps_system' }] });  // elevated scope

    const res = await request(app)
      .put('/chat/threads/thread-1/participants')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ add: ['elevated-agent'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('vps_system');
  });

  it('PUT /chat/threads/:id/participants returns 404 for non-owner', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not owner

    const res = await request(app)
      .put('/chat/threads/thread-1/participants')
      .set('Authorization', `Bearer ${otherUserToken}`)
      .send({ add: ['agent-1'] });
    expect(res.status).toBe(404);
  });
});

// ── Multi-agent dispatch + @-mention routing ──

describe('Chat multi-agent dispatch', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('POST /chat/threads/:id/messages dispatches to all agents in group (I8, I11)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'agent-1' }, { participant_id: 'agent-2' }],
      })
      // getAgentForDispatch — agent 1
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt-1', models: ['gpt-4o-mini'] }],
      })
      // getAgentForDispatch — agent 2
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt-2', models: ['gpt-4o'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope agent 1
      .mockResolvedValueOnce({ rows: [] })  // elevated scope agent 2
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard agent 1
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard agent 2
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'prev' }] })  // message history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt-1', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt-2', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder agent 1
      .mockResolvedValueOnce({ rows: [{ id: 'ph-2' }] });  // placeholder agent 2

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello everyone' });

    expect(res.status).toBe(201);
    expect(res.body.dispatched).toHaveLength(2);
    expect(res.body.skipped).toHaveLength(0);
    expect(res.body.failed).toHaveLength(0);
    expect(res.body.user_message.id).toBe('user-msg');

    expect(mockDispatchChatWork).toHaveBeenCalledTimes(2);
  });

  it('POST /chat/threads/:id/messages @-mention routes to single agent (I9)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'agent-1' }, { participant_id: 'agent-2' }],
      })
      // resolveAgentSlugs
      .mockResolvedValueOnce({
        rows: [{ slug: 'alpha', participant_id: 'agent-1' }],
      })
      // getAgentForDispatch — only targeted agent
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt-1', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'prev' }] })  // message history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt-1', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt-2', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] });  // placeholder

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: '@alpha What is 2+2?' });

    expect(res.status).toBe(201);
    expect(res.body.dispatched).toHaveLength(1);
    expect(res.body.dispatched[0].agent_id).toBe('agent-1');
    expect(mockDispatchChatWork).toHaveBeenCalledTimes(1);
  });

  it('POST /chat/threads/:id/messages returns 400 for unknown @-mention (I10)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'agent-1' }],
      })
      // resolveAgentSlugs — no match
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: '@nonexistent Hello' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown agent: @nonexistent');
  });

  it('POST /chat/threads/:id/messages skips agent with pending, dispatches others (I12)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'agent-1' }, { participant_id: 'agent-2' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt-1', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt-2', models: ['gpt-4o'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope 1
      .mockResolvedValueOnce({ rows: [] })  // elevated scope 2
      .mockResolvedValueOnce({ rows: [{ id: 'pending-msg' }] })  // concurrency guard agent 1 — has pending!
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard agent 2 — clear
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'prev' }] })  // message history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt-1', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt-2', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-2' }] });  // placeholder for agent 2

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(201);
    expect(res.body.dispatched).toHaveLength(1);
    expect(res.body.dispatched[0].agent_id).toBe('agent-2');
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].agent_id).toBe('agent-1');
    expect(res.body.skipped[0].reason).toBe('has_pending');
  });

  it('POST /chat/threads/:id/messages strict elevated deny for group (I13)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'agent-1' }, { participant_id: 'agent-2' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'safe', name: 'Safe', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-2', agent_id: 'elevated', name: 'Elevated', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope agent 1 — clear
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] });  // elevated scope agent 2 — elevated!

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Elevated');
    // No user message or placeholders should have been created
    // (rejected before any DB writes)
  });

  it('POST /chat/threads/:id/messages sets reply_to on placeholders (I15)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'agent-1' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg-123', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [] })  // message history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] });  // placeholder

    await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });

    // Verify the INSERT placeholder SQL includes reply_to
    const placeholderCall = mockQuery.mock.calls.find(
      (call: any[]) => call[0].includes('reply_to') && call[0].includes("'pending'") && call[0].includes('INSERT')
    );
    expect(placeholderCall).toBeDefined();
    // reply_to param should be user message ID
    expect(placeholderCall![1]).toContain('user-msg-123');
  });

  it('POST /chat/threads/:id/messages stores target_agents for @-mentions (I16)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-1' }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'alpha', participant_id: 'agent-1' }] })  // resolveAgentSlugs
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [] })  // message history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] });

    await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: '@alpha Hello' });

    // Verify user message INSERT includes target_agents
    const userMsgCall = mockQuery.mock.calls.find(
      (call: any[]) => call[0].includes('target_agents') && call[0].includes('INSERT')
    );
    expect(userMsgCall).toBeDefined();
    // target_agents param should be JSON with the agent UUID
    const targetAgentsParam = userMsgCall![1][4]; // 5th param
    expect(targetAgentsParam).toContain('agent-1');
  });

  it('POST /chat/threads/:id/messages direct thread preserved — single dispatch (I17)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // getThreadType
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-uuid' }] })  // getThreadAgents
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', name: 'Test', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 1 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'Hello' }] })  // message history
      .mockResolvedValueOnce({ rows: [{ id: 'placeholder-uuid' }] });  // placeholder

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'How are you?' });

    expect(res.status).toBe(201);
    expect(res.body.message_id).toBe('placeholder-uuid');
    // Direct thread response has no dispatched/skipped/failed arrays
    expect(res.body.dispatched).toBeUndefined();
    expect(mockDispatchChatWork).toHaveBeenCalledTimes(1);
  });

  it('POST /chat/threads/:id/messages dispatch failure marks placeholder as error (I14a)', async () => {
    mockDispatchChatWork.mockRejectedValue(new Error('Connection refused'));

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-1' }] })  // getThreadAgents
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [] })  // message history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder
      .mockResolvedValueOnce({ rowCount: 1 });  // UPDATE placeholder to error

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(201);
    expect(res.body.dispatched).toHaveLength(0);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].reason).toBe('dispatch_failed');
    expect(res.body.failed[0].message_id).toBe('ph-1');
  });

  // The other lane's finding on this same file: the real dispatch-failure
  // reason was computed (it's right there in the `reason` local) and then
  // thrown away in favor of the fixed string 'Dispatch failed'. Assert the
  // persisted error_message CONTAINS the distinctive cause, not that it
  // equals some other fixed string — that would just be a different constant.
  it('POST /chat/threads/:id/messages persists the actual dispatch failure reason, not a fixed string', async () => {
    mockDispatchChatWork.mockRejectedValue(new Error('ECONNREFUSED agentbox-alpha:8054 (distinctive-marker-9f3a)'));

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-1' }] })  // getThreadAgents
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [] })  // message history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder
      .mockResolvedValueOnce({ rowCount: 1 });  // UPDATE placeholder to error

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(201);
    expect(res.body.failed).toHaveLength(1);

    const updateCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes("SET status = 'error'") && sql.includes('error_message')
    );
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(String(params[1])).toContain('distinctive-marker-9f3a');
  });

  // The fix must not trade a readable error for a leaked credential: the work
  // token is sent as a Bearer header on the request that just failed, so it
  // must never survive into a column a user can read.
  it('POST /chat/threads/:id/messages redacts the agent work token from both the persisted AND the logged dispatch failure reason', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockDispatchChatWork.mockResolvedValue({
      accepted: false,
      error: 'Agentbox returned 401: Authorization: Bearer super-secret-work-token-abc123 rejected',
    });

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-1' }] })  // getThreadAgents
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'super-secret-work-token-abc123', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [] })  // message history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'super-secret-work-token-abc123', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder
      .mockResolvedValueOnce({ rowCount: 1 });  // UPDATE placeholder to error

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(201);
    expect(res.body.failed).toHaveLength(1);

    const updateCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes("SET status = 'error'") && sql.includes('error_message')
    );
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(String(params[1])).not.toContain('super-secret-work-token-abc123');
    expect(String(params[1])).toContain('[REDACTED]');

    // Container stdout/stderr is shipped to and retained in Loki — a token
    // that survives into console.error is a leak there too, not "just a log".
    const loggedCalls = consoleErrorSpy.mock.calls.map(args => args.join(' '));
    expect(loggedCalls.some(line => line.includes('super-secret-work-token-abc123'))).toBe(false);
    expect(loggedCalls.some(line => line.includes('Dispatch failed for agent=alpha') && line.includes('[REDACTED]'))).toBe(true);

    consoleErrorSpy.mockRestore();
  });

  // #364: agentbox's handle_chat() checks the same env var and, if unset,
  // emits a local work_failed event and returns WITHOUT ever calling back —
  // the placeholder would otherwise sit 'pending' until the stale sweeper
  // marks it "No response received" 2+ minutes later, saying only what was
  // observed rather than pointing away from the real cause. Dispatch must
  // never even be attempted in this case.
  it('POST /chat/threads/:id/messages reports the actual cause when CHAT_CALLBACK_TOKEN is missing, not a timeout (#364)', async () => {
    const savedToken = process.env.CHAT_CALLBACK_TOKEN;
    delete process.env.CHAT_CALLBACK_TOKEN;

    try {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
        .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
        .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-1' }] })  // getThreadAgents
        .mockResolvedValueOnce({
          rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
        })
        .mockResolvedValueOnce({ rows: [] })  // elevated scope
        .mockResolvedValueOnce({ rows: [] })  // concurrency guard
        .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
        .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
        .mockResolvedValueOnce({ rows: [] })  // message history
        // getAgentForDispatch for participant list (group threads)
        .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }] })
        .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder
        .mockResolvedValueOnce({ rowCount: 1 });  // UPDATE placeholder to error

      const res = await request(app)
        .post('/chat/threads/thread-1/messages')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ message: 'Hello' });

      expect(res.status).toBe(201);
      expect(res.body.dispatched).toHaveLength(0);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].reason).toBe('callback_not_configured');
      expect(res.body.failed[0].message_id).toBe('ph-1');
      // The agent must never be dispatched to — the callback could never
      // complete, so the correct behavior is to not even try.
      expect(mockDispatchChatWork).not.toHaveBeenCalled();
    } finally {
      if (savedToken !== undefined) process.env.CHAT_CALLBACK_TOKEN = savedToken;
    }
  });
});

// ── Cancel ──

describe('Chat cancel', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('POST /chat/threads/:id/cancel marks all pending as error (I7)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rowCount: 3 });  // UPDATE pending → error

    const res = await request(app)
      .post('/chat/threads/thread-1/cancel')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(3);

    // Verify error message
    const sql = mockQuery.mock.calls[1][0];
    expect(sql).toContain("'Cancelled by user'");
    expect(sql).toContain('nextval');
  });

  it('POST /chat/threads/:id/cancel no-op if no pending', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rowCount: 0 });  // no pending

    const res = await request(app)
      .post('/chat/threads/thread-1/cancel')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(0);
  });

  it('POST /chat/threads/:id/cancel requires participant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/chat/threads/thread-1/cancel')
      .set('Authorization', `Bearer ${otherUserToken}`);

    expect(res.status).toBe(404);
  });
});

// ── Send message backward compat ──

describe('Chat send message (backward compat)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('POST /chat/threads/:id/messages returns 409 for concurrent send on direct thread', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // getThreadType
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-uuid' }] })  // getThreadAgents
      .mockResolvedValueOnce({  // getAgentForDispatch
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', name: 'Test', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [{ id: 'pending-msg' }] });  // concurrency guard finds pending

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello again' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('still responding');
  });

  it('POST /chat/threads/:id/messages returns 409 for idempotency duplicate', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-uuid' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', name: 'Test', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505', constraint: 'idx_chat_messages_idempotency' }));

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Retry', idempotency_key: 'key-1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Duplicate');
  });
});

// ── Callback (unchanged from Phase 1) ──

describe('Chat callback', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('POST /internal/chat/callback accepts valid token and updates message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })      // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] });  // batch completion: direct, skip

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-uuid',
        content: 'Agent response',
        model: 'gpt-4o-mini',
        input_tokens: 42,
        output_tokens: 128,
        duration_ms: 1200,
        status: 'complete',
      });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);

    // Verify guarded UPDATE uses nextval
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('nextval');
    expect(sql).toContain("status IN ('pending', 'thinking')");
  });

  it('POST /internal/chat/callback rejects invalid token (401)', async () => {
    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer wrong-token')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete' });
    expect(res.status).toBe(401);
  });

  // An operator debugging "agentbox callbacks are all 401ing" (e.g. after a
  // CHAT_CALLBACK_TOKEN rotation drifted between the API and agentbox) used
  // to get zero server-side trace — the two 401 branches had no logging at
  // all, unlike the missing-config branch three lines above them.
  it('POST /internal/chat/callback logs a token mismatch WITHOUT the presented token value', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer distinctive-wrong-value-9f3a')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete' });

    expect(res.status).toBe(401);

    const loggedCalls = consoleWarnSpy.mock.calls.map(args => args.join(' '));
    expect(loggedCalls.some(line => /did not match/i.test(line))).toBe(true);
    // THE ASSERTION THAT MATTERS: the credential itself never reaches a log
    // line, container logs being a worse leak surface than the value ever
    // living in a request the operator can already see.
    expect(loggedCalls.some(line => line.includes('distinctive-wrong-value-9f3a'))).toBe(false);

    consoleWarnSpy.mockRestore();
  });

  it('POST /internal/chat/callback rejects missing auth header (401)', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app)
      .post('/internal/chat/callback')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete' });
    expect(res.status).toBe(401);

    const loggedCalls = consoleWarnSpy.mock.calls.map(args => args.join(' '));
    expect(loggedCalls.some(line => /missing or malformed/i.test(line))).toBe(true);

    consoleWarnSpy.mockRestore();
  });

  it('POST /internal/chat/callback returns 503 when token not configured', async () => {
    delete process.env.CHAT_CALLBACK_TOKEN;

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer any-token')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('callback_not_configured');
  });

  it('POST /internal/chat/callback returns 200 no-op for terminal message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })  // guarded UPDATE matches nothing
      .mockResolvedValueOnce({ rows: [{ status: 'complete' }] });  // SELECT finds terminal

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-uuid', content: 'late response', status: 'complete' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
  });

  it('POST /internal/chat/callback returns 404 for unknown message_id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] });     // SELECT finds nothing

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'nonexistent', content: 'test', status: 'complete' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_message');
  });

  it('POST /internal/chat/callback rejects idempotency_key in body', async () => {
    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete', idempotency_key: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('idempotency_key');
  });

  it('POST /internal/chat/callback handles error status', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] });  // batch completion: direct, skip

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-uuid',
        status: 'error',
        error_message: 'Inference failed',
      });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);

    const params = mockQuery.mock.calls[0][1];
    expect(params[2]).toBe('error');
  });

  // T13: Callback elevated-agent response emits audit tag
  it('POST /internal/chat/callback tags elevated-agent response', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
        .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
        .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
        .mockResolvedValueOnce({ rows: [{ author_id: 'agent-uuid-1' }] }) // SELECT author_id
        .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] }); // getAgentElevatedScope

      const res = await request(app)
        .post('/internal/chat/callback')
        .set('Authorization', 'Bearer test-callback-secret')
        .send({
          message_id: 'msg-uuid',
          content: 'Agent response',
          status: 'complete',
        });
      expect(res.status).toBe(200);

      const audits = consoleSpy.mock.calls
        .map((c: any[]) => { try { return JSON.parse(c[0]); } catch { return null; } })
        .filter((obj: any) => obj?.type === 'audit');
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('elevated_agent_response');
      expect(audits[0].skill_scope).toBe('host_docker');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ── Chat audit logging ──

describe('Chat audit logging', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
    consoleSpy.mockRestore();
  });

  function getAuditCalls(): any[] {
    return consoleSpy.mock.calls
      .map((c: any[]) => { try { return JSON.parse(c[0]); } catch { return null; } })
      .filter((obj: any) => obj?.type === 'audit');
  }

  // T7a: POST /chat/threads elevated deny emits audit
  it('POST /chat/threads elevated deny emits audit', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', name: 'Test', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] }); // elevated

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid', message: 'Hello' });
    expect(res.status).toBe(403);

    const audits = getAuditCalls();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('chat_elevated_denied');
    expect(audits[0].endpoint).toBe('POST /chat/threads');
    expect(audits[0].skill_scope).toBe('host_docker');
  });

  // T7b: POST /chat/threads/:id/messages elevated deny emits audit
  it('POST /chat/threads/:id/messages elevated deny emits audit', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // getThreadType
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-uuid' }] })  // getThreadAgents
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'elevated-agent', name: 'Elevated', status: 'running', work_token: 'wt', models: [] }],
      })  // getAgentForDispatch
      .mockResolvedValueOnce({ rows: [{ scope: 'vps_system' }] }); // getAgentElevatedScope

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello elevated' });
    expect(res.status).toBe(403);

    const audits = getAuditCalls();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('chat_elevated_denied');
    expect(audits[0].endpoint).toBe('POST /chat/threads/:id/messages');
  });

  // T7c: PUT /chat/threads/:id/participants elevated deny emits audit
  it('PUT /chat/threads/:id/participants elevated deny emits audit', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({ rows: [{ participant_id: 'existing-agent' }] })  // getThreadAgents (current count)
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] });  // getAgentElevatedScope

    const res = await request(app)
      .put('/chat/threads/thread-1/participants')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ add: ['new-elevated-agent'] });
    expect(res.status).toBe(403);

    const audits = getAuditCalls();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('chat_elevated_denied');
    expect(audits[0].endpoint).toBe('PUT /chat/threads/:id/participants');
  });
});

// ── Agent-to-agent @mention orchestration ──

describe('Agent-to-agent @mention orchestration', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
    consoleSpy.mockRestore();
    jest.restoreAllMocks();
  });

  function getAuditCalls(): any[] {
    return consoleSpy.mock.calls
      .map((c: any[]) => { try { return JSON.parse(c[0]); } catch { return null; } })
      .filter((obj: any) => obj?.type === 'audit');
  }

  // T1: parseMentions works on agent content
  it('parseMentions extracts mentions from agent response', async () => {
    const { parseMentions } = await import('../routes/chat');
    const result = parseMentions('Hey @agent-b check this out');
    expect(result.slugs).toEqual(['agent-b']);
  });

  // T2: Callback triggers dispatch on @mention
  it('callback dispatches to mentioned agent', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] }) // elevated tagging query
      .mockResolvedValueOnce({ rows: [] })       // getAgentElevatedScope (not elevated)
      // Agent-to-agent orchestration:
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: null, chain_hop: null }] }) // get triggering msg
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-b', participant_id: 'agent-b-uuid' }] }) // resolveAgentSlugs
      .mockResolvedValueOnce({ rowCount: 1 })   // backfill chain_id on triggering msg
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] })  // time budget: MIN(created_at)
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] }) // cycle detection
      .mockResolvedValueOnce({ rows: [] })       // getAgentElevatedScope for target
      .mockResolvedValueOnce({ rows: [{ id: 'agent-b-uuid', agent_id: 'agent-b', name: 'Agent B', status: 'running', work_token: 'wt-b', models: ['gpt-4o-mini'] }] }) // getAgentForDispatch
      .mockResolvedValueOnce({ rows: [] })       // concurrency guard
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // chain thread type for group context
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'Hello' }] }) // message history
      .mockResolvedValueOnce({ rows: [{ id: 'chain-placeholder' }] }); // INSERT placeholder

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-from-agent-a',
        content: 'I think @agent-b should handle this',
        status: 'complete',
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(mockDispatchChatWork).toHaveBeenCalledTimes(1);
    expect(mockDispatchChatWork).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-b',
    }));
  });

  // T3: Hop budget enforced
  it('chain stops at MAX_CHAIN_HOPS', async () => {
    process.env.MAX_CHAIN_HOPS = '5';
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] }) // elevated tagging
      .mockResolvedValueOnce({ rows: [] })       // not elevated
      // Orchestration:
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: 'existing-chain', chain_hop: 5 }] }) // at hop 5
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-b', participant_id: 'agent-b-uuid' }] }); // resolveAgentSlugs

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-hop5',
        content: 'Hey @agent-b',
        status: 'complete',
      });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
    delete process.env.MAX_CHAIN_HOPS;
  });

  // T4: Time budget enforced
  it('chain stops when MAX_CHAIN_DURATION_MS exceeded', async () => {
    process.env.MAX_CHAIN_DURATION_MS = '60000';
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] }) // elevated tagging
      .mockResolvedValueOnce({ rows: [] })       // not elevated
      // Orchestration:
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: 'old-chain', chain_hop: 2 }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-b', participant_id: 'agent-b-uuid' }] })
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date(Date.now() - 120000).toISOString() }] }); // 120s ago — exceeded

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-old-chain',
        content: 'Hey @agent-b',
        status: 'complete',
      });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
    delete process.env.MAX_CHAIN_DURATION_MS;
  });

  // T5: Self-mention blocked
  it('agent cannot mention itself', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] }) // elevated tagging
      .mockResolvedValueOnce({ rows: [] })       // not elevated
      // Orchestration:
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: null, chain_hop: null }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-a', participant_id: 'agent-a-uuid' }] }); // resolves to self

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-self',
        content: 'Let me ask @agent-a again',
        status: 'complete',
      });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
  });

  // T6: Cycle detection
  it('agent already in chain cannot be re-triggered', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] }) // elevated tagging
      .mockResolvedValueOnce({ rows: [] })       // not elevated
      // Orchestration:
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: 'chain-1', chain_hop: 1 }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-b', participant_id: 'agent-b-uuid' }] })
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] }) // time budget OK
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }, { author_id: 'agent-b-uuid' }] }); // cycle: b already in chain

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-cycle',
        content: 'Asking @agent-b again',
        status: 'complete',
      });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
  });

  // T7: Elevated scope blocked
  it('elevated agent not dispatched by agent-to-agent', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] }) // elevated tagging
      .mockResolvedValueOnce({ rows: [] })       // not elevated (author)
      // Orchestration:
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: null, chain_hop: null }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'elevated-agent', participant_id: 'elevated-uuid' }] })
      .mockResolvedValueOnce({ rowCount: 1 })   // backfill chain_id
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] }) // time OK
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] }) // cycle check: only a
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] }); // elevated scope on target!

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-elevated',
        content: 'Ask @elevated-agent to do it',
        status: 'complete',
      });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();

    const audits = getAuditCalls();
    const dispatchAudit = audits.find((a: any) => a.action === 'agent_to_agent_dispatch' && a.blocked === 'elevated_scope');
    expect(dispatchAudit).toBeDefined();
  });

  // T8: chain_id propagated
  it('chain messages share chain_id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: 'shared-chain-id', chain_hop: 1 }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-c', participant_id: 'agent-c-uuid' }] })
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] }) // not elevated
      .mockResolvedValueOnce({ rows: [{ id: 'agent-c-uuid', agent_id: 'agent-c', name: 'Agent C', status: 'running', work_token: 'wt-c', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [] }) // concurrency
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // chain thread type
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'Hello' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'chain-ph-2' }] }); // placeholder

    await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-chain', content: 'Ask @agent-c', status: 'complete' });

    // Verify the INSERT placeholder includes chain_id
    const insertCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('chain_id') && call[0].includes('INSERT')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain('shared-chain-id');
  });

  // T9: chain_hop incremented
  it('chain_hop increments per hop', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: 'chain-inc', chain_hop: 2 }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-d', participant_id: 'agent-d-uuid' }] })
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-d-uuid', agent_id: 'agent-d', name: 'Agent D', status: 'running', work_token: 'wt-d', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // chain thread type
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'chain-ph-3' }] });

    await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-hop2', content: 'Ask @agent-d', status: 'complete' });

    const insertCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('chain_hop') && call[0].includes('INSERT')
    );
    expect(insertCall).toBeDefined();
    // chain_hop should be 3 (previous was 2, +1)
    expect(insertCall![1]).toContain(3);
  });

  // T10: triggered_by set
  it('triggered_by links to triggering message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: null, chain_hop: null }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-e', participant_id: 'agent-e-uuid' }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // backfill chain_id
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-e-uuid', agent_id: 'agent-e', name: 'Agent E', status: 'running', work_token: 'wt-e', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // chain thread type
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'chain-ph-tb' }] });

    await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'trigger-msg-id', content: 'Ask @agent-e', status: 'complete' });

    const insertCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('triggered_by') && call[0].includes('INSERT')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain('trigger-msg-id');
  });

  // T11: Non-participant ignored
  it('mention of non-participant agent is ignored', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: null, chain_hop: null }] })
      .mockResolvedValueOnce({ rows: [] }); // resolveAgentSlugs returns empty — not a participant

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-nonparticipant', content: 'Hey @stranger', status: 'complete' });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
  });

  // T12: Audit emitted
  it('agent_to_agent_dispatch audit entry', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: null, chain_hop: null }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-f', participant_id: 'agent-f-uuid' }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // backfill
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] }) // not elevated
      .mockResolvedValueOnce({ rows: [{ id: 'agent-f-uuid', agent_id: 'agent-f', name: 'Agent F', status: 'running', work_token: 'wt-f', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // chain thread type
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'chain-ph-audit' }] });

    await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-audit', content: 'Ask @agent-f', status: 'complete' });

    const audits = getAuditCalls();
    const dispatchAudit = audits.find((a: any) => a.action === 'agent_to_agent_dispatch' && !a.blocked);
    expect(dispatchAudit).toBeDefined();
    expect(dispatchAudit.chain_hop).toBe(1);
    expect(dispatchAudit.triggered_by).toBe('msg-audit');
  });

  // T13: Error callback skips parsing
  it('error status callback skips mention parsing', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] });  // batch completion: direct, skip

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-error',
        content: '@agent-b I failed',
        status: 'error',
        error_message: 'Inference error',
      });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
  });

  // T14: Offline agent skipped
  it('chain dispatch skips offline agent', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: null, chain_hop: null }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-off', participant_id: 'agent-off-uuid' }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // backfill
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] }) // not elevated
      .mockResolvedValueOnce({ rows: [{ id: 'agent-off-uuid', agent_id: 'agent-off', name: 'Offline', status: 'stopped', work_token: null, models: [] }] }); // offline

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-offline', content: 'Ask @agent-off', status: 'complete' });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
  });

  // T15: Concurrency guard in chain
  it('chain dispatch skips agent with pending message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reply_to: null, thread_type: 'direct' }] })  // batch completion: direct, skip
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1', author_id: 'agent-a-uuid', chain_id: null, chain_hop: null }] })
      .mockResolvedValueOnce({ rows: [{ slug: 'agent-busy', participant_id: 'agent-busy-uuid' }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // backfill
      .mockResolvedValueOnce({ rows: [{ chain_start: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [{ author_id: 'agent-a-uuid' }] })
      .mockResolvedValueOnce({ rows: [] }) // not elevated
      .mockResolvedValueOnce({ rows: [{ id: 'agent-busy-uuid', agent_id: 'agent-busy', name: 'Busy', status: 'running', work_token: 'wt-busy', models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pending-msg' }] }); // has pending!

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-busy', content: 'Ask @agent-busy', status: 'complete' });

    expect(res.status).toBe(200);
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
  });
});

// ── Stale sweeper ──

describe('Chat stale sweeper', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('sweeper function is exported and can be started/stopped', async () => {
    const { startStaleSweeper, stopStaleSweeper } = await import('../routes/chat');
    expect(typeof startStaleSweeper).toBe('function');
    expect(typeof stopStaleSweeper).toBe('function');
  });

  // THE ASSERTION THAT MATTERS. chatCallbackHandler's own guarded UPDATE treats
  // status IN ('pending', 'thinking') as the equivalence class of "still open" —
  // a message legitimately sits at 'thinking' between an intermediate progress
  // callback and the final complete/error one. If that FINAL callback is lost
  // (agentbox's _deliver_callback is fire-and-forget, no retry — the network
  // blip, an API restart mid-delivery, a misconfigured token), the message is
  // stuck at 'thinking' forever: the agent already did the work and generated a
  // real answer, but the user's chat UI shows "thinking..." with no error and
  // no recovery. The sweeper exists specifically to catch a message nothing
  // will ever terminate — but its own WHERE clause only matches 'pending',
  // missing the other half of the exact state set its sibling handler defines.
  // A message that reaches 'thinking' is, perversely, in the state with LESS
  // of a safety net than one that never started at all.
  it('sweeps stale THINKING messages, not only pending ones', async () => {
    jest.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { startStaleSweeper, stopStaleSweeper } = await import('../routes/chat');
    try {
      startStaleSweeper();
      await jest.advanceTimersByTimeAsync(60_000);

      const sweepCall = mockQuery.mock.calls.find(
        ([sql, params]) => typeof sql === 'string'
          && sql.includes("SET status = 'error'")
          && Array.isArray(params) && params.includes('No response received within 2 minutes')
      );
      expect(sweepCall).toBeDefined();
      const sql = String(sweepCall![0]);

      // Matches chatCallbackHandler's own guard exactly, not a looser check —
      // a fix that widened this to ANY status (dropping the terminal-state
      // exclusion) would be a worse bug and must not pass this test either.
      expect(sql).toMatch(/status\s+IN\s*\(\s*'pending'\s*,\s*'thinking'\s*\)/i);

      // Keyed on updated_at, not created_at — a 'thinking' message refreshed
      // by repeated progress callbacks must not be swept out from under an
      // agent that is still actively working. Keying this off created_at
      // would make this fix itself a regression: it would sweep a message
      // making real progress the moment it turned 2 minutes old.
      expect(sql).toMatch(/updated_at\s*<\s*NOW\(\)/i);
      expect(sql).not.toMatch(/created_at\s*<\s*NOW\(\)/i);
    } finally {
      stopStaleSweeper();
      jest.useRealTimers();
    }
  });
});

// ── SSE stream ──

describe('Chat SSE stream', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /chat/threads/:id/stream requires participant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not a participant

    const res = await request(app)
      .get('/chat/threads/thread-1/stream')
      .set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(404);
  });

  it('GET /chat/threads/:id/stream returns SSE headers and initial data', async () => {
    // isParticipant
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    // Initial poll — now the bounded backfill (#203)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'msg-1', seq: 5, author_id: 'user-1', author_type: 'human',
        role: 'user', content: 'Hello', status: 'complete', reply_to: null,
        target_agents: null, model: null,
        input_tokens: null, output_tokens: null, duration_ms: null,
        error_message: null, created_at: new Date().toISOString(),
      }],
    });
    // …and its COUNT(*), which the backfill notice reports. 9 against 1 sent:
    // the two numbers must disagree, or an implementation reporting
    // rows.length would satisfy this fixture.
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '9' }] });

    const res = await request(app)
      .get('/chat/threads/thread-1/stream')
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true)
      .parse((res: any, callback: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // Wait for the message frame rather than the first chunk. The
          // backfill notice is written first now, and whether the two land in
          // one TCP chunk is not something a test should depend on.
          if (data.includes('event: message')) res.destroy();
        });
        res.on('end', () => callback(null, data));
        res.on('error', () => callback(null, data));
        // Force close after 500ms if no data
        setTimeout(() => { res.destroy(); callback(null, data); }, 500);
      });

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('event: message');
    expect(res.body).toContain('id: 5');
    expect(res.body).toContain('msg-1');

    // The truncation notice arrives BEFORE the messages, so a client knows
    // what follows is a tail rather than a history.
    expect(res.body).toContain('event: backfill');
    expect(res.body.indexOf('event: backfill')).toBeLessThan(res.body.indexOf('event: message'));
    const notice = JSON.parse(
      res.body.slice(res.body.indexOf('event: backfill')).split('data: ')[1].split('\n')[0]
    );
    expect(notice.sent).toBe(1);
    expect(notice.total).toBe(9);       // COUNT(*), not rows.length
    expect(notice.has_older).toBe(true);
  });
});

// ── RBAC ──

describe('Chat RBAC', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('POST /chat/threads allows admin to send to elevated agent', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', name: 'Test', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] })  // elevated scope found — but admin
      .mockResolvedValueOnce({
        rows: [{ id: 'thread-uuid', type: 'direct', title: null, created_by: 'admin-user',
                 created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [] })  // participants
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 1 }] })  // user message
      .mockResolvedValueOnce({ rows: [{ id: 'ph-uuid' }] });  // placeholder

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_id: 'agent-uuid', message: 'Run docker' });
    expect(res.status).toBe(201);
  });

  it('POST /chat/threads admin can create group with elevated agents (V12)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', agent_id: 'elevated-one', name: 'E1', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-2', agent_id: 'safe-one', name: 'S1', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] })  // agent 1 elevated
      .mockResolvedValueOnce({ rows: [] })  // agent 2 not elevated
      // Admin bypasses elevated check
      .mockResolvedValueOnce({
        rows: [{ id: 'group-thread', type: 'group', title: null, created_by: 'admin-user',
                 created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [] })  // INSERT participants
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 1 }] })  // user message
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder 1
      .mockResolvedValueOnce({ rows: [{ id: 'ph-2' }] });  // placeholder 2

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_ids: ['agent-1', 'agent-2'], message: 'Hello elevated group' });
    expect(res.status).toBe(201);
    expect(res.body.dispatched).toHaveLength(2);
  });
});

// ── @-mention parsing unit tests ──

describe('parseMentions', () => {
  // Import the exported function
  let parseMentions: (content: string) => { slugs: string[]; cleanContent: string };

  beforeAll(async () => {
    const mod = await import('../routes/chat');
    parseMentions = mod.parseMentions;
  });

  it('extracts single @-mention', () => {
    const result = parseMentions('@test-agent What is 2+2?');
    expect(result.slugs).toEqual(['test-agent']);
    expect(result.cleanContent).toBe('What is 2+2?');
  });

  it('extracts multiple @-mentions', () => {
    const result = parseMentions('@alpha @beta What do you think?');
    expect(result.slugs).toEqual(['alpha', 'beta']);
    expect(result.cleanContent).toBe('What do you think?');
  });

  it('deduplicates @-mentions', () => {
    const result = parseMentions('@alpha @alpha Hello');
    expect(result.slugs).toEqual(['alpha']);
  });

  it('returns empty slugs when no mentions', () => {
    const result = parseMentions('Hello world');
    expect(result.slugs).toEqual([]);
    expect(result.cleanContent).toBe('Hello world');
  });

  it('handles @-mention at start of line', () => {
    const result = parseMentions('@agent test');
    expect(result.slugs).toEqual(['agent']);
  });

  it('handles @-mention after space', () => {
    const result = parseMentions('Hey @agent test');
    expect(result.slugs).toEqual(['agent']);
  });
});

// ── Thread events ──

// ── Group broadcast dispatch (AI-146) ──

describe('Group broadcast dispatch', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('dispatches to all group agents in parallel (T1)', async () => {
    // Track dispatch timing to verify parallel execution
    const dispatchOrder: string[] = [];
    mockDispatchChatWork.mockImplementation(async (params: any) => {
      dispatchOrder.push(params.agentId);
      return { accepted: true, work_id: `work-${params.agentId}` };
    });

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'a1' }, { participant_id: 'a2' }, { participant_id: 'a3' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'a1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt1', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt2', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a3', agent_id: 'gamma', name: 'Gamma', status: 'running', work_token: 'wt3', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope a1
      .mockResolvedValueOnce({ rows: [] })  // elevated scope a2
      .mockResolvedValueOnce({ rows: [] })  // elevated scope a3
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard a1
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard a2
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard a3
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'prev' }] })  // history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'a1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt1', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt2', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a3', agent_id: 'gamma', name: 'Gamma', status: 'running', work_token: 'wt3', models: ['gpt-4o'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder a1
      .mockResolvedValueOnce({ rows: [{ id: 'ph-2' }] })  // placeholder a2
      .mockResolvedValueOnce({ rows: [{ id: 'ph-3' }] });  // placeholder a3

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello everyone' });

    expect(res.status).toBe(201);
    expect(res.body.dispatched).toHaveLength(3);
    // All 3 dispatches fired (parallel via Promise.allSettled)
    expect(mockDispatchChatWork).toHaveBeenCalledTimes(3);
    expect(dispatchOrder).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('partial dispatch failure marks only failed placeholders as error (T2)', async () => {
    mockDispatchChatWork
      .mockResolvedValueOnce({ accepted: true, work_id: 'w1' })
      .mockRejectedValueOnce(new Error('connection refused'))  // agent 2 fails
      .mockResolvedValueOnce({ accepted: true, work_id: 'w3' });

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'a1' }, { participant_id: 'a2' }, { participant_id: 'a3' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'a1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt1', models: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt2', models: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a3', agent_id: 'gamma', name: 'Gamma', status: 'running', work_token: 'wt3', models: [] }] })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope a1
      .mockResolvedValueOnce({ rows: [] })  // elevated scope a2
      .mockResolvedValueOnce({ rows: [] })  // elevated scope a3
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard a1
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard a2
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard a3
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'prev' }] })  // history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'a1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt1', models: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt2', models: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a3', agent_id: 'gamma', name: 'Gamma', status: 'running', work_token: 'wt3', models: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder a1
      .mockResolvedValueOnce({ rows: [{ id: 'ph-2' }] })  // placeholder a2
      .mockResolvedValueOnce({ rows: [{ id: 'ph-3' }] })  // placeholder a3
      .mockResolvedValueOnce({ rowCount: 1 });  // UPDATE ph-2 status=error

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello everyone' });

    expect(res.status).toBe(201);
    expect(res.body.dispatched).toHaveLength(2);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].agent_id).toBe('a2');
  });

  it('group dispatch payload includes thread_type and participants (T3)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'group', lead_agent_id: null }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'a1' }, { participant_id: 'a2' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'a1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt1', models: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt2', models: [] }] })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope a1
      .mockResolvedValueOnce({ rows: [] })  // elevated scope a2
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard a1
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard a2
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'prev' }] })  // history
      // getAgentForDispatch for participant list (group threads)
      .mockResolvedValueOnce({ rows: [{ id: 'a1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt1', models: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a2', agent_id: 'beta', name: 'Beta', status: 'running', work_token: 'wt2', models: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] })  // placeholder a1
      .mockResolvedValueOnce({ rows: [{ id: 'ph-2' }] });  // placeholder a2

    await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });

    expect(mockDispatchChatWork).toHaveBeenCalledTimes(2);
    const call1 = mockDispatchChatWork.mock.calls[0][0];
    expect(call1.threadType).toBe('group');
    expect(call1.participants).toEqual([
      { agent_id: 'alpha', name: 'Alpha' },
      { agent_id: 'beta', name: 'Beta' },
    ]);
  });

  it('direct dispatch payload has no participants field (T4)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ type: 'direct' }] })  // getThreadType
      .mockResolvedValueOnce({  // getThreadAgents
        rows: [{ participant_id: 'a1' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'a1', agent_id: 'alpha', name: 'Alpha', status: 'running', work_token: 'wt1', models: [] }] })
      .mockResolvedValueOnce({ rows: [] })  // elevated scope
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [{ id: 'user-msg', seq: 10 }] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'prev' }] })  // history
      .mockResolvedValueOnce({ rows: [{ id: 'ph-1' }] });  // placeholder

    await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });

    const call1 = mockDispatchChatWork.mock.calls[0][0];
    expect(call1.threadType).toBe('direct');
    expect(call1.participants).toBeUndefined();
  });
});

// ── Batch completion (AI-146) ──

describe('Batch completion', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('batch_complete emitted when all siblings terminal (T5)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      // batch completion: get reply_to + thread_type
      .mockResolvedValueOnce({ rows: [{ reply_to: 'user-msg-1', thread_type: 'group' }] })
      // sibling count: all 3 terminal
      .mockResolvedValueOnce({ rows: [{ total: 3, terminal: 3 }] })
      // UPDATE batch_complete = true
      .mockResolvedValueOnce({ rowCount: 1 })
      // elevated tagging (no agent match)
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-3', content: 'Last response', status: 'complete' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);

    // Verify batch_complete UPDATE was called
    const batchUpdateCall = mockQuery.mock.calls[4];
    expect(batchUpdateCall[0]).toContain('batch_complete = true');
  });

  it('no batch_complete when siblings still pending (T6)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      // batch completion: get reply_to + thread_type
      .mockResolvedValueOnce({ rows: [{ reply_to: 'user-msg-1', thread_type: 'group' }] })
      // sibling count: only 1 of 3 terminal
      .mockResolvedValueOnce({ rows: [{ total: 3, terminal: 1 }] })
      // elevated tagging
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-1', content: 'First response', status: 'complete' });

    expect(res.status).toBe(200);
    // Should NOT have a batch_complete UPDATE call
    const batchCalls = mockQuery.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('batch_complete')
    );
    expect(batchCalls).toHaveLength(0);
  });

  it('batch_complete emitted even with error siblings (T7)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] })       // UPDATE thread timestamp
      // batch completion: get reply_to + thread_type
      .mockResolvedValueOnce({ rows: [{ reply_to: 'user-msg-1', thread_type: 'group' }] })
      // sibling count: 2 complete + 1 error = 3 terminal out of 3 total
      .mockResolvedValueOnce({ rows: [{ total: 3, terminal: 3 }] })
      // UPDATE batch_complete = true
      .mockResolvedValueOnce({ rowCount: 1 })
      // elevated tagging
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-2', content: 'Second response', status: 'complete' });

    expect(res.status).toBe(200);
    const batchCalls = mockQuery.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('batch_complete')
    );
    expect(batchCalls).toHaveLength(1);
  });
});

describe('Chat thread events', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /chat/threads/:id/events requires participant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(404);
  });

  it('GET /chat/threads/:id/events returns 409 if no running agents', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [  // agents — all stopped
        { participant_id: 'agent-1', agent_id: 'alpha', status: 'stopped' },
      ] });

    const res = await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('No running agents');
  });
});
