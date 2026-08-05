/**
 * POST /agents/:id/start writes the AKM and model-router JTIs to the agents
 * row "for revocation on stop" (the file's own comment) AFTER the container
 * is already running, but BEFORE the UPDATE that sets status='running' and
 * persists work_token. Those two JTI writes were unguarded pool.query calls:
 * if either throws (a transient DB blip, pool exhaustion — nothing exotic),
 * execution falls straight into the outer catch, which sets status='error'
 * while the container is genuinely, healthily running.
 *
 * agent-reconciler.ts's 60s pass will see the running container and promote
 * status back to 'running' — but it only restores Docker-observable fields
 * (status, container_id, container_state). It has no way to know work_token
 * was never written, so the agent ends up looking fully healthy (status:
 * running, a real container) while every chat/inference request against it
 * fails, because chat dispatch verifies work_token and finds none. Nothing
 * connects that failure back to this moment.
 *
 * The fix: the two JTI writes are best-effort, same as the status-history
 * and session-tracking inserts immediately below them in the same function
 * (each already in its own try/catch, logged, non-fatal). Losing a JTI only
 * means a later revoke-on-stop has nothing to revoke — the same risk this
 * file's stop handler already accepts and documents for a failed revoke
 * call (#269). What must not happen is the reverse: an ancillary write
 * throwing and destroying the start's own success state.
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

const mockCreateAndStartContainer = jest.fn().mockResolvedValue('container-id-123');
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

jest.mock('../services/akm-token', () => ({
  generateAgentAkmToken: jest.fn(),
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

describe('POST /agents/:id/start does not abort a successful start over a failed JTI write', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateAndStartContainer.mockReset();
    mockCreateAndStartContainer.mockResolvedValue('container-id-123');
    mockGenerateAgentModelRouterToken.mockReset();
    mockGenerateAgentModelRouterToken.mockResolvedValue({
      token: 'fake-jwt', jti: 'jti-1', expiresAt: 9999999999, refreshSecret: 'secret',
    });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
  });

  it('THE ASSERTION THAT MATTERS: a transient failure writing model_router_jti still leaves the agent running with work_token persisted, not status=error', async () => {
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
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly')); // UPDATE agents SET model_router_jti — THE failure

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    // The container really did start and the row must say so — not
    // status='error' for a container that is actually running healthy.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.container_id).toBe('container-id-123');

    // work_token must actually have been persisted — the final UPDATE that
    // sets status='running' and work_token must have run despite the JTI
    // write failing above it.
    const finalUpdateCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'running'") && call[0].includes('work_token')
    )
    expect(finalUpdateCall).toBeDefined()

    // And the failure path (status='error') must NOT have run.
    const errorUpdateCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes("status = 'error'")
    )
    expect(errorUpdateCall).toBeUndefined()
  });
});
