// MODULE SCOPE, not global — see scripts/check-test-module-scope.js.
export {}

/**
 * app#488: the scheduler's initializeNextRuns() is a ONE-TIME sweep at
 * process boot — the only place next_run_at was ever computed for a row
 * that didn't already have one. tick() (the recurring loop) only polls
 * `next_run_at <= NOW()`; it never looks for NULL. POST /workflows never
 * set next_run_at on INSERT. So a workflow created any time after boot —
 * the overwhelmingly common case for a long-lived process — was written
 * with next_run_at = NULL and stayed that way, indistinguishable from a
 * legitimate webhook-triggered workflow, until the process happened to
 * restart.
 *
 * THE TEST SHAPE THIS ISSUE ITSELF WARNS AGAINST: creating a workflow and
 * THEN starting the scheduler proves the wrong thing — that's the boot
 * sweep finding a pre-existing NULL row, which already worked before this
 * fix and is not the defect. The order here is deliberately: scheduler
 * starts first (simulating an API that has already been running for a
 * while), THEN the workflow is created — and the row must already carry a
 * next_run_at without the scheduler ever being told about it again.
 *
 * `startWorkflowScheduler()` is a real `setInterval` with no handle
 * exposed to clear it — fake timers are used so the 60s interval it
 * registers is never a real, uncleared OS timer left behind after this
 * file's tests finish.
 */
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));
jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: jest.fn().mockResolvedValue({ accepted: true, work_id: 'work-1' }),
}));

import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const userToken = jwt.sign(
  { sub: 'regular-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

beforeEach(() => {
  mockQuery.mockReset();
  // ONLY setInterval/clearInterval faked — startWorkflowScheduler()'s
  // `setInterval` never becomes a real, uncleared 60s OS timer left behind
  // after this file's tests finish. Everything else (setTimeout,
  // setImmediate, process.nextTick, Date) stays real: supertest/express's
  // own internals depend on real timers, and faking them made every request
  // in this file hang until Jest's per-test timeout.
  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'nextTick', 'performance', 'Date', 'queueMicrotask'],
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.resetModules();
});

async function flush() {
  // Real microtask/macrotask flush — the fire-and-forget
  // `void initializeNextRuns()` inside startWorkflowScheduler() needs a
  // couple of real ticks to actually run its `await pool.query(...)` and
  // resolve.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('a workflow created while the scheduler is already running (app#488)', () => {
  it('POSITIVE CONTROL: the row gets next_run_at without any restart or second scheduler pass', async () => {
    // The app is constructed fresh per-test so `../db/pool`'s mock (reset in
    // beforeEach) is what both the scheduler module and the routes module see.
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

    const { startWorkflowScheduler } = await import('../services/workflow-scheduler');

    // Boot-time sweep: no pre-existing NULL rows to fix. This is the ONLY
    // query the scheduler issues before the workflow below is created —
    // asserted explicitly further down, so "the scheduler ran again" can't
    // be the silent explanation for a passing test.
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, schedule_cron FROM workflows/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // SIMULATES THE API ALREADY BEING UP. Not called after creating the
    // workflow — that would be the passing-today, wrong-proof shape.
    startWorkflowScheduler();
    await flush();

    const bootQueries = mockQuery.mock.calls.length;
    expect(bootQueries).toBeGreaterThan(0); // the boot sweep genuinely ran

    // Now, well after "boot", a user creates a cron workflow through the
    // real route — no different from a workflow created hours into uptime.
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid' }] }); // agent-exists check
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      // The INSERT itself — echo back what a real RETURNING would hand back,
      // including the next_run_at value the route computed and bound.
      const boundNextRunAt = (params as unknown[])[11]; // next_run_at is the 12th bound param
      return Promise.resolve({
        rows: [{
          id: 'wf-1',
          name: 'Nightly Digest',
          schedule_cron: '0 9 * * *',
          trigger_type: 'cron',
          next_run_at: boundNextRunAt,
        }],
      });
    });

    const res = await request(app)
      .post('/workflows')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Nightly Digest',
        agent_id: 'agent-uuid',
        schedule_cron: '0 9 * * *',
        prompt: 'Summarize the day',
      });

    expect(res.status).toBe(201);

    // THE LOAD-BEARING ASSERTION. Before this fix, next_run_at was never a
    // bound parameter on the INSERT at all — the column wasn't in the
    // statement. The response must carry a real, non-null timestamp, set by
    // the CREATE request itself, not by any later scheduler pass — none ran
    // after the "boot" sweep above, and the test asserts that explicitly.
    expect(res.body.next_run_at).toBeTruthy();
    expect(new Date(res.body.next_run_at).getTime()).not.toBeNaN();

    // The INSERT's own bound parameter list carried it — not just the
    // mocked RETURNING echoing something back.
    const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO workflows/.test(String(c[0])));
    expect(insertCall).toBeDefined();
    const boundParams = insertCall![1] as unknown[];
    expect(boundParams[11]).not.toBeNull(); // next_run_at, 12th bound param
    expect(boundParams[11]).toBeInstanceOf(Date);

    // And the value is what computeNextRun would actually produce for this
    // cron ("0 9 * * *" — 9am daily) — not merely truthy.
    const { computeNextRun } = await import('../helpers/cron');
    const expected = computeNextRun('0 9 * * *');
    expect((boundParams[11] as Date).getTime()).toBe(expected!.getTime());
  });

  it('CONTROL: a webhook-triggered workflow still legitimately gets next_run_at = null', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    const { startWorkflowScheduler } = await import('../services/workflow-scheduler');

    mockQuery.mockResolvedValue({ rows: [] });
    startWorkflowScheduler();
    await flush();

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid' }] });
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const boundNextRunAt = (params as unknown[])[11];
      return Promise.resolve({
        rows: [{ id: 'wf-2', name: 'Webhook Flow', trigger_type: 'webhook', next_run_at: boundNextRunAt }],
      });
    });

    const res = await request(app)
      .post('/workflows')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Webhook Flow',
        agent_id: 'agent-uuid',
        schedule_cron: '* * * * *',
        prompt: 'Handle webhook',
        trigger_type: 'webhook',
      });

    expect(res.status).toBe(201);
    expect(res.body.next_run_at).toBeFalsy();

    const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO workflows/.test(String(c[0])));
    const boundParams = insertCall![1] as unknown[];
    expect(boundParams[11]).toBeNull();
  });
});
