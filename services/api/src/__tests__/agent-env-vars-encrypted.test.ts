/**
 * app#374: agents.env_vars encrypted, matching #372's mcp_servers fix and
 * #369's provider_connections reference.
 *
 * `env_vars` stored operator-supplied environment variables — including, per
 * the UI's own AgentClaudeConfig.tsx form, a raw Anthropic API key — in
 * plain JSONB, at rest and on every read (GET /:id, PUT /:id's RETURNING).
 * Same worst tier mcp_servers.connection_config was before #372: plaintext
 * AND returned on read.
 *
 * WHY THE WRITE PATH ALSO CHANGED, NOT JUST READ. Unlike connection_config
 * (always supplied whole by the caller), env_vars is used as a key-value
 * store with individual add/remove operations — the UI's generic env-var
 * editor and the Claude-key form both read back the existing plaintext
 * client-side and re-send the full merged object. Once GET stops returning
 * plaintext, that client-side merge sees an empty object and a naive
 * full-replace on the server would silently wipe every OTHER key the very
 * first time anyone touches one — a data-loss regression, not just an
 * exposure one. PUT now merges server-side on top of the decrypted current
 * value instead of replacing it, so a caller that only knows the key it's
 * touching cannot destroy the others. This does not yet support deleting a
 * key via this endpoint (an empty patch is indistinguishable from "no
 * change") — that is a real limitation, left for the paired UI work, not
 * silently pretended away.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { encryptProviderKey, decryptProviderKey } from '../services/provider-key-crypto';

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

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

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  resolveAgentNetwork: jest.fn().mockReturnValue('hill90_agent_internal'),
}));

jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn(),
  reconcileToolInstalls: jest.fn(),
}));

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const userToken = makeToken('regular-user', ['user']);

/** Real ciphertext, encrypted with the same key the route reads from PROVIDER_KEY_ENCRYPTION_KEY. */
function encryptedEnvVarsColumns(vars: Record<string, string>) {
  const { encrypted, nonce } = encryptProviderKey(JSON.stringify(vars), TEST_ENCRYPTION_KEY);
  return { env_vars_encrypted: encrypted, env_vars_nonce: nonce };
}

function decryptStored(encrypted: Buffer, nonce: Buffer): Record<string, string> {
  return JSON.parse(decryptProviderKey(encrypted, nonce, TEST_ENCRYPTION_KEY));
}

describe('agents.env_vars encryption (#374)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
    delete process.env.DATABASE_URL;
  });

  it('GET /agents/:id decrypts server-side and returns only key names — never the values, never the ciphertext', async () => {
    const SECRET_VALUE = 'sk-ant-api03-do-not-leak-this-9f3a7b2c';
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1', agent_id: 'test-agent', name: 'Test', status: 'stopped',
          created_by: 'regular-user', created_at: new Date(), updated_at: new Date(),
          ...encryptedEnvVarsColumns({ ANTHROPIC_API_KEY: SECRET_VALUE, LOG_LEVEL: 'debug' }),
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // skills

    const res = await request(app)
      .get('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.env_var_keys).toEqual(['ANTHROPIC_API_KEY', 'LOG_LEVEL']);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(SECRET_VALUE);
    expect(bodyStr).not.toMatch(/"env_vars_encrypted"|"env_vars_nonce"|"env_vars"[:\s]/);
  });

  it('PUT /agents/:id merges a new key into the decrypted existing set, without losing the other keys', async () => {
    const existing = encryptedEnvVarsColumns({ ANTHROPIC_API_KEY: 'sk-ant-existing-secret' });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1', agent_id: 'test-agent', status: 'stopped', created_by: 'regular-user',
          model_policy_id: null, ...existing,
        }],
      }) // SELECT existing agent
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', agent_id: 'test-agent', name: 'Test', status: 'stopped', created_by: 'regular-user' }],
      }) // UPDATE ... RETURNING
      .mockResolvedValueOnce({ rows: [] }); // skills for response

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ env_vars: { LOG_LEVEL: 'debug' } });

    expect(res.status).toBe(200);
    // The response never carries plaintext, only key names — and BOTH keys,
    // proving the merge kept the one this request never mentioned.
    expect(res.body.env_var_keys).toEqual(['ANTHROPIC_API_KEY', 'LOG_LEVEL']);
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-existing-secret');

    // What was actually written to the database: decrypt the real bound
    // params, not just trust the response's own claim about them.
    const updateCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE agents SET')
    );
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    const encryptedParam = params[14] as Buffer; // env_vars_encrypted is the 15th bound param
    const nonceParam = params[15] as Buffer; // env_vars_nonce is the 16th
    const stored = decryptStored(encryptedParam, nonceParam);
    expect(stored).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-existing-secret', LOG_LEVEL: 'debug' });
  });

  it('PUT /agents/:id without env_vars in the body leaves the encrypted columns untouched (COALESCE, not overwritten with null)', async () => {
    const existing = encryptedEnvVarsColumns({ ANTHROPIC_API_KEY: 'sk-ant-unchanged' });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'stopped', created_by: 'regular-user', model_policy_id: null, ...existing }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', agent_id: 'test-agent', name: 'Renamed', status: 'stopped', created_by: 'regular-user' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Renamed' }); // env_vars not mentioned at all

    expect(res.status).toBe(200);
    expect(res.body.env_var_keys).toEqual(['ANTHROPIC_API_KEY']);

    const updateCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE agents SET')
    );
    const params = updateCall![1] as unknown[];
    // Both bound null — COALESCE in the SQL is what preserves the column,
    // not the app re-sending the existing ciphertext.
    expect(params[14]).toBeNull();
    expect(params[15]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POSITIVE CONTROL, run and captured before this shipped — see the PR that
// added this file for the real failing output. Kept here as a permanent,
// always-green record of what the mechanism checks; the red state itself was
// produced by temporarily reverting the exclusion and is not committed.
// ---------------------------------------------------------------------------
describe('CONTROL: proves the exclusion assertion actually has teeth', () => {
  it('a response that DID carry the raw value would fail the never-contains assertion', () => {
    const leakyResponseBody = { id: 'uuid-1', env_vars: { ANTHROPIC_API_KEY: 'sk-ant-should-not-be-here' } };
    expect(JSON.stringify(leakyResponseBody)).toContain('sk-ant-should-not-be-here');
  });
});
