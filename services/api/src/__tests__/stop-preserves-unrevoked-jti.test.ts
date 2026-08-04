/**
 * A failed model-router (or AKM) revocation must not leave the token it
 * failed to revoke unnameable (#245).
 *
 * IS THIS #269's ORDERING DECISION WEARING A DIFFERENT NUMBER? No — same
 * distinction #316 already drew for the refresh path, closing #256:
 * whichever order Jon eventually picks for revoke-vs-stopAndRemoveContainer,
 * a failed revoke still leaves a live credential, and what makes that
 * recoverable is not WHEN the revoke ran but whether the row still names the
 * token afterward. Nulling the only column that holds the JTI is a
 * correctness defect regardless of ordering — it makes the token
 * unrevocable FOREVER, not merely revocable-late. So this does not touch
 * the revoke-then-stopAndRemoveContainer sequence at all; it only changes
 * what the final UPDATE nulls and what the audit trail claims happened.
 *
 * AKM and model-router are fixed TOGETHER, deliberately. They are the same
 * shaped block twice in routes/agents.ts, and fixing one while leaving its
 * parallel is exactly the drift that survived four months in #114 and cost
 * #308.
 *
 * WHAT STAYS #269's, on purpose, and is asserted here rather than only
 * argued in prose: whether an orphaned (revoke-failed) token is ever
 * counted or swept. Nothing here retries a failed revoke or records it
 * anywhere but the audit stream.
 */
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));
jest.mock('../services/notifications', () => ({ notify: jest.fn() }));
jest.mock('../services/webhook-dispatch', () => ({ dispatchWebhooks: jest.fn() }));
jest.mock('../services/docker', () => ({
  stopAndRemoveContainer: jest.fn().mockResolvedValue(undefined),
}));

const mockRevokeAkm = jest.fn();
jest.mock('../services/akm-revoke', () => ({
  revokeAgentAkmToken: (...a: unknown[]) => mockRevokeAkm(...a),
}));
jest.mock('../services/akm-token', () => ({
  isAkmConfigured: () => true,
  generateAgentAkmToken: jest.fn(),
  getAkmEnvVars: jest.fn(() => []),
}));

const mockRevokeModelRouter = jest.fn();
jest.mock('../services/model-router-revoke', () => ({
  revokeAgentModelRouterToken: (...a: unknown[]) => mockRevokeModelRouter(...a),
}));
jest.mock('../services/model-router-token', () => ({
  isModelRouterConfigured: () => true,
  generateAgentModelRouterToken: jest.fn(),
  getModelRouterEnvVars: jest.fn(() => []),
}));

const mockAuditLog = jest.fn();
jest.mock('../helpers/audit', () => ({ auditLog: (...a: unknown[]) => mockAuditLog(...a) }));

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
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
const adminToken = jwt.sign(
  { sub: 'admin-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
);

const AKM_JTI = 'akm-jti-1111';
const AKM_EXP = 1893456000;
const MR_JTI = 'mr-jti-2222';
const MR_EXP = 1893456999;

function agentRow(over: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1', agent_id: 'scout', status: 'running', created_by: 'owner-1',
    akm_jti: AKM_JTI, akm_exp: AKM_EXP,
    model_router_jti: MR_JTI, model_router_exp: MR_EXP,
    ...over,
  };
}

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  mockRevokeAkm.mockReset().mockResolvedValue(undefined);
  mockRevokeModelRouter.mockReset().mockResolvedValue(undefined);
  mockAuditLog.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.DATABASE_URL;
});

const stop = () =>
  request(app)
    .post('/agents/uuid-1/stop')
    .set('Authorization', `Bearer ${adminToken}`);

/** The final `UPDATE agents SET status = 'stopped'...` write. */
const finalUpdate = () =>
  mockQuery.mock.calls.find((c) => /UPDATE agents SET status = 'stopped'/i.test(String(c[0])));

describe('POSITIVE CONTROL: both revokes succeed — unchanged from before this fix', () => {
  it('nulls both JTIs and emits token_revoked for both', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] }); // SELECT agent

    const res = await stop();

    expect(res.status).toBe(200);
    expect(mockRevokeAkm).toHaveBeenCalledWith('scout', AKM_JTI, AKM_EXP);
    expect(mockRevokeModelRouter).toHaveBeenCalledWith('scout', MR_JTI, MR_EXP);

    const update = finalUpdate();
    expect(update).toBeDefined();
    expect(String(update![0])).toMatch(/akm_jti\s*=\s*NULL/);
    expect(String(update![0])).toMatch(/model_router_jti\s*=\s*NULL/);

    const events = mockAuditLog.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e === 'token_revoked')).toHaveLength(2);
    expect(events).not.toContain('token_revoke_failed');
  });
});

