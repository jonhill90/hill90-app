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

jest.mock('../db/pool', () => ({
  getPool: () => ({
    query: mockQuery,
    connect: async () => ({
      query: (sql: unknown, params?: unknown) => {
        clientCalls.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
        return mockQuery(sql, params);
      },
      release: () => {},
    }),
  }),
}));

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: jest.fn(),
}));

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const userToken = jwt.sign(
  { sub: 'user-1', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' },
);

beforeEach(() => {
  mockQuery.mockReset();
  clientCalls.length = 0;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
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
