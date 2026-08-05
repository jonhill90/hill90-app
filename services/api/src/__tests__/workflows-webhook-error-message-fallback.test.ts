/**
 * POST /workflows/webhook/:token's fire-and-forget dispatch failure handler
 * used `err.message` raw, with no fallback, when recording the failure into
 * `workflow_runs.error`.
 *
 * THE DEFECT — the twin of a bug already fixed on the sibling route. This
 * is the exact CLAUDE.md-documented shape ("the fix went to one route and
 * not the other," #141/#153): `routes/workflows.ts`'s identical
 * dispatch-failure `.catch()` writes `err.message || 'Dispatch failed'`
 * (routes/workflows.ts:381). This route's own `.catch()` — same shape, same
 * job, one route over — never got the fallback.
 *
 * If the fire-and-forget `dispatchChatWork(...)` call rejects with a
 * non-Error value (a plain object or string), `err.message` is `undefined`.
 * `pool.query` binds it as `NULL`, so the run lands as `status='error',
 * error=NULL` — an operator or the workflow-run UI sees "failed, no reason
 * given" for a run that likely had a real, recordable cause.
 *
 * WHAT THIS TEST PROVES. That the recorded `error` value is a real,
 * non-empty string when the rejection carries no `.message`. It reuses the
 * same mock shape and `settle()` pattern as
 * routes-workflows-dispatch-failure.test.ts, which covers the sibling
 * "recording query itself fails" case for both routes — this test is about
 * what gets WRITTEN, not whether the write itself is handled.
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
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockDispatchChatWork = jest.fn();
jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: (...args: any[]) => mockDispatchChatWork(...args),
}));

const userToken = jwt.sign(
  { sub: 'regular-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const WF = {
  id: 'wf-1',
  name: 'Daily Health Check',
  agent_id: 'agent-uuid',
  agent_slug: 'health-bot',
  agent_status: 'running',
  work_token: 'tok',
  prompt: 'Check system health',
  created_by: 'regular-user',
  enabled: true,
};

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('POST /workflows/webhook/:token records a real error string on a non-Error dispatch rejection', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    // The rejection carries no .message at all — a plain object, the shape
    // several dependencies in this path are capable of throwing.
    mockDispatchChatWork.mockRejectedValue({ code: 'ECONNREFUSED' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

    mockQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO workflow_runs/.test(sql)) return Promise.resolve({ rows: [{ id: 'run-1' }] });
      if (/INSERT INTO chat_threads/.test(sql)) return Promise.resolve({ rows: [{ id: 'thread-1' }] });
      if (/INSERT INTO chat_messages/.test(sql)) return Promise.resolve({ rows: [{ id: 'msg-1' }] });
      if (/FROM workflows/.test(sql)) return Promise.resolve({ rows: [WF] });
      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('THE ASSERTION THAT MATTERS: the recorded error is a real string, not undefined/NULL', async () => {
    await request(app)
      .post('/workflows/webhook/tok-123')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ prompt: 'go' });
    await settle();

    const errorUpdateCall = mockQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && /UPDATE workflow_runs SET status = 'error'/.test(c[0])
    );
    expect(errorUpdateCall).toBeDefined();
    const [, params] = errorUpdateCall!;
    expect(typeof params[0]).toBe('string');
    expect(params[0].length).toBeGreaterThan(0);
  });
});
