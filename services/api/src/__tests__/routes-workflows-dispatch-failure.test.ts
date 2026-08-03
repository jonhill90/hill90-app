/**
 * A workflow dispatch failure must not leave an unhandled rejection behind.
 *
 * `POST /workflows/:id/run` and `POST /workflows/webhook/:token` dispatch
 * fire-and-forget and record the failure in `workflow_runs` from inside a
 * `.catch()`. That recording query had no handler of its own, so when the
 * database rejected it — the case most likely to coincide with a dispatch
 * failure, since one outage causes both — the rejection escaped. Node 20
 * terminates the process on an unhandled rejection by default and this service
 * installs no `process.on('unhandledRejection')`, so a double failure that
 * should have been a log line would take the API container down.
 *
 * INSTRUMENT NOTE, recorded because the obvious one does not work here: a
 * `process.on('unhandledRejection')` listener registered inside a test never
 * fires under jest's node environment — measured, it reported 0 for a
 * deliberate `Promise.reject`. A detector that cannot see its own positive
 * control is worse than none, so it was removed. What these tests assert
 * instead is the observable consequence of the rejection being handled: the
 * failure is logged rather than escaping. That assertion fails before the fix
 * and passes after, which is the control.
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

/**
 * Resolve every query except the one that records a dispatch failure, which
 * rejects. Narrowed to that single statement on purpose: if the later awaited
 * queries rejected too, the route's own try/catch would absorb the failure and
 * the test would pass for the wrong reason.
 */
function rejectOnlyTheErrorRecordingQuery() {
  mockQuery.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && /UPDATE workflow_runs SET status = 'error'/.test(sql)) {
      return Promise.reject(new Error('database is down'));
    }
    if (/INSERT INTO workflow_runs/.test(sql)) return Promise.resolve({ rows: [{ id: 'run-1' }] });
    if (/INSERT INTO chat_threads/.test(sql)) return Promise.resolve({ rows: [{ id: 'thread-1' }] });
    if (/INSERT INTO chat_messages/.test(sql)) return Promise.resolve({ rows: [{ id: 'msg-1' }] });
    if (/SELECT mp.allowed_models/.test(sql)) return Promise.resolve({ rows: [{ allowed_models: ['m'] }] });
    if (/FROM workflows w/.test(sql)) return Promise.resolve({ rows: [WF] });
    return Promise.resolve({ rows: [] });
  });
}

/** Give the fire-and-forget chain time to settle before asserting on it. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('a failed dispatch whose error-recording query also fails is handled, not escaped', () => {
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockRejectedValue(new Error('agent unreachable'));
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    errSpy.mockRestore();
  });

  it('POST /workflows/:id/run logs the recording failure instead of letting it escape', async () => {
    rejectOnlyTheErrorRecordingQuery();

    await request(app)
      .post('/workflows/wf-1/run')
      .set('Authorization', `Bearer ${userToken}`);
    await settle();

    // Prove the path was exercised before asserting on how it was handled: a
    // test that never reaches the recording query would fail for a duller reason.
    const sql = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /UPDATE workflow_runs SET status = 'error'/.test(s))).toBe(true);

    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' '));
    expect(logged.some((l) => /Failed to record dispatch failure/.test(l))).toBe(true);
  });

  it('POST /workflows/webhook/:token logs the recording failure instead of letting it escape', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && /UPDATE workflow_runs SET status = 'error'/.test(sql)) {
        return Promise.reject(new Error('database is down'));
      }
      if (/INSERT INTO workflow_runs/.test(sql)) return Promise.resolve({ rows: [{ id: 'run-1' }] });
      if (/INSERT INTO chat_threads/.test(sql)) return Promise.resolve({ rows: [{ id: 'thread-1' }] });
      if (/INSERT INTO chat_messages/.test(sql)) return Promise.resolve({ rows: [{ id: 'msg-1' }] });
      if (/FROM workflows/.test(sql)) return Promise.resolve({ rows: [WF] });
      return Promise.resolve({ rows: [] });
    });

    // The webhook route declares no role of its own, but the router is mounted
    // behind authentication, so an unauthenticated call 401s before reaching it.
    await request(app)
      .post('/workflows/webhook/tok-123')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ prompt: 'go' });
    await settle();

    const sql = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /UPDATE workflow_runs SET status = 'error'/.test(s))).toBe(true);

    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' '));
    expect(logged.some((l) => /Failed to record dispatch failure/.test(l))).toBe(true);
  });
});
