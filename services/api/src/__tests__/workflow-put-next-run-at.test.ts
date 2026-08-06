// MODULE SCOPE, not global — see scripts/check-test-module-scope.js.
export {}

/**
 * app#580: `PUT /workflows/:id`'s UPDATE statement never mentioned
 * next_run_at at all — not even COALESCE'd, simply absent from the SET
 * clause. Postgres leaves an unlisted column exactly as it was, so the
 * answer to "does it keep its old value or go null" is: IT KEEPS ITS OLD
 * VALUE. A workflow whose schedule_cron is edited keeps firing on the OLD
 * schedule (self-correcting after that one stale-timed run, since
 * executeWorkflow recomputes from the then-current cron) — never a
 * permanent stop, unlike app#488's original defect. Established by reading
 * the UPDATE statement directly before writing any fix, not assumed.
 *
 * THREE TRANSITIONS CHECKED, per instruction to have the full set rather
 * than one issue at a time:
 *   1. schedule_cron changes — the stored value is stale, computed from
 *      the OLD cron. FIXED: recomputed from the new cron.
 *   2. disabled -> enabled (re-enable) — the stored value may be far in
 *      the past (however long the workflow sat disabled), which would
     *      fire it immediately on the next tick instead of at its real next
 *      occurrence. FIXED: recomputed fresh from NOW.
 *   3. enabled -> disabled alone (no cron change) — NOT recomputed,
 *      correctly: tick() filters `enabled = true`, so a stale value on a
 *      disabled row is inert. Verified explicitly below that this case
 *      does NOT touch the column, so a future "just always recompute"
 *      change would be caught changing this test.
 *
 * ALSO FOUND while establishing the mechanism: PUT's cron validation used
 * `if (schedule_cron && ...)`, a truthy check that skipped validation for
 * an empty string. `schedule_cron: ""` would have written an unvalidated
 * empty string, and the next time that workflow's stale next_run_at fired,
 * computeNextRun('') returns null (empty string is falsy) exactly like a
 * legitimate webhook workflow — silently reproducing app#488's original
 * "never runs again" defect through PUT. Fixed in the same change since it
 * is a live path to an absent next_run_at, which this issue's own
 * instruction asked to be surfaced if found.
 *
 * THE TEST SHAPE APP#488 WARNED AGAINST, reused here: mutating a workflow
 * BEFORE starting the scheduler would only prove the scheduler's own boot
 * sweep works. Every test below starts the scheduler FIRST, flushes its
 * boot sweep, THEN issues the PUT — and asserts the resulting VALUE
 * (compared against what computeNextRun independently produces), not just
 * that the column is non-null. A stale-but-non-null value is exactly the
 * bug this issue is about, and "non-null" alone would not catch it.
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
  // ONLY setInterval/clearInterval faked — see app#488's identical note.
  // Faking setImmediate hung every supertest request in this file too.
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
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/** Starts the scheduler and lets its fire-and-forget boot sweep settle, simulating an API that has already been running for a while — never called after the mutation under test. */
async function startAlreadyRunningScheduler() {
  const { startWorkflowScheduler } = await import('../services/workflow-scheduler');
  mockQuery.mockResolvedValue({ rows: [] }); // boot sweep: nothing to fix
  startWorkflowScheduler();
  await flush();
  mockQuery.mockReset();
}

