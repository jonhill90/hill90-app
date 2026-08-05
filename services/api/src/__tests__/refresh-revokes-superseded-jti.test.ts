/**
 * A refresh must not leave the token it replaced alive and unnameable (#256).
 *
 * IS THIS #245's DECISION WEARING A DIFFERENT NUMBER? No, and the code says so.
 *
 * #269 has to choose an ORDER on the STOP path: revoke before removing the
 * container, or after — a real trade, because a failed revoke that blocks a
 * stop leaves a container running. **The refresh path has no such freedom.**
 * Revoking the old JTI before the swap would mean a failed mint or UPDATE
 * leaves the agent holding a revoked token with NO replacement — strictly worse
 * than today and it breaks a working agent. So the revoke must follow the
 * UPDATE. The order is forced by the semantics rather than chosen, and fixing
 * this presumes nothing about the stop path.
 *
 * The one question it shares is what a FAILED revoke should do, and here it can
 * be answered in the direction nobody disputes: never fail the refresh — the
 * new token is already stored and returned, so a 500 now would tell the agent
 * its refresh failed while the database says it succeeded (#212's shape). What
 * remains is #245's actual complaint, which is not that the revoke is
 * best-effort but that afterwards nothing can NAME the token left behind.
 *
 * So: revoke the superseded JTI, never block on it, and when it fails, say
 * which token is loose. Whether an orphan should also be counted or retried is
 * #269's to decide and is deliberately not decided here.
 */
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));

const mockRevoke = jest.fn();
jest.mock('../services/model-router-revoke', () => ({
  revokeAgentModelRouterToken: (...a: unknown[]) => mockRevoke(...a),
}));

const mockGenerate = jest.fn();
jest.mock('../services/model-router-token', () => ({
  isModelRouterConfigured: () => true,
  // #459: the handler now VERIFIES this token instead of base64-decoding it.
  // Mocked here for the same reason generateAgentModelRouterToken already is —
  // this suite is about revoking a superseded JTI, not about token
  // authenticity, and it hands the route hand-built fixtures. The real
  // verifier is exercised in model-router-refresh-token-verification.test.ts.
  verifyModelRouterToken: (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()),
  generateAgentModelRouterToken: (...a: unknown[]) => mockGenerate(...a),
}));

import request from 'supertest';
import { createApp } from '../app';

const app = createApp({ issuer: 'https://auth.hill90.com/realms/hill90', getSigningKey: async () => 'k' });

const OLD_JTI = 'jti-old-1111';
const OLD_EXP = 1893456000;

function bearer(sub: string) {
  const payload = Buffer.from(JSON.stringify({ sub, exp: OLD_EXP })).toString('base64url');
  return `header.${payload}.sig`;
}

function agentRow(over: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1', agent_id: 'scout',
    model_router_jti: OLD_JTI, model_router_exp: OLD_EXP,
    created_by: 'owner-1', ...over,
  };
}

let warn: jest.SpyInstance;
let log: jest.SpyInstance;

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  mockRevoke.mockReset().mockResolvedValue(undefined);
  mockGenerate.mockReset().mockResolvedValue({
    token: 'new.jwt', jti: 'jti-new-2222', refreshSecret: 'new-secret', expiresAt: OLD_EXP + 3600,
  });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
  delete process.env.DATABASE_URL;
});

const refresh = () =>
  request(app)
    .post('/internal/model-router/refresh-token')
    .set('Authorization', `Bearer ${bearer('scout')}`)
    .send({ refresh_secret: 'correct' });

describe('the superseded token is revoked', () => {
  it('POSITIVE CONTROL: the OLD jti is revoked, with its own expiry', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] }).mockResolvedValue({ rows: [] });

    const res = await refresh();

    expect(res.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledTimes(1);
    const [slug, jti, exp] = mockRevoke.mock.calls[0];
    expect(slug).toBe('scout');
    expect(jti).toBe(OLD_JTI);        // the one being replaced, not the new one
    expect(exp).toBe(OLD_EXP);        // its own expiry, read before the UPDATE overwrote it
  });

  it('the revoke happens AFTER the swap, never before', async () => {
    // Revoking first would mean a failed mint or UPDATE leaves the agent with a
    // revoked token and no replacement — worse than the defect.
    const order: string[] = [];
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (/UPDATE agents/i.test(String(sql))) order.push('update');
      return /SELECT/i.test(String(sql)) ? { rows: [agentRow()] } : { rows: [] };
    });
    mockRevoke.mockImplementation(async () => { order.push('revoke') });

    await refresh();

    expect(order).toEqual(['update', 'revoke']);
  });

  it('TWIN: an agent with no previous jti has nothing to revoke', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow({ model_router_jti: null })] }).mockResolvedValue({ rows: [] });

    const res = await refresh();

    expect(res.status).toBe(200);
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

describe('a failed revoke does not break the refresh, and does not vanish', () => {
  it('POSITIVE CONTROL: the refresh still succeeds', async () => {
    // The new token is already stored and is about to be returned. A 500 here
    // would tell the agent its refresh failed while the database says it
    // worked — #212's shape, in the other direction.
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] }).mockResolvedValue({ rows: [] });
    mockRevoke.mockRejectedValue(new Error('model-router unreachable'));

    const res = await refresh();

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('new.jwt');
  });

  it('and the orphaned token is NAMED — #245\'s actual complaint', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] }).mockResolvedValue({ rows: [] });
    mockRevoke.mockRejectedValue(new Error('model-router unreachable'));

    await refresh();

    const said = [...warn.mock.calls, ...log.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
    expect(said).toContain(OLD_JTI);              // which token is loose
    expect(said).toContain(String(OLD_EXP));      // and until when
    expect(said).toMatch(/scout/);                // and whose
  });
});
