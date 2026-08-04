/**
 * A create that answers 500 must leave nothing behind (#212).
 *
 * THE DEFECT, read from the code rather than the issue text. `POST /agents`
 * runs four statements on the pool, each its own autocommitted transaction:
 * `INSERT INTO agents`, an optional model-policy upsert plus `UPDATE agents`,
 * an `INSERT INTO agent_skills` per skill, then a `SELECT` for the response.
 * Any failure after the first lands in the catch at the bottom and answers
 * `500 {"error":"Failed to create agent"}` — with the agent row already
 * committed. The caller is told the create failed; the agent is in the list.
 *
 * It is the MIRROR of the family closed this week: not an operation that fails
 * and reports success, but one that half-succeeds and reports failure. The
 * damage is the same shape, because the caller acts on a false picture — and
 * here it is worse on retry, since the same `agent_id` then answers
 * `409 already exists`, so the user is told the create both failed and happened.
 *
 * WHY THE FAKE POOL MODELS COMMIT SEMANTICS. The defect is not "which SQL runs"
 * but "what survives a failure", so the fake distinguishes the two things the
 * real database distinguishes: a statement run on the pool is committed the
 * moment it returns, and a statement run inside BEGIN survives only if COMMIT
 * follows. That makes this test red against the code as written — no BEGIN, so
 * the INSERT is committed and still there after the 500 — and green only when
 * the sequence genuinely rolls back. It asserts the property, not the syntax.
 *
 * WHAT IT CANNOT CATCH is stated in the PR and repeated here: a crash between
 * COMMIT and the response reaching the caller. The row is then correct and
 * complete, and the caller still saw a failure. No amount of atomicity fixes
 * that — only an idempotency key would — and nothing here pretends otherwise.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

/** Rows the fake has "committed", i.e. what a later reader would see. */
const committed: Array<{ sql: string; params: unknown[] }> = [];
/** Writes staged inside an open transaction, discarded on ROLLBACK. */
let staged: Array<{ sql: string; params: unknown[] }> = [];
let inTransaction = false;
/** SQL fragment that should make its statement fail, simulating a mid-create fault. */
let failOn: string | null = null;

const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);

function answer(sql: string): { rows: any[] } {
  if (/INSERT INTO agents/i.test(sql)) {
    return { rows: [{ id: 'uuid-1', agent_id: 'half-made', name: 'Half Made', status: 'stopped', created_by: 'regular-user' }] };
  }
  if (/FROM skills WHERE name = ANY/i.test(sql)) {
    return { rows: [{ id: 'skill-1', tools_config: {}, scope: 'container_local' }] };
  }
  if (/FROM skills WHERE id = ANY/i.test(sql)) {
    return { rows: [{ id: 'skill-1', tools_config: {}, scope: 'container_local' }] };
  }
  if (/FROM user_models WHERE name/i.test(sql)) return { rows: [{ id: 'model-1' }] };
  if (/FROM model_policies/i.test(sql)) return { rows: [] };
  if (/INSERT INTO model_policies/i.test(sql)) return { rows: [{ id: 'policy-1' }] };
  return { rows: [] };
}

async function runStatement(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
  if (/^\s*BEGIN/i.test(sql)) { inTransaction = true; staged = []; return { rows: [] } }
  if (/^\s*COMMIT/i.test(sql)) { committed.push(...staged); staged = []; inTransaction = false; return { rows: [] } }
  if (/^\s*ROLLBACK/i.test(sql)) { staged = []; inTransaction = false; return { rows: [] } }

  if (failOn && sql.includes(failOn)) {
    const err: any = new Error(`simulated failure on: ${failOn}`);
    err.code = '08006'; // connection failure — not a constraint violation
    throw err;
  }

  if (isWrite(sql)) {
    // The distinction the whole test rests on: on the pool, a write is
    // committed the instant it returns. Inside a transaction it is not.
    (inTransaction ? staged : committed).push({ sql, params });
  }
  return answer(sql);
}

const mockQuery = jest.fn((sql: string, params?: unknown[]) => runStatement(sql, params));