describe('PUT /workflows/:id and next_run_at (app#580)', () => {
  it('POSITIVE CONTROL: changing schedule_cron on an already-running scheduler recomputes next_run_at to the NEW cron\'s value, not merely non-null', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    // SELECT existing row: enabled, unchanged old schedule, cron type.
    mockQuery.mockResolvedValueOnce({
      rows: [{ enabled: true, schedule_cron: '0 9 * * *', trigger_type: 'cron' }],
    });
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const boundNextRunAt = params[8]; // next_run_at is the 9th bound param
      return Promise.resolve({
        rows: [{ id: 'wf-1', schedule_cron: '30 14 * * *', enabled: true, next_run_at: boundNextRunAt }],
      });
    });

    const res = await request(app)
      .put('/workflows/wf-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ schedule_cron: '30 14 * * *' }); // was 9am daily, now 2:30pm daily

    expect(res.status).toBe(200);

    const updateCall = mockQuery.mock.calls.find((c) => /UPDATE workflows SET/.test(String(c[0])));
    expect(updateCall).toBeDefined();
    const bound = updateCall![1] as unknown[];
    expect(bound[8]).not.toBeNull();
    expect(bound[8]).toBeInstanceOf(Date);

    // THE VALUE, not just non-null — a stale value (e.g. still the 9am
    // computation) would also be "not null" and pass a weaker assertion.
    const { computeNextRun } = await import('../helpers/cron');
    const expected = computeNextRun('30 14 * * *');
    expect((bound[8] as Date).getTime()).toBe(expected!.getTime());

    // And it is NOT the value the old cron would have produced — confirms
    // the assertion above is actually discriminating, not coincidentally
    // matching (the two crons run at very different times of day).
    const staleValue = computeNextRun('0 9 * * *');
    expect((bound[8] as Date).getTime()).not.toBe(staleValue!.getTime());
  });

  it('re-enabling a disabled workflow (unchanged cron) recomputes next_run_at fresh from NOW, not the stale disabled-since value', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    mockQuery.mockResolvedValueOnce({
      rows: [{ enabled: false, schedule_cron: '0 9 * * *', trigger_type: 'cron' }],
    });
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const boundNextRunAt = params[8];
      return Promise.resolve({
        rows: [{ id: 'wf-2', schedule_cron: '0 9 * * *', enabled: true, next_run_at: boundNextRunAt }],
      });
    });

    const res = await request(app)
      .put('/workflows/wf-2')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ enabled: true }); // re-enable, cron untouched

    expect(res.status).toBe(200);

    const updateCall = mockQuery.mock.calls.find((c) => /UPDATE workflows SET/.test(String(c[0])));
    const bound = updateCall![1] as unknown[];
    expect(bound[8]).toBeInstanceOf(Date);

    const { computeNextRun } = await import('../helpers/cron');
    const expected = computeNextRun('0 9 * * *');
    expect((bound[8] as Date).getTime()).toBe(expected!.getTime());
  });

  it('CONTROL: disabling a workflow, with no cron change, does NOT touch next_run_at — the value stays inert and untouched, not recomputed', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    mockQuery.mockResolvedValueOnce({
      rows: [{ enabled: true, schedule_cron: '0 9 * * *', trigger_type: 'cron' }],
    });
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const boundNextRunAt = params[8];
      return Promise.resolve({
        rows: [{ id: 'wf-3', schedule_cron: '0 9 * * *', enabled: false, next_run_at: boundNextRunAt }],
      });
    });

    const res = await request(app)
      .put('/workflows/wf-3')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);

    const updateCall = mockQuery.mock.calls.find((c) => /UPDATE workflows SET/.test(String(c[0])));
    const bound = updateCall![1] as unknown[];
    // null = "do not touch" (COALESCE keeps the existing column value) —
    // not a real value being written.
    expect(bound[8]).toBeNull();
  });

  it('CONTROL: an edit to an unrelated field on an already-enabled, unchanged-schedule workflow leaves next_run_at untouched', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    mockQuery.mockResolvedValueOnce({
      rows: [{ enabled: true, schedule_cron: '0 9 * * *', trigger_type: 'cron' }],
    });
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const boundNextRunAt = params[8];
      return Promise.resolve({
        rows: [{ id: 'wf-4', name: 'Renamed', schedule_cron: '0 9 * * *', enabled: true, next_run_at: boundNextRunAt }],
      });
    });

    const res = await request(app)
      .put('/workflows/wf-4')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);

    const updateCall = mockQuery.mock.calls.find((c) => /UPDATE workflows SET/.test(String(c[0])));
    const bound = updateCall![1] as unknown[];
    expect(bound[8]).toBeNull();
  });

  it("POSITIVE CONTROL (validation bypass): schedule_cron: '' is rejected with 400, not silently written unvalidated", async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    // If this reaches the DB at all, the old `if (schedule_cron && ...)`
    // truthy check would have let it through — asserting no query beyond
    // this point runs proves the 400 fires before any write is attempted.
    const res = await request(app)
      .put('/workflows/wf-5')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ schedule_cron: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cron');
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  it('webhook-triggered workflows are never given a next_run_at by this route, even if schedule_cron is (incorrectly) sent', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    mockQuery.mockResolvedValueOnce({
      rows: [{ enabled: true, schedule_cron: null, trigger_type: 'webhook' }],
    });
    mockQuery.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const boundNextRunAt = params[8];
      return Promise.resolve({
        rows: [{ id: 'wf-6', trigger_type: 'webhook', next_run_at: boundNextRunAt }],
      });
    });

    const res = await request(app)
      .put('/workflows/wf-6')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ schedule_cron: '0 9 * * *' });

    expect(res.status).toBe(200);

    const updateCall = mockQuery.mock.calls.find((c) => /UPDATE workflows SET/.test(String(c[0])));
    const bound = updateCall![1] as unknown[];
    expect(bound[8]).toBeNull();
  });
});

