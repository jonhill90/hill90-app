/**
 * GET /chat/stats — the dashboard's message count, computed rather than summed.
 *
 * THE DEFECT IT REPLACES (issue #197). The dashboard summed `t.message_count`
 * where `t.last_message_at >= todayUTC`, and GET /chat/threads returns NEITHER
 * field. The loop body never ran, so `messagesToday` was structurally 0 — a
 * figure that renders as "nothing happened today" whatever the truth is.
 *
 * WHY NOT JUST ADD THE COLUMNS. Summing them would have made the total an
 * aggregate over a PAGE — /chat/threads is bounded at DEFAULT_PAGE = 500 — which
 * is the defect #180, #184 and #188 were each about, and would have been the
 * fourth instance.
 *
 * THE POSITIVE CONTROL IS THE POINT OF THIS FILE. A figure stuck at 0 passes any
 * test whose fixture has no messages, and passes any test that merely asserts the
 * field is present or is a number. So the load-bearing assertion is that the count
 * is NON-ZERO with messages present, and equals the number the query returned.
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
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const tokenFor = (roles: string[], sub = 'user-1') =>
  jwt.sign({ sub, resource_access: { 'hill90-ui': { roles } } }, privateKey, {
    algorithm: 'RS256',
    issuer: TEST_ISSUER,
    expiresIn: '1h',
  });

const userToken = tokenFor(['user']);
const adminToken = tokenFor(['user', 'admin'], 'admin-1');

/** The SQL the route ran, so scope can be asserted rather than assumed. */
const lastSql = () => String(mockQuery.mock.calls[0][0]);
const lastParams = () => mockQuery.mock.calls[0][1];

beforeEach(() => {
  mockQuery.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('GET /chat/stats', () => {
  it('POSITIVE CONTROL: reports a NON-ZERO count when messages exist today', async () => {
    mockQuery.mockResolvedValue({ rows: [{ messages_today: '17' }] });

    const res = await request(app).get('/chat/stats').set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    // Both halves matter. `not.toBe(0)` is what the old always-0 figure fails;
    // `toBe(17)` is what a hardcoded 1 would fail. A test asserting only that the
    // field exists passes on the defect this replaces.
    expect(res.body.messages_today).not.toBe(0);
    expect(res.body.messages_today).toBe(17);
    expect(typeof res.body.messages_today).toBe('number');
  });

  it('returns 0 honestly when there genuinely are none', async () => {
    mockQuery.mockResolvedValue({ rows: [{ messages_today: '0' }] });

    const res = await request(app).get('/chat/stats').set('Authorization', `Bearer ${userToken}`);

    // The point is not that 0 never appears — it is that 0 means zero.
    expect(res.body.messages_today).toBe(0);
  });

  it('counts with COUNT(*), not by summing a page', async () => {
    mockQuery.mockResolvedValue({ rows: [{ messages_today: '3' }] });
    await request(app).get('/chat/stats').set('Authorization', `Bearer ${userToken}`);

    expect(lastSql()).toMatch(/COUNT\(\*\)/i);
    // A LIMIT here would reintroduce the page-total defect by another route.
    expect(lastSql()).not.toMatch(/\bLIMIT\b/i);
  });

  it('scopes a user to threads they still participate in', async () => {
    mockQuery.mockResolvedValue({ rows: [{ messages_today: '2' }] });
    await request(app).get('/chat/stats').set('Authorization', `Bearer ${userToken}`);

    const sql = lastSql();
    expect(sql).toMatch(/JOIN chat_participants/);
    expect(sql).toMatch(/left_at IS NULL/);
    // Counting over a wider scope would report other people's activity as theirs.
    expect(lastParams()).toEqual(['user-1']);
  });

  it('counts everything for an admin, matching GET /threads', async () => {
    mockQuery.mockResolvedValue({ rows: [{ messages_today: '99' }] });
    const res = await request(app).get('/chat/stats').set('Authorization', `Bearer ${adminToken}`);

    expect(lastSql()).not.toMatch(/JOIN chat_participants/);
    expect(lastParams()).toEqual([]);
    expect(res.body.messages_today).toBe(99);
  });

  it('bounds "today" at UTC midnight, and does not take the boundary from the caller', async () => {
    mockQuery.mockResolvedValue({ rows: [{ messages_today: '5' }] });
    await request(app)
      .get('/chat/stats?since=1970-01-01')
      .set('Authorization', `Bearer ${userToken}`);

    const sql = lastSql();
    expect(sql).toMatch(/date_trunc\('day', now\(\) AT TIME ZONE 'UTC'\)/);
    // A caller-supplied range on a count is a caller that can ask "how many have
    // there ever been" and be answered.
    expect(JSON.stringify(lastParams())).not.toMatch(/1970/);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/chat/stats');
    expect([401, 403]).toContain(res.status);
  });

  it('reports a query failure as 500 rather than as zero messages', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockQuery.mockRejectedValue(new Error('connection refused'));
      const res = await request(app).get('/chat/stats').set('Authorization', `Bearer ${userToken}`);

      // Answering 0 on failure would recreate the exact defect being fixed: a
      // confident number that means "nothing happened" when it means "I failed".
      expect(res.status).toBe(500);
      expect(res.body.messages_today).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
