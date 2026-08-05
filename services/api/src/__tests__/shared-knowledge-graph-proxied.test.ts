/**
 * The graph comes from the service that owns the tables (#300).
 *
 * THE DEFECT. This route ran four statements through `getPool()` against
 * `shared_collections`, `shared_sources` and `knowledge_entries` — tables that
 * live in the knowledge service's database. Measured: five such tables in
 * `hill90_akm`, zero in `hill90_api`. So it answered 500 on every call.
 *
 * AND UNLIKE #286's PAIR, SOMEONE SAW IT. `SharedKnowledgeClient.tsx:27`
 * fetches this on mount and `:158` renders "Failed to load graph" when the
 * response is not ok. A visibly broken feature, not a silent one — which is why
 * it was the more urgent of the two.
 *
 * WHAT PROVES THE FIX is not this file. A mocked test cannot tell a working
 * query from a broken one — that is exactly how #286 survived 97 test files.
 * The proof is `scripts/checks/check_sql_identifiers.sh` passing with
 * `routes/shared-knowledge.ts` NO LONGER EXCLUDED, and `PREPARE` of the moved
 * statements against `hill90_akm`. This file pins the one thing left: that the
 * route asks the other service instead of its own database.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));

const mockGetGraph = jest.fn();
jest.mock('../services/shared-knowledge-proxy', () => ({
  getGraph: (...args: unknown[]) => mockGetGraph(...args),
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
  { sub: 'u1', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
);

const GRAPH = { nodes: [], edges: [], total: { collections: 0 }, shown: { collections: 0 }, truncated: false };

beforeEach(() => {
  mockQuery.mockReset();
  mockGetGraph.mockReset().mockResolvedValue({ status: 200, data: GRAPH });
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => { delete process.env.DATABASE_URL });

describe('GET /shared-knowledge/graph', () => {
  it('POSITIVE CONTROL: it queries the knowledge service, never its own database', async () => {
    const res = await request(app)
      .get('/shared-knowledge/graph')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(mockGetGraph).toHaveBeenCalledTimes(1);
    // The whole defect in one assertion: this route must not touch the api's pool.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('passes the caller\'s limit through rather than inventing its own', async () => {
    await request(app)
      .get('/shared-knowledge/graph?limit=7')
      .set('Authorization', `Bearer ${userToken}`);

    // Cross-service sibling-drift sweep (app#445 family): this route never
    // called scopeToOwner, unlike its /collections sibling — a 'user'-role
    // caller (sub 'u1', not admin) is now scoped to their own sub.
    expect(mockGetGraph).toHaveBeenCalledWith(7, 'u1');
  });

  it('does not scope an admin caller', async () => {
    const adminToken = jwt.sign(
      { sub: 'admin-1', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
    );

    await request(app)
      .get('/shared-knowledge/graph')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(mockGetGraph).toHaveBeenCalledWith(expect.any(Number), undefined);
  });

  it('forwards the upstream status instead of flattening it', async () => {
    mockGetGraph.mockResolvedValue({ status: 503, data: { error: 'Knowledge service not configured' } });

    const res = await request(app)
      .get('/shared-knowledge/graph')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/);
  });

  it('an unreachable knowledge service is a 502, not a 500 that blames this service', async () => {
    mockGetGraph.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app)
      .get('/shared-knowledge/graph')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(502);
  });
});
