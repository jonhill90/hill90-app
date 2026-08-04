/**
 * A search endpoint must report how many MATCHED, not how many fit in the page.
 *
 * Two instances of one shape, found by the #197 sweep and fixed together:
 *
 *   chat.ts    `res.json({ ..., total: rows.length })` under `LIMIT 50`. Nothing
 *              rendered it, which is precisely why it was fixed rather than left:
 *              an identical-shape defect left alone because it is small is how it
 *              becomes someone's dashboard figure later. That happened once
 *              already — #197 was #180's shape reaching a user.
 *
 *   knowledge.ts  the merge path summed nothing and reported `limited.length`
 *              after slicing to 20. Each upstream response is ALSO capped at 20,
 *              so summing page lengths would have produced a figure that grows
 *              with the number of agents and has nothing to do with matches.
 *
 * EVERY FIXTURE HERE HAS MORE MATCHES THAN THE CAP, and that is the whole point.
 * With fewer matches than the cap, page length and match count are equal, so the
 * broken and fixed versions return an identical response and any such test passes
 * on the defect.
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

const mockSearchEntries = jest.fn();
jest.mock('../services/akm-proxy', () => ({
  searchEntries: (...args: unknown[]) => mockSearchEntries(...args),
  listEntries: jest.fn(),
  getEntry: jest.fn(),
  createEntry: jest.fn(),
  updateEntry: jest.fn(),
  deleteEntry: jest.fn(),
  appendJournal: jest.fn(),
}));

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const userToken = jwt.sign(
  { sub: 'user-1', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' },
);

beforeEach(() => {
  mockQuery.mockReset();
  mockSearchEntries.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('GET /chat/threads/:id/search', () => {
  /** 50 rows come back (the LIMIT), 312 matched. Deliberately unequal. */
  function wire(returned: number, matched: number) {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM chat_participants/.test(sql)) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      if (/COUNT\(\*\)/.test(sql)) return Promise.resolve({ rows: [{ total: String(matched) }] });
      return Promise.resolve({
        rows: Array.from({ length: returned }, (_, i) => ({ id: `m${i}`, content: 'deploy' })),
      });
    });
  }

  it('POSITIVE CONTROL: total is the match count, not the page length', async () => {
    wire(50, 312);

    const res = await request(app)
      .get('/chat/threads/t1/search?q=deploy')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(50);
    // The defect returned 50 here. A fixture with <50 matches cannot tell them apart.
    expect(res.body.total).toBe(312);
    expect(res.body.total).not.toBe(res.body.results.length);
    expect(res.body.truncated).toBe(true);
  });

  it('counts over the same predicate as the page', async () => {
    wire(50, 312);
    await request(app).get('/chat/threads/t1/search?q=deploy').set('Authorization', `Bearer ${userToken}`);

    const countSql = mockQuery.mock.calls.map((c) => String(c[0])).find((s) => /COUNT\(\*\)/.test(s))!;
    // A count over a different scope would describe a different set and still
    // look like a plausible number.
    expect(countSql).toMatch(/thread_id = \$1/);
    expect(countSql).toMatch(/to_tsvector\('english', content\) @@ plainto_tsquery/);
    expect(countSql).not.toMatch(/\bLIMIT\b/);
  });

  it('is not "truncated" when everything fit', async () => {
    wire(4, 4);
    const res = await request(app)
      .get('/chat/threads/t1/search?q=deploy')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.body.total).toBe(4);
    expect(res.body.truncated).toBe(false);
  });
});

describe('GET /knowledge/search — the merge path', () => {
  it('POSITIVE CONTROL: sums each agent\'s REAL total, not their page lengths', async () => {
    // Two agents, each returning a capped page of 20 but each matching far more.
    // Summing page lengths gives 40 — a figure that tracks agent count, not data.
    mockQuery.mockResolvedValue({
      rows: [{ agent_id: 'a1' }, { agent_id: 'a2' }],
    });
    mockSearchEntries.mockImplementation((_q: string, aid: string) =>
      Promise.resolve({
        status: 200,
        data: {
          results: Array.from({ length: 20 }, (_, i) => ({ id: `${aid}-${i}`, score: 1 - i / 100 })),
          total_matches: aid === 'a1' ? 90 : 47,
        },
      }),
    );

    const res = await request(app)
      .get('/knowledge/search?q=deploy')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(20); // page still bounded
    expect(res.body.count).toBe(20);
    expect(res.body.total_matches).toBe(137); // 90 + 47
    expect(res.body.total_matches).not.toBe(40); // the sum-of-pages answer
    expect(res.body.truncated).toBe(true);
  });

  it('falls back to page length for an upstream that sends no total', async () => {
    mockQuery.mockResolvedValue({ rows: [{ agent_id: 'a1' }] });
    mockSearchEntries.mockResolvedValue({
      status: 200,
      data: { results: [{ id: 'x', score: 1 }] }, // no total_matches
    });

    const res = await request(app)
      .get('/knowledge/search?q=deploy')
      .set('Authorization', `Bearer ${userToken}`);

    // Undercounting is the safe direction: it understates rather than inventing
    // a total nobody computed.
    expect(res.body.total_matches).toBe(1);
    expect(res.body.truncated).toBe(false);
  });
});
