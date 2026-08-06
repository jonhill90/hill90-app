/**
 * A multi-step write must not report failure while leaving some of its steps
 * committed and unmarked.
 *
 * THE RANKING THESE TESTS ENCODE, which is also how to triage the seams that are
 * still open:
 *
 *   SELF-IDENTIFYING  beats  DETECTABLE  beats  NEITHER.
 *
 * A half-write that labels itself needs no detector — you read its own status. One
 * that is merely detectable needs somebody to think of the query, and nobody does.
 * One that is neither is permanent.
 *
 * WORKFLOWS was the third case dressed as the first. `POST /workflows/:id/run`
 * inserted a run at status='running', then did four more inserts and two updates.
 * If any threw, the caller got 500 and the row stayed 'running' FOREVER: the
 * status='error' update lived inside the dispatch .catch, which never fires for a
 * failure in the insert sequence. And `status='running' AND thread_id IS NULL` is
 * also the legitimate in-flight state, so no query could separate a dead run from
 * a live one except by age. It now labels itself.
 *
 * CHAT and DISCORD were the middle case. Their inserts are all database writes, so
 * they are now one transaction each — which removes the need for a detector rather
 * than adding one.
 *
 * WHAT THESE TESTS CAN AND CANNOT SEE, said plainly: with a mocked pool there is
 * no database to inspect, so the transaction tests assert the CONTROL FLOW —
 * BEGIN issued, ROLLBACK issued, COMMIT not issued. That is a proxy for
 * atomicity, not a proof of it; proving no orphan row survives needs a real
 * Postgres and belongs in an integration test. The workflows test is stronger:
 * it asserts the actual UPDATE that labels the run.
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
/** Statements issued on the transactional client, in order. */
const clientCalls: string[] = [];

jest.mock('../db/pool', () => {
  // Everything here stays lazy (nested inside functions only called at
  // request time) rather than evaluated when the factory itself runs —
  // jest hoists jest.mock calls above this file's own `const mockQuery =
  // jest.fn()`, so a direct top-level reference to mockQuery here would
  // hit it before initialization.
  const getMockedPool = () => ({
    query: mockQuery,
    connect: async () => ({
      query: (sql: unknown, params?: unknown) => {
        clientCalls.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
        return mockQuery(sql, params);
      },
      release: () => {},
    }),
  });
  return {
    getPool: getMockedPool,
    // Reimplemented rather than jest.requireActual'd: the real
    // withTransaction closes over the real module's own getPool, which
    // would reach for an actual Postgres connection — this instead runs
    // the identical BEGIN/COMMIT/ROLLBACK control flow against the SAME
    // mocked client above, so the skills.ts tests below exercise real
    // transaction control flow, not a passthrough stub.
    withTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
      const client = await getMockedPool().connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    },
  };
});

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: jest.fn(),
}));

