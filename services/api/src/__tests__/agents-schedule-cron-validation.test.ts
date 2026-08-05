/**
 * PUT /agents/:id/schedule (app#487). Before this fix, this route's own
 * hand-rolled `isValidCron` was a regex (`[0-9,\-\/]+`) that accepted any
 * digit sequence in each field — including out-of-range values like `60`
 * in the minute field, which cron-parser (used to compute
 * workflows.next_run_at elsewhere in this service) rejects. It also
 * required exactly 5 fields, unlike routes/workflows.ts's own check, which
 * always allowed 6 (with seconds). Both routes now share
 * helpers/cron.ts's isValidCronExpression, closing that drift.
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
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
  );
}

const userToken = makeToken('user-1', ['user']);

beforeEach(() => {
  mockQuery.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('PUT /agents/:id/schedule cron validation', () => {
  it('POSITIVE CONTROL: a valid 5-field cron is accepted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] }) // ownership check
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'a', schedule_cron: '0 9 * * *', schedule_enabled: true }] });

    const res = await request(app)
      .put('/agents/agent-1/schedule')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ schedule_cron: '0 9 * * *', schedule_enabled: true });

    expect(res.status).toBe(200);
  });

  it('THE DEFECT THIS CLOSES: rejects a cron with the right field count but out-of-range values', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] }); // ownership check

    const res = await request(app)
      .put('/agents/agent-1/schedule')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ schedule_cron: '60 * * * *', schedule_enabled: true });

    // The old regex `[0-9,\-\/]+` matched "60" — this asserts the shared,
    // range-aware validator rejects it instead.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cron');
  });

  it('now accepts a 6-field (with-seconds) cron — a widening from the old 5-field-only regex', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'a', schedule_cron: '0 */5 * * * *', schedule_enabled: true }] });

    const res = await request(app)
      .put('/agents/agent-1/schedule')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ schedule_cron: '0 */5 * * * *', schedule_enabled: true });

    expect(res.status).toBe(200);
  });
});
