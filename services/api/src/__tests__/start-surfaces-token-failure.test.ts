/**
 * POST /agents/:id/start already refuses to let a token-generation failure
 * abort the start — the agent's container really did launch, and the file's
 * own comment elsewhere argues a secondary concern must not be reported as a
 * launch failure. That reasoning is right for what it covers. What it does
 * NOT cover: `isModelRouterConfigured()` means the platform expects every
 * agent to be able to reach the model router, and a caught, logged,
 * swallowed failure there leaves `MODEL_ROUTER_TOKEN` unset in the
 * container's environment — confirmed against services/agentbox/app/chat.py,
 * which returns `status="error", error_message="MODEL_ROUTER_TOKEN not
 * configured"` on every single chat/inference attempt from that point on,
 * with no later recovery path (token_refresh.py only refreshes a token that
 * was set at start; there is nothing to refresh here).
 *
 * The caller of POST /:id/start sees `{status: "running", container_id,
 * principal_id}` — identical to a fully healthy start. Nothing connects a
 * later "MODEL_ROUTER_TOKEN not configured" chat error back to this moment.
 * That is the exact "operation fails but reports success" shape this suite
 * exists to close: not a permission or launch failure, a silently crippled
 * agent that LOOKS like it started cleanly.
 *
 * This does not change whether the container starts — same reasoning as the
 * file's existing comment: the agent already launched, and that must not be
 * undone over a token failure. It only stops the response from staying
 * silent about it.
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

const mockCreateAndStartContainer = jest.fn().mockResolvedValue({ containerId: 'container-id-123', edgeNetworkAttachFailed: false });
jest.mock('../services/docker', () => ({
  createAndStartContainer: (...args: any[]) => mockCreateAndStartContainer(...args),
  stopAndRemoveContainer: jest.fn().mockResolvedValue(undefined),
  inspectContainer: jest.fn().mockResolvedValue({
    status: 'running', containerId: 'container-id-123', health: 'healthy',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
  }),
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

const mockGenerateAgentModelRouterToken = jest.fn();
jest.mock('../services/model-router-token', () => ({
  generateAgentModelRouterToken: (...args: any[]) => mockGenerateAgentModelRouterToken(...args),
  getModelRouterEnvVars: jest.fn().mockReturnValue([]),
  isModelRouterConfigured: () => true,
}));

const mockGenerateAgentAkmToken = jest.fn();
jest.mock('../services/akm-token', () => ({
  generateAgentAkmToken: (...args: any[]) => mockGenerateAgentAkmToken(...args),
  getAkmEnvVars: jest.fn().mockReturnValue([]),
  isAkmConfigured: () => false,
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);

function queueStartQueries() {
  mockQuery
    .mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'test-agent', name: 'Test',
        tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
        soul_md: '', rules_md: '', description: '', created_by: 'admin-user',
      }],
    })
    .mockResolvedValueOnce({ rows: [] }) // SELECT agent_skills (skill instructions)
    .mockResolvedValueOnce({ rows: [] }) // getAgentElevatedScope (AI-115 ceiling check)
    .mockResolvedValueOnce({ rows: [] }) // SELECT DISTINCT s.scope (getAgentEffectiveScope)
    .mockResolvedValueOnce({ rows: [] }); // final UPDATE agents SET status = 'running'
}

describe('POST /agents/:id/start surfaces a token-generation failure instead of staying silent', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateAndStartContainer.mockReset();
    mockCreateAndStartContainer.mockResolvedValue({ containerId: 'container-id-123', edgeNetworkAttachFailed: false });
    mockGenerateAgentModelRouterToken.mockReset();
    mockGenerateAgentAkmToken.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
  });

  it('THE ASSERTION THAT MATTERS: model-router token generation failing is visible in the response, not just a console.error', async () => {
    queueStartQueries();
    mockGenerateAgentModelRouterToken.mockRejectedValue(new Error('AI service unreachable'));

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    // The container really did start — this must still be true. The start
    // is not undone by a token failure, same as the file's own existing
    // policy for other secondary concerns.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.container_id).toBe('container-id-123');

    // THE ASSERTION THAT MATTERS: a caller reading only this response must
    // be able to tell the agent cannot make inference requests, without
    // separately discovering it from a chat failure with no connection back
    // to this moment.
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.warnings.some((w: string) => /model.router/i.test(w))).toBe(true);
  });

  it('a clean start (no token failures) carries no warnings field at all', async () => {
    // One extra queued response versus queueStartQueries(): a successful
    // model-router token generation adds the `UPDATE agents SET
    // model_router_jti = ...` write before the final status update.
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1', agent_id: 'test-agent', name: 'Test',
          tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
          soul_md: '', rules_md: '', description: '', created_by: 'admin-user',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // SELECT agent_skills
      .mockResolvedValueOnce({ rows: [] }) // getAgentElevatedScope
      .mockResolvedValueOnce({ rows: [] }) // getAgentEffectiveScope
      .mockResolvedValueOnce({ rows: [] }) // UPDATE agents SET model_router_jti
      .mockResolvedValueOnce({ rows: [] }); // final UPDATE agents SET status = 'running'

    mockGenerateAgentModelRouterToken.mockResolvedValue({
      token: 'fake-jwt', jti: 'jti-1', expiresAt: 9999999999, refreshSecret: 'secret',
    });

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeUndefined();
  });
});
