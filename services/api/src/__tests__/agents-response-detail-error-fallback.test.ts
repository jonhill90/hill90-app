/**
 * Three plain response-detail catch blocks in agents.ts used `err.message`
 * raw, with no fallback: POST /:id/stop, POST /:id/reconcile-tools, and the
 * one-shot GET /:id/events route's outer catch.
 *
 * Wrong-record sweep, tier 3 of app#470's re-derived list — the lowest
 * priority tier, since nothing here is persisted or streamed to a client
 * mid-response: a bad value dies with the request as a JSON response body
 * a caller reads once. Fixed anyway for consistency with the established
 * `err instanceof Error ? err.message : String(err)` pattern this file
 * already uses (agents.ts:1279, and the two higher-priority fixes in this
 * same sweep).
 *
 * WHAT THIS TEST PROVES. That each route's response `detail` field is a
 * real string, not "undefined", when the underlying rejection carries no
 * `.message`.
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

const mockExecInContainer = jest.fn();
const mockReconcileToolInstalls = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args),
}));
jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn().mockResolvedValue(undefined),
  reconcileToolInstalls: (...args: unknown[]) => mockReconcileToolInstalls(...args),
}));
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);

beforeEach(() => {
  mockQuery.mockReset();
  mockExecInContainer.mockReset();
  mockReconcileToolInstalls.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('POST /agents/:id/stop error detail', () => {
  it('THE ASSERTION THAT MATTERS: a rejection with no .message does not produce detail: undefined', async () => {
    mockQuery.mockRejectedValueOnce({ code: 'ECONNREFUSED' });

    const res = await request(app)
      .post('/agents/uuid-1/stop')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);
    expect(typeof res.body.detail).toBe('string');
    expect(res.body.detail.length).toBeGreaterThan(0);
  });
});

describe('POST /agents/:id/reconcile-tools error detail', () => {
  it('THE ASSERTION THAT MATTERS: a rejection with no .message does not produce detail: undefined', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'running' }] });
    mockReconcileToolInstalls.mockRejectedValueOnce({ code: 'ETOOLFAIL' });

    const res = await request(app)
      .post('/agents/uuid-1/reconcile-tools')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);
    expect(typeof res.body.detail).toBe('string');
    expect(res.body.detail.length).toBeGreaterThan(0);
  });
});

describe('GET /agents/:id/events (one-shot) outer catch error detail', () => {
  it('THE ASSERTION THAT MATTERS: a rejection with no .message does not produce detail: undefined', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'running' }] });
    mockExecInContainer.mockRejectedValueOnce({ code: 'ENOEXEC' });

    const res = await request(app)
      .get('/agents/uuid-1/events')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);
    expect(typeof res.body.detail).toBe('string');
    expect(res.body.detail.length).toBeGreaterThan(0);
  });
});
