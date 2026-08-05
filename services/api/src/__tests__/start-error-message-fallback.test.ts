/**
 * POST /agents/:id/start's catch block used `err.message` raw, with no
 * fallback, in all four places it records the failure: the `agents` row's
 * `error_message` column, the `error` webhook payload, the `notify(...)`
 * message text, and the response body's `detail` field.
 *
 * THE DEFECT. If anything in the try block rejects with a non-Error value
 * (a plain string, a plain object, anything without a populated `.message`),
 * `err.message` is `undefined`. `pg` binds `undefined` params as `NULL`, so
 * the row lands as `status='error', error_message=NULL` — an operator
 * querying `agents` for why a start failed sees a failed agent with no
 * reason recorded at all, indistinguishable from a column that was never
 * populated. `JSON.stringify` drops an `undefined` value entirely, so the
 * webhook payload's `error` key vanishes rather than reading `"error":
 * null`. The notify message reads literally "...failed to start: undefined"
 * — worse than no message, because it looks like a real (if useless) value.
 *
 * This exact pattern is already established elsewhere in the SAME file —
 * agents.ts:1279 uses `err instanceof Error ? err.message : String(err)` for
 * its own container-stop-failure audit log — this catch block just never
 * got it.
 *
 * WHAT THIS TEST PROVES. That every one of the four sites records a real,
 * non-empty string when the underlying rejection carries no `.message`, not
 * that container startup always fails this way in production.
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

const mockCreateAndStartContainer = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: (...args: any[]) => mockCreateAndStartContainer(...args),
  stopAndRemoveContainer: jest.fn().mockResolvedValue(undefined),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn().mockResolvedValue(undefined),
  reconcileAgentStatuses: jest.fn().mockResolvedValue(undefined),
  resolveAgentNetwork: jest.requireActual('../services/docker').resolveAgentNetwork,
  AGENT_NETWORK: 'hill90_agent_internal',
  AGENT_SANDBOX_NETWORK: 'hill90_agent_sandbox',
}));

jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn().mockReturnValue('/data/agentbox/test-agent'),
  removeAgentFiles: jest.fn(),
}));

jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn().mockResolvedValue(undefined),
  reconcileToolInstalls: jest.fn().mockResolvedValue({ installed: [], alreadyInstalled: [], failed: [] }),
}));

jest.mock('../services/model-router-token', () => ({
  generateAgentModelRouterToken: jest.fn(),
  getModelRouterEnvVars: jest.fn().mockReturnValue([]),
  isModelRouterConfigured: () => false,
}));

jest.mock('../services/akm-token', () => ({
  generateAgentAkmToken: jest.fn(),
  getAkmEnvVars: jest.fn().mockReturnValue([]),
  isAkmConfigured: () => false,
}));

const mockDispatchWebhooks = jest.fn();
jest.mock('../services/webhook-dispatch', () => ({
  dispatchWebhooks: (...args: unknown[]) => mockDispatchWebhooks(...args),
}));

const mockNotify = jest.fn();
jest.mock('../services/notifications', () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
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

function queueStartQueriesThenErrorRecording() {
  mockQuery
    .mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'test-agent', name: 'Test',
        tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
        soul_md: '', rules_md: '', description: '', created_by: 'admin-user',
      }],
    })
    .mockResolvedValueOnce({ rows: [] }) // SELECT agent_skills (skill instructions)
    .mockResolvedValueOnce({ rows: [] }) // getAgentElevatedScope
    .mockResolvedValueOnce({ rows: [] }) // getAgentEffectiveScope
    // The catch block's own two writes: UPDATE agents SET status='error', then
    // INSERT INTO agent_status_history.
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

describe('POST /agents/:id/start error recording survives a non-Error rejection', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateAndStartContainer.mockReset();
    mockDispatchWebhooks.mockReset();
    mockNotify.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
  });

  it('THE ASSERTION THAT MATTERS: a rejection with no .message still produces a real error string in every record', async () => {
    queueStartQueriesThenErrorRecording();
    // A rejection shaped like a real-world non-Error throw: a plain object
    // with no `message` property at all (e.g. from a dependency that
    // rejects with its own error-shaped-but-not-Error value).
    mockCreateAndStartContainer.mockRejectedValue({ code: 'ECONNREFUSED' });

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);

    // Response body: detail must be a non-empty string, not undefined.
    expect(typeof res.body.detail).toBe('string');
    expect(res.body.detail.length).toBeGreaterThan(0);

    // DB write: the UPDATE agents SET status='error', error_message=$1 call
    // is the first queued call after the read queries.
    const errorUpdateCall = mockQuery.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes("status = 'error'") && c[0].includes('error_message')
    );
    expect(errorUpdateCall).toBeDefined();
    const [, params] = errorUpdateCall!;
    expect(typeof params[0]).toBe('string');
    expect(params[0].length).toBeGreaterThan(0);

    // Webhook payload: error key must be a real string, not silently
    // dropped by JSON.stringify(undefined).
    expect(mockDispatchWebhooks).toHaveBeenCalled();
    const webhookPayload = mockDispatchWebhooks.mock.calls[0][3];
    expect(typeof webhookPayload.error).toBe('string');
    expect(webhookPayload.error.length).toBeGreaterThan(0);

    // notify(): the message must not literally contain "undefined".
    expect(mockNotify).toHaveBeenCalled();
    const notifyMessage = mockNotify.mock.calls[0][1];
    expect(notifyMessage).not.toMatch(/undefined/);
  });
});