const mockDispatchChatWork = jest.fn();
jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: (...args: unknown[]) => mockDispatchChatWork(...args),
}));

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const userToken = jwt.sign(
  { sub: 'user-1', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' },
);

const adminToken = jwt.sign(
  { sub: 'admin-1', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' },
);

beforeEach(() => {
  mockQuery.mockReset();
  clientCalls.length = 0;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  mockDispatchChatWork.mockReset();
  mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('POST /workflows/:id/run — a failed run labels itself', () => {
  /** Everything up to the run insert succeeds; the NEXT statement throws. */
  function failAfterRunInsert() {
    let runInserted = false;
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/FROM workflows w/.test(s)) {
        return Promise.resolve({
          rows: [{
            id: 'wf-1', agent_id: 'a-1', agent_slug: 'scout', agent_status: 'running',
            work_token: 'wt', prompt: 'go', created_by: 'user-1', model_policy_id: null,
          }],
        });
      }
      if (/INSERT INTO workflow_runs/.test(s)) {
        runInserted = true;
        return Promise.resolve({ rows: [{ id: 'run-1', workflow_id: 'wf-1', status: 'running' }] });
      }
      // The step-two failure: the thread insert that follows the run row.
      if (runInserted && /INSERT INTO chat_threads/.test(s)) {
        return Promise.reject(new Error('deadlock detected'));
      }
      if (/UPDATE workflow_runs/.test(s)) return Promise.resolve({ rows: [], rowCount: 1 });
      return Promise.resolve({ rows: [] });
    });
  }

  it('POSITIVE CONTROL: marks the run error instead of leaving it running forever', async () => {
    failAfterRunInsert();

    const res = await request(app)
      .post('/workflows/wf-1/run')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});

    expect(res.status).toBe(500);

    // The load-bearing assertion. Before the fix, NO such update was issued and
    // the row stayed 'running' with nothing able to tell it from a live run.
    const marking = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /UPDATE workflow_runs/.test(s) && /status = 'error'/.test(s));

    expect(marking.length).toBeGreaterThan(0);
    expect(marking[0]).toMatch(/completed_at = NOW\(\)/);
    // Guarded so it cannot resurrect a run that has since finished by another path.
    expect(marking[0]).toMatch(/AND status = 'running'/);

    const params = mockQuery.mock.calls.find(
      (c) => /UPDATE workflow_runs/.test(String(c[0])) && /status = 'error'/.test(String(c[0])),
    )![1] as unknown[];
    expect(params[1]).toBe('run-1');
    expect(String(params[0])).toMatch(/deadlock/);
  });

  it('recording the failure cannot itself take down the request', async () => {
    // The database failing is exactly the case that produces this catch, so the
    // marking must not be able to throw out of it.
    let runInserted = false;
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/FROM workflows w/.test(s)) {
        return Promise.resolve({
          rows: [{ id: 'wf-1', agent_id: 'a-1', agent_slug: 'scout', agent_status: 'running', work_token: 'wt', prompt: 'go', created_by: 'user-1', model_policy_id: null }],
        });
      }
      if (/INSERT INTO workflow_runs/.test(s)) {
        runInserted = true;
        return Promise.resolve({ rows: [{ id: 'run-1' }] });
      }
      if (runInserted && /INSERT INTO chat_threads/.test(s)) return Promise.reject(new Error('down'));
      if (/UPDATE workflow_runs/.test(s)) return Promise.reject(new Error('still down'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/workflows/wf-1/run')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});

    // A clean 500, not a hang and not a crash.
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to run workflow/);
  });

  it('does not mark anything when the run never got created', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM workflows w/.test(String(sql))) return Promise.reject(new Error('early failure'));
      return Promise.resolve({ rows: [] });
    });

    await request(app).post('/workflows/wf-1/run').set('Authorization', `Bearer ${userToken}`).send({});

    // Nothing was written, so there is nothing to label — and labelling a run id
    // that does not exist would be its own confident-but-wrong write.
    const marking = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /UPDATE workflow_runs/.test(s) && /status = 'error'/.test(s));
    expect(marking).toHaveLength(0);
  });
});

describe('POST /workflows/webhook/:token — a failed run labels itself (the public, unauthenticated sibling of /:id/run, same gap)', () => {
  /** Everything up to the run insert succeeds; the NEXT statement throws. */
  function failAfterRunInsert() {
    let runInserted = false;
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/FROM workflows w/.test(s)) {
        return Promise.resolve({
          rows: [{
            id: 'wf-1', agent_id: 'a-1', agent_slug: 'scout', agent_status: 'running',
            work_token: 'wt', prompt: 'go', created_by: 'user-1', name: 'Nightly Scout',
            allowed_models: ['m'],
          }],
        });
      }
      if (/INSERT INTO workflow_runs/.test(s)) {
        runInserted = true;
        return Promise.resolve({ rows: [{ id: 'run-1', workflow_id: 'wf-1', status: 'running' }] });
      }
      // The step-two failure: the thread insert that follows the run row.
      if (runInserted && /INSERT INTO chat_threads/.test(s)) {
        return Promise.reject(new Error('deadlock detected'));
      }
      if (/UPDATE workflow_runs/.test(s)) return Promise.resolve({ rows: [], rowCount: 1 });
      return Promise.resolve({ rows: [] });
    });
  }

  it('POSITIVE CONTROL: marks the run error instead of leaving it running forever', async () => {
    failAfterRunInsert();

    // No Authorization header — this route is genuinely public (#425 split
    // it into routes/workflows-webhook.ts, mounted ahead of requireAuth).
    const res = await request(app)
      .post('/workflows/webhook/some-token')
      .send({});

    expect(res.status).toBe(500);

    // The load-bearing assertion. Before the fix, NO such update was issued and
    // the row stayed 'running' with nothing able to tell it from a live run.
    const marking = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /UPDATE workflow_runs/.test(s) && /status = 'error'/.test(s));

    expect(marking.length).toBeGreaterThan(0);
    expect(marking[0]).toMatch(/completed_at = NOW\(\)/);
    // Guarded so it cannot resurrect a run that has since finished by another path.
    expect(marking[0]).toMatch(/AND status = 'running'/);

    const params = mockQuery.mock.calls.find(
      (c) => /UPDATE workflow_runs/.test(String(c[0])) && /status = 'error'/.test(String(c[0])),
    )![1] as unknown[];
    expect(params[1]).toBe('run-1');
    expect(String(params[0])).toMatch(/deadlock/);
  });

  it('recording the failure cannot itself take down the request', async () => {
    let runInserted = false;
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/FROM workflows w/.test(s)) {
        return Promise.resolve({
          rows: [{
            id: 'wf-1', agent_id: 'a-1', agent_slug: 'scout', agent_status: 'running',
            work_token: 'wt', prompt: 'go', created_by: 'user-1', name: 'Nightly Scout',
            allowed_models: ['m'],
          }],
        });
      }
      if (/INSERT INTO workflow_runs/.test(s)) {
        runInserted = true;
        return Promise.resolve({ rows: [{ id: 'run-1' }] });
      }
      if (runInserted && /INSERT INTO chat_threads/.test(s)) return Promise.reject(new Error('down'));
      if (/UPDATE workflow_runs/.test(s)) return Promise.reject(new Error('still down'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/workflows/webhook/some-token')
      .send({});

    // A clean 500, not a hang and not a crash.
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Webhook trigger failed/);
  });

  it('does not mark anything when the run never got created', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM workflows w/.test(String(sql))) return Promise.reject(new Error('early failure'));
      return Promise.resolve({ rows: [] });
    });

    await request(app)
      .post('/workflows/webhook/some-token')
      .send({});

    // Nothing was written, so there is nothing to label — and labelling a run id
    // that does not exist would be its own confident-but-wrong write.
    const marking = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /UPDATE workflow_runs/.test(s) && /status = 'error'/.test(s));
    expect(marking).toHaveLength(0);
  });
});

