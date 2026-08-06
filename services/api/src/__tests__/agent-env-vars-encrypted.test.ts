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
 * WHY PUT IS A DELTA (env_vars_set / env_vars_unset), NOT A WHOLE-MAP
 * REPLACE — corrected in review of the first version of this fix, which
 * shipped a server-side MERGE on top of a full-object `env_vars` field.
 * That merge WAS safe at the API layer in isolation, but #386's review
 * caught what it missed: the two consumers, AgentClaudeConfig.tsx and
 * AgentDetailClient.tsx, both do client-side read-modify-write —
 * `{ ...(envVars || {}), KEY: val }` — spreading the CURRENT map before
 * applying one change and PUTing the whole result. With env_vars withheld
 * from every response (this fix's whole point), `envVars` is always
 * undefined client-side, so `...(undefined || {})` is `{}` — every existing
 * key silently vanishes from what the client sends, every single save,
 * with a success toast. A server-side merge does not fix this: the CLIENT
 * is the one deciding what "the new full set" is, and it has no way to know
 * anymore. Only a contract where the client never needs the full set closes
 * this — env_vars_set/env_vars_unset name only the key(s) being touched,
 * applied by the server on top of whatever is already there. unset runs
 * before set, so set wins if a key is named in both.
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

describe('agents.env_vars encryption (#374/#386)', () => {
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

  // THE ASSERTION THAT MATTERS. A client that sends ONLY the key it is
  // adding — exactly what a delta-contract UI does, and exactly what the
  // OLD whole-map UI was accidentally reduced to once env_vars stopped
  // being returned — must not lose a sibling key it never mentioned.
  it('PUT env_vars_set with ONE key does not drop a DIFFERENT existing key', async () => {
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
      // Deliberately NOT sending ANTHROPIC_API_KEY — a delta-contract client
      // never sends keys it isn't touching. If this drops ANTHROPIC_API_KEY,
      // the contract has failed at the one thing it exists to prevent.
      .send({ env_vars_set: { LOG_LEVEL: 'debug' } });

    expect(res.status).toBe(200);
    expect(res.body.env_var_keys).toEqual(['ANTHROPIC_API_KEY', 'LOG_LEVEL']);
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-existing-secret');

    // What was actually written to the database: decrypt the real bound
    // params, not just trust the response's own claim about them.
    const updateCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE agents SET')
    );
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    const encryptedParam = params[13] as Buffer; // env_vars_encrypted is the 14th bound param
    const nonceParam = params[14] as Buffer; // env_vars_nonce is the 15th
    const stored = decryptStored(encryptedParam, nonceParam);
    expect(stored).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-existing-secret', LOG_LEVEL: 'debug' });
  });

  it('PUT env_vars_unset removes exactly the named key and leaves the others', async () => {
    const existing = encryptedEnvVarsColumns({ ANTHROPIC_API_KEY: 'sk-ant-keep-me', LOG_LEVEL: 'debug' });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'stopped', created_by: 'regular-user', model_policy_id: null, ...existing }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', agent_id: 'test-agent', name: 'Test', status: 'stopped', created_by: 'regular-user' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ env_vars_unset: ['LOG_LEVEL'] });

    expect(res.status).toBe(200);
    expect(res.body.env_var_keys).toEqual(['ANTHROPIC_API_KEY']);

    const updateCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE agents SET')
    );
    const params = updateCall![1] as unknown[];
    const stored = decryptStored(params[13] as Buffer, params[14] as Buffer);
    expect(stored).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-keep-me' });
  });

  it('env_vars_unset for a key that is also in env_vars_set: set wins (unset applied first)', async () => {
    const existing = encryptedEnvVarsColumns({ ANTHROPIC_API_KEY: 'sk-ant-old' });
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'stopped', created_by: 'regular-user', model_policy_id: null, ...existing }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', agent_id: 'test-agent', name: 'Test', status: 'stopped', created_by: 'regular-user' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ env_vars_set: { ANTHROPIC_API_KEY: 'sk-ant-new' }, env_vars_unset: ['ANTHROPIC_API_KEY'] });

    expect(res.status).toBe(200);
    expect(res.body.env_var_keys).toEqual(['ANTHROPIC_API_KEY']);
    const updateCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE agents SET')
    );
    const params = updateCall![1] as unknown[];
    const stored = decryptStored(params[13] as Buffer, params[14] as Buffer);
    expect(stored).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-new' });
  });

  it('PUT without env_vars_set or env_vars_unset in the body leaves the encrypted columns untouched (COALESCE, not overwritten with null)', async () => {
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
      .send({ name: 'Renamed' }); // env_vars_set/env_vars_unset not mentioned at all

    expect(res.status).toBe(200);
    expect(res.body.env_var_keys).toEqual(['ANTHROPIC_API_KEY']);

    const updateCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE agents SET')
    );
    const params = updateCall![1] as unknown[];
    // Both bound null — COALESCE in the SQL is what preserves the column,
    // not the app re-sending the existing ciphertext.
    expect(params[13]).toBeNull();
    expect(params[14]).toBeNull();
  });

  it('rejects a non-string value in env_vars_set', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'stopped', created_by: 'regular-user', model_policy_id: null }],
    });
    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ env_vars_set: { ANTHROPIC_API_KEY: 12345 } });
    expect(res.status).toBe(400);
  });

  it('rejects env_vars_unset that is not an array of strings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'stopped', created_by: 'regular-user', model_policy_id: null }],
    });
    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ env_vars_unset: 'ANTHROPIC_API_KEY' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POSITIVE CONTROL, run and captured before this shipped — see the PR that
// added this file for the real failing output. Kept here as a permanent,
// always-green record of what the mechanism checks; the red states
// themselves were produced by temporarily reverting the fix and are not
// committed.
// ---------------------------------------------------------------------------
describe('CONTROL: proves the exclusion assertion actually has teeth', () => {
  it('a response that DID carry the raw value would fail the never-contains assertion', () => {
    const leakyResponseBody = { id: 'uuid-1', env_vars: { ANTHROPIC_API_KEY: 'sk-ant-should-not-be-here' } };
    expect(JSON.stringify(leakyResponseBody)).toContain('sk-ant-should-not-be-here');
  });

  it('a whole-map replace that dropped a sibling key would fail the "does not drop" assertion', () => {
    // What the OLD (pre-#386-review) shape would have stored: the client,
    // unable to read back ANTHROPIC_API_KEY, sends only LOG_LEVEL as if it
    // were the complete set, and a naive replace stores exactly that.
    const wholeMapReplaceResult = { LOG_LEVEL: 'debug' };
    expect(wholeMapReplaceResult).not.toEqual({ ANTHROPIC_API_KEY: 'sk-ant-existing-secret', LOG_LEVEL: 'debug' });
  });
});