// app#450: POST verifies the referenced agent exists before insert and
// returns a clean 404; PUT fed agent_id straight into COALESCE with no
// check at all. workflows.agent_id has a real FK to agents(id), so a
// nonexistent value never corrupted a row silently — it threw a raw
// FK-violation, caught by the generic catch as an undifferentiated 500
// instead of the 404 the identical bad input gets on create.
describe('PUT /workflows/:id and agent_id existence (app#450)', () => {
  it('rejects a nonexistent agent_id with 404, matching POST — and writes nothing', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    // Agent-exists check: no matching row.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/workflows/wf-7')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'nonexistent-agent' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Agent not found');
    // THE ASSERTION THAT MATTERS: a clean 404 that still reaches the
    // workflow lookup/UPDATE is the same defect one query later — before
    // this fix there was no agent-exists query at all, so the workflow's
    // own SELECT ran next and (absent an FK violation) the UPDATE could
    // still fire. Exactly one query — the agent-exists check — must run.
    expect(mockQuery.mock.calls.length).toBe(1);
  });

  it('accepts an existing agent_id and updates normally', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    // Agent-exists check: found.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid-2' }] });
    // Workflow existing-row read.
    mockQuery.mockResolvedValueOnce({
      rows: [{ enabled: true, schedule_cron: '0 9 * * *', trigger_type: 'cron' }],
    });
    // UPDATE.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'wf-8', agent_id: 'agent-uuid-2', enabled: true }],
    });

    const res = await request(app)
      .put('/workflows/wf-8')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid-2' });

    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls.length).toBe(3);
  });
});

// app#599 (Type B half of #597's COALESCE-falsy sweep). POST requires
// name/prompt non-empty and rejects an unrecognized output_type; PUT had
// no validator for any of the three, and each is passed raw into COALESCE
// below (no `|| null` conversion) — an explicit '' would have been
// WRITTEN, unlike every falsy-becomes-null field in this same UPDATE.
describe('PUT /workflows/:id required-field and output_type parity (app#599)', () => {
  it("rejects name: '' — matching POST — and writes nothing", async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    const res = await request(app)
      .put('/workflows/wf-9')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
    // THE ASSERTION THAT MATTERS: a 400 that still reaches the workflow
    // lookup/UPDATE is the same defect one query later.
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  it("rejects prompt: '' — matching POST — and writes nothing", async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    const res = await request(app)
      .put('/workflows/wf-9')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ prompt: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('prompt');
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  it('rejects an unrecognized output_type — and writes nothing', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    const res = await request(app)
      .put('/workflows/wf-9')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ output_type: 'webhook_callback' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('output_type');
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  // Cross-review of #594/#601: null and undefined both mean "not
  // provided", matching #594's already-argued position for transport and
  // COALESCE's own behavior for a bound SQL NULL.
  it('accepts prompt: null as "not provided" (no-op)', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    mockQuery.mockResolvedValueOnce({
      rows: [{ enabled: true, schedule_cron: '0 9 * * *', trigger_type: 'cron' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'wf-11', description: 'Updated desc' }],
    });

    const res = await request(app)
      .put('/workflows/wf-11')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ prompt: null, description: 'Updated desc' });

    expect(res.status).toBe(200);
    const updateCall = mockQuery.mock.calls.find((c) => /UPDATE workflows SET/.test(String(c[0])));
    // prompt is bound param index 4 in this route's UPDATE ordering.
    expect((updateCall![1] as unknown[])[4]).toBeNull();
  });

  it('accepts a real name/prompt/output_type change and updates normally', async () => {
    const { createApp } = await import('../app');
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    await startAlreadyRunningScheduler();

    mockQuery.mockResolvedValueOnce({
      rows: [{ enabled: true, schedule_cron: '0 9 * * *', trigger_type: 'cron' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'wf-10', name: 'Renamed', prompt: 'New prompt', output_type: 'none' }],
    });

    const res = await request(app)
      .put('/workflows/wf-10')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Renamed', prompt: 'New prompt', output_type: 'none' });

    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls.length).toBe(2);
  });
});