describe('POST /chat/threads — the three inserts are one transaction', () => {
  it('rolls back and does not commit when a later insert fails', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM agents/.test(s)) {
        return Promise.resolve({
          rows: [{ id: 'agent-uuid', agent_id: 'scout', name: 'Scout', status: 'running', work_token: 'wt', models: ['m'] }],
        });
      }
      if (/INSERT INTO chat_threads/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'thread-1', type: 'direct', title: null, created_by: 'user-1', created_at: new Date(), updated_at: new Date() }] });
      }
      // Step two fails: the thread row is already inserted inside the transaction.
      if (/INSERT INTO chat_participants/.test(s)) return Promise.reject(new Error('constraint violation'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid', message: 'hello' });

    expect(res.status).toBe(500);

    // Control flow, not storage — see the file header. With a mocked pool this is
    // the strongest available statement: the work was opened and abandoned, never
    // committed, so no orphan thread can survive.
    expect(clientCalls).toContain('BEGIN');
    expect(clientCalls).toContain('ROLLBACK');
    expect(clientCalls).not.toContain('COMMIT');
  });

  it('commits once on the happy path', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM agents/.test(s)) {
        return Promise.resolve({
          rows: [{ id: 'agent-uuid', agent_id: 'scout', name: 'Scout', status: 'running', work_token: 'wt', models: ['m'] }],
        });
      }
      if (/INSERT INTO chat_threads/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'thread-1', type: 'direct', title: null, created_by: 'user-1', created_at: new Date(), updated_at: new Date() }] });
      }
      if (/INSERT INTO chat_messages/.test(s)) return Promise.resolve({ rows: [{ id: 'msg-1', seq: 1 }] });
      return Promise.resolve({ rows: [] });
    });

    await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid', message: 'hello' });

    // A guard rail: a transaction that never commits is a different bug.
    expect(clientCalls.filter((c) => c === 'COMMIT')).toHaveLength(1);
    expect(clientCalls).not.toContain('ROLLBACK');
  });
});

