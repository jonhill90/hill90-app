/**
 * DELETE /agents/:id never revokes AKM or model-router tokens before
 * deleting the row (#340) — confirmed against the tree while building #245,
 * still true when this file was written.
 *
 * WHY #341's PATTERN ONLY PARTLY TRANSFERS: on `/stop` a failed revoke keeps
 * its `akm_jti`/`model_router_jti` columns instead of nulling them, because
 * the row survives the request and a retry or operator can still name the
 * token afterward. Here the row is deleted regardless of revoke outcome —
 * `DELETE FROM agents` removes whatever the columns held either way. There
 * is no column left to preserve a failed revoke's JTI in once this request
 * returns, so "preserve on failure" has no DELETE-path equivalent; what DOES
 * transfer is attempting the revoke at all, and telling the audit trail the
 * truth about whether it succeeded (`token_revoked` vs `token_revoke_failed`,
 * naming jti/exp/agent) — the audit stream doesn't depend on the row.
 *
 * ORDERING: this route already treated container stop, volume purge, avatar
 * removal and config-file removal as best-effort — each already wrapped in
 * its own try/catch that logs and continues to the DELETE regardless. The
 * two revoke calls added here follow that same, already-established
 * convention: best-effort, never block the delete. That is NOT this fix
 * answering #269 — #269 is specifically about whether a failed revoke should
 * block `/stop`, a route that did NOT already have a non-blocking convention
 * before #245/#269 raised the question. This route did, for every other
 * cleanup step, before this fix touched it. Whether a revoke-failed token
 * from this path is later counted or swept stays #269's, same as `/stop`.
 */
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));
jest.mock('../services/docker', () => ({
  stopAndRemoveContainer: jest.fn().mockResolvedValue(undefined),
  removeAgentVolumes: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/agent-files', () => ({
  removeAgentFiles: jest.fn(),
  writeAgentFiles: jest.fn(),
}));
jest.mock('../services/s3', () => ({
  getS3Client: jest.fn(() => ({})),
  deleteAvatar: jest.fn().mockResolvedValue(undefined),
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

const AKM_JTI = 'akm-jti-del-1';
const AKM_EXP = 1893456000;
const MR_JTI = 'mr-jti-del-2';
const MR_EXP = 1893456999;

function agentRow(over: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1', agent_id: 'scout', status: 'stopped', created_by: 'owner-1',
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

const del = () =>
  request(app)
    .delete('/agents/uuid-1')
    .set('Authorization', `Bearer ${adminToken}`);

describe('DELETE /agents/:id revokes both tokens before deleting the row (#340)', () => {
  it('calls revokeAgentAkmToken and revokeAgentModelRouterToken with the jti/exp on the row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] }); // SELECT agent

    const res = await del();

    expect(res.status).toBe(200);
    expect(mockRevokeAkm).toHaveBeenCalledWith('scout', AKM_JTI, AKM_EXP);
    expect(mockRevokeModelRouter).toHaveBeenCalledWith('scout', MR_JTI, MR_EXP);
  });

  it('emits token_revoked for both when both succeed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });

    await del();

    const events = mockAuditLog.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e === 'token_revoked')).toHaveLength(2);
    expect(events).not.toContain('token_revoke_failed');
  });

  it('still deletes the row and returns 200 when a revoke fails', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    mockRevokeAkm.mockRejectedValue(new Error('AKM unreachable'));

    const res = await del();

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    // DELETE FROM agents still ran.
    const deleteCall = mockQuery.mock.calls.find((c) => /DELETE FROM agents/i.test(String(c[0])));
    expect(deleteCall).toBeDefined();
  });

  it('emits token_revoke_failed — not token_revoked — naming jti/exp/agent when AKM revoke throws', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    mockRevokeAkm.mockRejectedValue(new Error('AKM unreachable'));

    await del();

    const failed = mockAuditLog.mock.calls.find((c) => c[0] === 'token_revoke_failed' && c[4]?.jti === AKM_JTI);
    expect(failed).toBeDefined();
    expect(failed![1]).toBe('scout');
    expect(failed![4]).toMatchObject({ jti: AKM_JTI, exp: AKM_EXP });

    const wronglyRevoked = mockAuditLog.mock.calls.find(
      (c) => c[0] === 'token_revoked' && c[4]?.jti === AKM_JTI,
    );
    expect(wronglyRevoked).toBeUndefined();
  });

  it('emits token_revoke_failed for model-router when it throws, independent of AKM outcome', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow()] });
    mockRevokeModelRouter.mockRejectedValue(new Error('model-router unreachable'));

    await del();

    const failed = mockAuditLog.mock.calls.find((c) => c[0] === 'token_revoke_failed' && c[4]?.jti === MR_JTI);
    expect(failed).toBeDefined();
    expect(failed![4]).toMatchObject({ jti: MR_JTI, exp: MR_EXP });

    const akmEvent = mockAuditLog.mock.calls.find((c) => c[4]?.jti === AKM_JTI);
    expect(akmEvent?.[0]).toBe('token_revoked');
  });

  it('does not call either revoke function when the agent has no jti on the row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [agentRow({ akm_jti: null, model_router_jti: null })] });

    await del();

    expect(mockRevokeAkm).not.toHaveBeenCalled();
    expect(mockRevokeModelRouter).not.toHaveBeenCalled();
  });

  it('revokes are attempted before the container is stopped and the row is deleted', async () => {
    const { stopAndRemoveContainer } = require('../services/docker');
    const order: string[] = [];
    mockRevokeAkm.mockImplementation(async () => { order.push('revoke-akm'); });
    mockRevokeModelRouter.mockImplementation(async () => { order.push('revoke-mr'); });
    (stopAndRemoveContainer as jest.Mock).mockImplementation(async () => { order.push('remove-container'); });
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT \* FROM agents/i.test(sql)) return { rows: [agentRow({ status: 'running' })] };
      if (/DELETE FROM agents/i.test(sql)) { order.push('delete-row'); return { rows: [] }; }
      return { rows: [] };
    });

    await del();

    expect(order).toEqual(['revoke-akm', 'revoke-mr', 'remove-container', 'delete-row']);
  });
});
