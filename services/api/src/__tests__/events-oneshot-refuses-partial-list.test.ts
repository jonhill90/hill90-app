/**
 * GET /agents/:id/events (one-shot, non-follow) is the route the UI renders
 * directly to a user viewing their own agent's history — higher blast radius
 * than the CSV export sibling, same root cause: an inference-history query
 * failure was logged and swallowed, and the response continued with only
 * containerEvents, silently missing every inference event while still
 * returning 200 with an array that looks like the complete history.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Readable } from 'stream';
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
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: (...args: any[]) => mockExecInContainer(...args),
}));

function token(roles: string[]) {
  return jwt.sign(
    { sub: 'owner-user', resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
  );
}
const userToken = token(['user']);

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

function goodContainerLogStream() {
  return Readable.from([
    Buffer.from(JSON.stringify({ id: 'c1', timestamp: '2026-08-05T00:00:00Z', type: 'tool_call' }) + '\n'),
  ]);
}

describe('GET /agents/:id/events (one-shot) refuses a list that would silently omit real events', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('THE ASSERTION THAT MATTERS: an inference-history query failure refuses the response rather than returning a 200 array missing every inference event', async () => {
    mockExecInContainer.mockResolvedValue(goodContainerLogStream());
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agents WHERE/.test(sql)) {
        return Promise.resolve({ rows: [{ agent_id: 'agent-1', status: 'running' }] });
      }
      if (/FROM model_usage/.test(sql)) {
        return Promise.reject(new Error('connection terminated unexpectedly'));
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .get('/agents/agent-uuid/events')
      .set('Authorization', `Bearer ${userToken}`);

    // Before the fix: 200 with an array containing only containerEvents.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(Array.isArray(res.body)).toBe(false);
  });

  it('a genuinely clean read (both sources succeed) is unaffected — still 200 array', async () => {
    mockExecInContainer.mockResolvedValue(goodContainerLogStream());
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agents WHERE/.test(sql)) {
        return Promise.resolve({ rows: [{ agent_id: 'agent-1', status: 'running' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .get('/agents/agent-uuid/events')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