describe('POST /skills and PUT /skills/:id — the row write and skill_tools resync are one transaction (#424)', () => {
  it('POST /skills rolls back and does not commit when a tool_id is invalid, so no phantom skill row survives', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO skills/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'skill-1', name: 'Broken Skill', scope: 'container_local' }] });
      }
      // setSkillTools's own validation: the tool_id does not exist.
      if (/SELECT id FROM tools/.test(s)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Broken Skill', tool_ids: ['nonexistent-tool'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Tool\(s\) not found/);

    // Control flow, not storage — see the file header. With a mocked pool
    // this is the strongest available statement: the INSERT INTO skills
    // ran inside a transaction that was opened and abandoned, never
    // committed, so no phantom skill row can survive it.
    expect(clientCalls).toContain('BEGIN');
    expect(clientCalls).toContain('ROLLBACK');
    expect(clientCalls).not.toContain('COMMIT');
  });

  it('POST /skills commits once when tool_ids are all valid', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO skills/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'skill-1', name: 'Good Skill', scope: 'container_local' }] });
      }
      if (/SELECT id FROM tools/.test(s)) return Promise.resolve({ rows: [{ id: 'tool-1' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Good Skill', tool_ids: ['tool-1'] });

    expect(res.status).toBe(201);
    expect(clientCalls.filter((c) => c === 'COMMIT')).toHaveLength(1);
    expect(clientCalls).not.toContain('ROLLBACK');
  });

  it('PUT /skills/:id rolls back and does not commit when the resync fails mid-loop, so the row update does not partially survive', async () => {
    let deleteRan = false;
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });
      if (/SELECT id, scope FROM skills/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'skill-1', scope: 'container_local' }] });
      }
      if (/UPDATE skills SET/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'skill-1', name: 'Renamed', scope: 'container_local' }] });
      }
      if (/SELECT id FROM tools/.test(s)) return Promise.resolve({ rows: [{ id: 'tool-1' }, { id: 'tool-2' }] });
      if (/DELETE FROM skill_tools/.test(s)) { deleteRan = true; return Promise.resolve({ rowCount: 1 }); }
      // The step-two failure: the resync loop's insert, after the delete.
      if (deleteRan && /INSERT INTO skill_tools/.test(s)) return Promise.reject(new Error('connection reset'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .put('/skills/skill-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed', tool_ids: ['tool-1', 'tool-2'] });

    expect(res.status).toBe(500);

    // Before this fix, the UPDATE skills row and the DELETE FROM
    // skill_tools had already committed independently by the time the
    // INSERT loop failed — a reported 500 that had, in fact, partially
    // succeeded and wiped existing tool associations along the way.
    expect(clientCalls).toContain('BEGIN');
    expect(clientCalls).toContain('ROLLBACK');
    expect(clientCalls).not.toContain('COMMIT');
  });
});

describe('POST /chat/threads/:id/messages — the user message and the thread bump are one transaction', () => {
  /**
   * A direct thread, one running agent, nothing pending — the shortest path
   * to the two writes under test. Every read before them (isParticipant,
   * getThreadType, getThreadAgents, getAgentForDispatch, the elevated-scope
   * pre-flight, the per-agent concurrency guard) is answered so the route
   * reaches the INSERT.
   */
  function mockReadsThenFailOn(failingPattern: RegExp) {
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });
      if (failingPattern.test(s)) return Promise.reject(new Error('connection reset'));
      if (/participant_type = 'human'/.test(s)) return Promise.resolve({ rows: [{ '?column?': 1 }] }); // isParticipant
      if (/SELECT type, lead_agent_id FROM chat_threads/.test(s)) {
        return Promise.resolve({ rows: [{ type: 'direct', lead_agent_id: null }] }); // getThreadType
      }
      if (/chat_participants/.test(s) && /participant_type = 'agent'/.test(s)) {
        return Promise.resolve({ rows: [{ participant_id: 'agent-uuid' }] }); // getThreadAgents
      }
      if (/FROM agents a/.test(s)) {
        return Promise.resolve({
          rows: [{ id: 'agent-uuid', agent_id: 'test-agent', name: 'Test', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
        }); // getAgentForDispatch
      }
      if (/FROM agent_skills asks/.test(s)) return Promise.resolve({ rows: [] }); // getAgentElevatedScope
      if (/author_type = 'agent' AND status = 'pending'/.test(s)) return Promise.resolve({ rows: [] }); // concurrency guard
      if (/INSERT INTO chat_messages/.test(s)) return Promise.resolve({ rows: [{ id: 'user-msg-1', seq: 1 }] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('rolls back and does not commit when the thread-timestamp UPDATE fails, so the user message INSERT does not survive as an orphan', async () => {
    mockReadsThenFailOn(/UPDATE chat_threads SET updated_at/);

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'hello' });

    expect(res.status).toBe(500);

    // THE ASSERTION THAT MATTERS: the database, not the response. Before this
    // fix, the INSERT ran on the bare pool and committed independently — a
    // 'complete' user message with no assistant reply ever dispatched for
    // it, surviving a request the caller was told had failed. A retry
    // without an idempotency_key would not find it (the concurrency guard
    // only checks for a PENDING agent message) and would create a second,
    // duplicate message instead, leaving the first orphaned forever. With
    // both writes now one transaction, the INSERT must have been opened and
    // abandoned, never committed.
    expect(clientCalls).toContain('BEGIN');
    expect(clientCalls).toContain('ROLLBACK');
    expect(clientCalls).not.toContain('COMMIT');
    expect(mockDispatchChatWork).not.toHaveBeenCalled();
  });

  it('commits once on the happy path', async () => {
    mockReadsThenFailOn(/(?!)/); // a pattern that never matches — nothing fails

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'hello' });

    expect(res.status).toBe(201);
    // A guard rail: a transaction that never commits is a different bug.
    expect(clientCalls.filter((c) => c === 'COMMIT')).toHaveLength(1);
    expect(clientCalls).not.toContain('ROLLBACK');
  });
});
