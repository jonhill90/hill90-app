/**
 * Every usage total says what is known to be missing from it (#261).
 *
 * THE QUESTION ANSWERED FIRST, because it decided the shape of the fix: does
 * anything downstream reveal a missing row? No. This route aggregates with
 * `COUNT(*)` and `COALESCE(SUM(...), 0)`, so a row that was never written reads
 * as a smaller, entirely plausible total — nobody notices absent rows, they
 * notice wrong totals, and an understated total looks exactly like a quiet
 * period. The same table is the enforcement substrate in `services/ai`
 * (`check_rate_limit` counts rows, `check_token_budget` sums tokens), so a
 * missing row also makes both controls looser, in the direction nobody
 * complains about.
 *
 * So the fix reports rather than retries: `services/ai` records a failed write
 * and converges it into `usage_write_gaps` on the next successful write, and
 * this route hands that back with every figure it produces.
 *
 * WHAT ZERO MEANS HERE, exactly: no failed writes are ON RECORD for the window.
 * It does not mean the total is right — a process that died holding a pending
 * gap never got to record it, and that limit is stated in `usage_gaps.py`
 * rather than papered over.
 *
 * NOT EXERCISED: no write was made to fail against a real database, and no
 * total was compared against a provider bill.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
const adminToken = jwt.sign(
  { sub: 'admin-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
);

/** A perfectly plausible total — the shape an understated one also has. */
const TOTALS = {
  total_requests: '412',
  successful_requests: '410',
  total_input_tokens: '900000',
  total_output_tokens: '120000',
  total_tokens: '1020000',
  total_cost_usd: '18.420000',
};

function respondWith(gapRow: Record<string, unknown>) {
  mockQuery
    .mockResolvedValueOnce({ rows: [TOTALS] })    // the aggregate
    .mockResolvedValueOnce({ rows: [gapRow] });   // usage_write_gaps
}

beforeEach(() => {
  mockQuery.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('a total that is missing rows says so', () => {
  it('POSITIVE CONTROL: a window with recorded gaps is qualified', async () => {
    // The fixture where rows were LOST. A window with no gaps cannot
    // distinguish the versions — the totals are identical either way.
    respondWith({
      known_missing_rows: 37,
      first_missing_at: '2026-08-04T09:00:00.000Z',
      last_missing_at: '2026-08-04T09:04:00.000Z',
    });

    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // The total is still served — it is the best figure available.
    expect(res.body.total_requests).toBe('412');
    // And it no longer arrives as though it were whole.
    expect(res.body.completeness.known_missing_rows).toBe(37);
    expect(res.body.completeness.first_missing_at).toBe('2026-08-04T09:00:00.000Z');
    expect(res.body.completeness.last_missing_at).toBe('2026-08-04T09:04:00.000Z');
  });

  it('TWIN: a window with no recorded gaps reports zero, not silence', async () => {
    // Zero is an answer — "no failed writes are on record" — and it has to be
    // present, or a consumer cannot tell a clean window from an old build that
    // never reported at all.
    respondWith({ known_missing_rows: 0, first_missing_at: null, last_missing_at: null });

    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.total_requests).toBe('412');
    expect(res.body.completeness).toEqual({
      known_missing_rows: 0,
      first_missing_at: null,
      last_missing_at: null,
    });
  });

  it('grouped queries are qualified too, not only the summary', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1', ...TOTALS }] })
      .mockResolvedValueOnce({ rows: [{ known_missing_rows: 5, first_missing_at: null, last_missing_at: null }] });

    const res = await request(app)
      .get('/usage?group_by=agent')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.group_by).toBe('agent');
    expect(res.body.completeness.known_missing_rows).toBe(5);
  });

  it('a completeness query that FAILS does not take the totals down with it', async () => {
    // Three states, not two. Before migration 063 lands the table does not
    // exist, and the figures are still the best available — but the answer must
    // not then be reported as a clean window, which is the mistake this whole
    // series has been about.
    mockQuery
      .mockResolvedValueOnce({ rows: [TOTALS] })
      .mockRejectedValueOnce(new Error('relation "usage_write_gaps" does not exist'));

    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.total_requests).toBe('412');
    expect(res.body.completeness.unavailable).toBe(true);
    expect(res.body.completeness.known_missing_rows).toBeNull();
  });

  it('the gap query is bounded to the window being summed', async () => {
    respondWith({ known_missing_rows: 0, first_missing_at: null, last_missing_at: null });

    await request(app)
      .get('/usage?from=2026-08-01&to=2026-08-02')
      .set('Authorization', `Bearer ${adminToken}`);

    const gapCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('usage_write_gaps'));
    expect(gapCall).toBeDefined();
    // A gap outside the window must not qualify a total it did not affect.
    expect(String(gapCall![0])).toContain('last_failed_at >=');
    expect(gapCall![1]).toEqual(['2026-08-01T00:00:00+00:00', '2026-08-02T00:00:00+00:00']);
  });
});
