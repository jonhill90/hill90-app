/**
 * GET /agents/:id/events/export already refuses to build a CSV on top of a
 * failed container-events read — but only for ReadTooLargeError specifically.
 * Its own comment names the exact danger for the general case and only half
 * covers it:
 *
 *   "Must NOT fall through to the generic catch below. That one logs and
 *    continues with an empty containerEvents, which would hand back a CSV
 *    that looks complete and silently contains none of the agent's events."
 *
 * Two paths still did exactly that: any OTHER container-events failure
 * (network blip, exec error — anything but ReadTooLargeError) fell into the
 * generic `console.error` and continued with `containerEvents = []`, and the
 * inferenceEvents catch had no special-casing at all, ever. A user exporting
 * an agent's history for audit/debugging got a file that downloads
 * successfully, is named like a complete export, and silently contains a
 * fraction of the real record — worse than an empty list, because it looks
 * plausible rather than obviously wrong.
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

function agentLookupOnly() {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM agents WHERE/.test(sql)) {
      return Promise.resolve({ rows: [{ agent_id: 'agent-1', status: 'running' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

/** A well-formed, tiny container event log — the container-events read succeeds. */
function goodContainerLogStream() {
  const { Readable } = require('stream');
  return Readable.from([
    Buffer.from(JSON.stringify({ id: 'c1', timestamp: '2026-08-05T00:00:00Z', type: 'tool_call' }) + '\n'),
  ]);
}

describe('GET /agents/:id/events/export refuses a CSV that would silently omit real events', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('THE ASSERTION THAT MATTERS: an inference-history query failure refuses the export rather than shipping a CSV missing every inference event', async () => {
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
      .get('/agents/agent-uuid/events/export')
      .set('Authorization', `Bearer ${userToken}`);

    // Before the fix: 200, text/csv, a file that downloads as if complete.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers['content-type']).not.toMatch(/text\/csv/);
    // The response must not be an empty-but-200 CSV wearing an error status —
    // it has to actually say something is missing.
    expect(JSON.stringify(res.body)).toMatch(/inference|event/i);
  });

  it('a container-events failure that is NOT ReadTooLargeError also refuses the export, not just the oversized case', async () => {
    mockExecInContainer.mockRejectedValue(new Error('exec failed: container not found'));
    agentLookupOnly();

    const res = await request(app)
      .get('/agents/agent-uuid/events/export')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers['content-type']).not.toMatch(/text\/csv/);
  });

  it('a genuinely clean export (both reads succeed) is unaffected — still 200 CSV', async () => {
    mockExecInContainer.mockResolvedValue(goodContainerLogStream());
    agentLookupOnly();

    const res = await request(app)
      .get('/agents/agent-uuid/events/export')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('tool_call');
  });
});