describe('a FAILED AKM revocation preserves the JTI and says so honestly', () => {
  it('does not null akm_jti/akm_exp when the revoke threw', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    mockRevokeAkm.mockRejectedValue(new Error('AKM unreachable'));

    const res = await stop();

    // The agent still stopped — a metadata revoke failing must not fail the stop.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stopped');

    const update = finalUpdate();
    expect(update).toBeDefined();
    expect(String(update![0])).not.toMatch(/akm_jti\s*=\s*NULL/);
    expect(String(update![0])).not.toMatch(/akm_exp\s*=\s*NULL/);
    // The model-router token, unaffected by the AKM failure, is still cleared.
    expect(String(update![0])).toMatch(/model_router_jti\s*=\s*NULL/);
  });

  it('emits token_revoke_failed — not token_revoked — naming the jti, expiry and agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    mockRevokeAkm.mockRejectedValue(new Error('AKM unreachable'));

    await stop();

    const failed = mockAuditLog.mock.calls.find((c) => c[0] === 'token_revoke_failed' && c[4]?.jti === AKM_JTI);
    expect(failed).toBeDefined();
    expect(failed![1]).toBe('scout'); // agent_id
    expect(failed![4]).toMatchObject({ jti: AKM_JTI, exp: AKM_EXP });

    // Never claims success for the token that is still live.
    const wronglyRevoked = mockAuditLog.mock.calls.find(
      (c) => c[0] === 'token_revoked' && c[4]?.jti === AKM_JTI,
    );
    expect(wronglyRevoked).toBeUndefined();
  });
});

describe('a FAILED model-router revocation preserves the JTI and says so honestly', () => {
  it('does not null model_router_jti/exp/refresh_hash when the revoke threw', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    mockRevokeModelRouter.mockRejectedValue(new Error('model-router unreachable'));

    const res = await stop();

    expect(res.status).toBe(200);

    const update = finalUpdate();
    expect(update).toBeDefined();
    expect(String(update![0])).not.toMatch(/model_router_jti\s*=\s*NULL/);
    expect(String(update![0])).not.toMatch(/model_router_exp\s*=\s*NULL/);
    expect(String(update![0])).not.toMatch(/model_router_refresh_hash\s*=\s*NULL/);
    // The AKM token, unaffected, is still cleared.
    expect(String(update![0])).toMatch(/akm_jti\s*=\s*NULL/);
  });

  it('emits token_revoke_failed — not token_revoked — naming the jti, expiry and agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    mockRevokeModelRouter.mockRejectedValue(new Error('model-router unreachable'));

    await stop();

    const failed = mockAuditLog.mock.calls.find((c) => c[0] === 'token_revoke_failed' && c[4]?.jti === MR_JTI);
    expect(failed).toBeDefined();
    expect(failed![1]).toBe('scout');
    expect(failed![4]).toMatchObject({ jti: MR_JTI, exp: MR_EXP });

    const wronglyRevoked = mockAuditLog.mock.calls.find(
      (c) => c[0] === 'token_revoked' && c[4]?.jti === MR_JTI,
    );
    expect(wronglyRevoked).toBeUndefined();
  });
});

describe('BOTH revokes failing at once — the twin block must not be fixed only once', () => {
  it('preserves both JTIs and reports both as token_revoke_failed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    mockRevokeAkm.mockRejectedValue(new Error('AKM unreachable'));
    mockRevokeModelRouter.mockRejectedValue(new Error('model-router unreachable'));

    const res = await stop();

    expect(res.status).toBe(200);

    const update = finalUpdate();
    expect(String(update![0])).not.toMatch(/akm_jti\s*=\s*NULL/);
    expect(String(update![0])).not.toMatch(/model_router_jti\s*=\s*NULL/);

    const events = mockAuditLog.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e === 'token_revoke_failed')).toHaveLength(2);
    expect(events).not.toContain('token_revoked');
  });
});

describe('the ordering is unchanged — revoke still runs before stopAndRemoveContainer', () => {
  it('revokes are attempted before the container is removed, success or failure', async () => {
    const { stopAndRemoveContainer } = require('../services/docker');
    const order: string[] = [];
    mockRevokeAkm.mockImplementation(async () => { order.push('revoke-akm'); throw new Error('x'); });
    mockRevokeModelRouter.mockImplementation(async () => { order.push('revoke-mr'); });
    (stopAndRemoveContainer as jest.Mock).mockImplementation(async () => { order.push('remove-container'); });
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });

    await stop();

    expect(order).toEqual(['revoke-akm', 'revoke-mr', 'remove-container']);
  });
});
