/**
 * Nothing inside the create transaction may run on the pool (#212, #283).
 *
 * `withTransaction` guarantees exactly one thing: the statements run on the client
 * it hands you. A helper that reaches for `getPool()` instead opens a SECOND
 * connection, and the two failure modes are not the same:
 *
 *   a WRITE that escapes  — commits outside the caller's transaction, so a rollback
 *                           silently stops covering it (that is #212's defect);
 *   a READ that escapes   — runs in a different session, so it cannot see the
 *                           caller's uncommitted rows and returns an empty result
 *                           for something the transaction just wrote.
 *
 * `resolveAgentModels` was the second kind. It was NOT a live defect when found:
 * both of its in-transaction callers sit in the branch where `model_policy_id`
 * came from the request, so the row predates BEGIN and a pool read finds it. It was
 * one branch away from being real — the branch directly above each call site creates
 * a policy inside the same transaction — and it would have failed by returning `[]`,
 * which reads as "this agent has no models" rather than as an error.
 *
 * WHY THIS TEST ASSERTS THE INVARIANT RATHER THAN THE SYMPTOM. There is no route
 * today that reads back a policy it created in the same transaction, so a test of
 * the symptom would have to invent the future call path and would pin an imaginary
 * route. Instead this pins the property that makes any such future path safe: while
 * a transaction is open, every statement goes to the transaction's connection. It
 * fails against the code as it was — the escaping read is visible as a pool query
 * between BEGIN and COMMIT — and it will fail again for the next helper that does
 * the same thing, which is the point.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

type Ran = { sql: string; on: 'pool' | 'tx' };
const ran: Ran[] = [];
let txOpen = false;

function answer(sql: string): { rows: any[] } {
  if (/INSERT INTO agents/i.test(sql)) {
    return { rows: [{ id: 'uuid-1', agent_id: 'from-policy', name: 'From Policy', status: 'stopped', model_policy_id: 'policy-1', created_by: 'regular-user' }] };
  }
  // Ownership/eligibility validation, all BEFORE the transaction opens.
  if (/SELECT id, created_by FROM model_policies/i.test(sql)) return { rows: [{ id: 'policy-1', created_by: 'regular-user' }] };
  if (/FROM user_models WHERE name/i.test(sql)) return { rows: [{ id: 'model-1' }] };
  // The read under test.
  if (/SELECT allowed_models FROM model_policies/i.test(sql)) return { rows: [{ allowed_models: ['model-a'] }] };
  if (/FROM model_policies/i.test(sql)) return { rows: [{ id: 'policy-1', allowed_models: ['model-a'], created_by: 'regular-user' }] };
  if (/FROM skills/i.test(sql)) return { rows: [] };
  if (/FROM agent_skills/i.test(sql)) return { rows: [] };
  return { rows: [] };
}

const record = (on: 'pool' | 'tx') => async (sql: string, _params?: unknown[]) => {
  // BEGIN/COMMIT are issued by the real withTransaction, mirrored below.
  ran.push({ sql, on });
  return answer(sql);
};

jest.mock('../db/pool', () => ({
  getPool: () => ({ query: record('pool'), connect: async () => ({ query: record('tx'), release: () => {} }) }),
  // Mirrors the real helper's shape — it is pinned in with-transaction.test.ts —
  // but marks the window so this suite can tell "inside" from "outside".
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
    txOpen = true;
    ran.push({ sql: 'BEGIN', on: 'tx' });
    try {
      const out = await fn({ query: record('tx') });
      ran.push({ sql: 'COMMIT', on: 'tx' });
      return out;
    } finally {
      txOpen = false;
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

const { createApp } = require('../app');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_ISSUER = 'https://test-issuer.example.com/realms/platform';

function userToken() {
  return jwt.sign(
    { sub: 'regular-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h', keyid: 'test' }
  );
}

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

beforeEach(() => {
  ran.length = 0;
  txOpen = false;
  // The routes refuse with 503 when this is unset, which would empty the
  // "escapes" list for a reason that has nothing to do with the property.
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});
afterEach(() => { delete process.env.DATABASE_URL; });

describe('the create transaction owns every statement inside it', () => {
  it('runs no query on the pool between BEGIN and COMMIT', async () => {
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ agent_id: 'from-policy', name: 'From Policy', model_policy_id: 'policy-1' });

    expect(res.status).toBeLessThan(500);

    const begin = ran.findIndex((r) => /^BEGIN/.test(r.sql));
    const commit = ran.findIndex((r) => /^COMMIT/.test(r.sql));
    // Positive control on the fixture itself: if the route never opened a
    // transaction, an empty "escapes" list below would mean nothing at all.
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);

    const escapes = ran.slice(begin + 1, commit).filter((r) => r.on === 'pool');
    expect(escapes.map((e) => e.sql.replace(/\s+/g, ' ').trim().slice(0, 60))).toEqual([]);
  });

  it('reads the response model list on the transaction, not a second connection', async () => {
    await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ agent_id: 'from-policy', name: 'From Policy', model_policy_id: 'policy-1' });

    const begin = ran.findIndex((r) => /^BEGIN/.test(r.sql));
    const commit = ran.findIndex((r) => /^COMMIT/.test(r.sql));
    const readsInTx = ran
      .slice(begin + 1, commit)
      .filter((r) => /SELECT allowed_models FROM model_policies/i.test(r.sql));

    // The statement must happen, and it must happen on the transaction. Asserting
    // only "not on the pool" would pass if it stopped happening at all.
    expect(readsInTx.length).toBe(1);
    expect(readsInTx[0].on).toBe('tx');
  });
});