// `withTransaction` is mirrored here rather than imported, because the real one
// resolves `getPool()` through its own module scope and would open a real pg
// connection. So this file proves the ROUTE property — nothing survives a
// reported failure, GIVEN a helper that behaves like a transaction — and the
// helper's own behaviour (BEGIN, COMMIT, ROLLBACK, release) is pinned separately
// in `with-transaction.test.ts`. Two tests, because they are two claims.
//
// The first version of this file omitted `withTransaction` from the mock
// entirely. Every control still passed — the route threw before the INSERT, so
// nothing was committed for a reason that had nothing to do with the fix. A
// control that passes for the wrong reason is worse than no control, and the
// only thing that caught it was the SUCCESS twin going red.
jest.mock('../db/pool', () => ({
  getPool: () => ({
    query: mockQuery,
    connect: async () => ({ query: mockQuery, release: () => {} }),
  }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
    const client = { query: mockQuery };
    await mockQuery('BEGIN');
    try {
      const out = await fn(client);
      await mockQuery('COMMIT');
      return out;
    } catch (err) {
      await mockQuery('ROLLBACK');
      throw err;
    }
  },
}));

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
}));
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
const userToken = jwt.sign(
  { sub: 'regular-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
);

const agentsCommitted = () => committed.filter((c) => /INSERT INTO agents/i.test(c.sql));

beforeEach(() => {
  committed.length = 0;
  staged = [];
  inTransaction = false;
  failOn = null;
  mockQuery.mockClear();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('POST /agents — a reported failure must leave nothing behind', () => {
  it('POSITIVE CONTROL: a failure on the skills insert leaves no agent row', async () => {
    // The fixture that separates the versions: the create gets PAST the agent
    // INSERT and then fails. With a success, or with a failure before the
    // insert, committed-or-not is identical either way.
    failOn = 'INSERT INTO agent_skills';

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'half-made', name: 'Half Made', skill_ids: ['skill-1'] });

    expect(res.status).toBe(500);
    // The whole issue in one assertion: the caller was told it failed, so it
    // must have failed.
    expect(agentsCommitted()).toHaveLength(0);
  });

  it('POSITIVE CONTROL: a failure on the model-policy update leaves no agent row', async () => {
    // The other post-insert step, because a fix applied to one and not the
    // other is the drift this repository keeps meeting.
    failOn = 'UPDATE agents SET model_policy_id';

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'half-made', name: 'Half Made', model_names: ['gpt-4o-mini'] });

    expect(res.status).toBe(500);
    expect(agentsCommitted()).toHaveLength(0);
  });

  it('and no orphan model policy is left either', async () => {
    failOn = 'UPDATE agents SET model_policy_id';

    await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'half-made', name: 'Half Made', model_names: ['gpt-4o-mini'] });

    expect(committed.filter((c) => /INSERT INTO model_policies/i.test(c.sql))).toHaveLength(0);
  });

  it('TWIN: a successful create commits the agent — atomicity must not mean losing the work', async () => {
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'half-made', name: 'Half Made', skill_ids: ['skill-1'] });

    expect(res.status).toBe(201);
    expect(agentsCommitted()).toHaveLength(1);
    expect(committed.filter((c) => /INSERT INTO agent_skills/i.test(c.sql))).toHaveLength(1);
  });

  it('TWIN: a failure BEFORE the insert still commits nothing, as it always did', async () => {
    // This one passes either way — it is here so the controls above cannot be
    // satisfied by a version that simply never commits.
    failOn = 'FROM skills WHERE id = ANY';

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'half-made', name: 'Half Made', skill_ids: ['skill-1'] });

    expect(res.status).toBe(500);
    expect(agentsCommitted()).toHaveLength(0);
  });
});

describe('POST /agents/import — the twin path, same shape', () => {
  it('POSITIVE CONTROL: a failure after the insert leaves no agent row', async () => {
    failOn = 'INSERT INTO agent_skills';

    const res = await request(app)
      .post('/agents/import')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'half-made', name: 'Half Made', skill_names: ['shell'] });

    expect(res.status).toBe(500);
    expect(agentsCommitted()).toHaveLength(0);
  });
});
