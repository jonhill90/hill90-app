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
  getPool: () => ({ query: mockQuery }),
}));

const mockAuditLog = jest.fn();
jest.mock('../helpers/audit', () => ({ auditLog: (...a: unknown[]) => mockAuditLog(...a) }));

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
}));
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
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

const userToken = makeToken('regular-user', ['user']);
const userBToken = makeToken('user-b', ['user']);
const adminToken = makeToken('admin-user', ['admin', 'user']);

describe('User Models CRUD', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAuditLog.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.DATABASE_URL;
  });

  it('POST /user-models creates model', async () => {
    // Check connection ownership
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Check platform name collision
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'my-gpt4', connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o', description: '', is_active: true,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'my-gpt4',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my-gpt4');
    expect(res.body.litellm_model).toBe('openai/gpt-4o');
  });

  it('rejects unowned connection_id', async () => {
    // Connection ownership check fails
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'my-model',
        connection_id: 'other-users-conn',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not owned by you');
  });

  it('list shows only own models', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'model-1', name: 'my-gpt4' }],
    });

    const res = await request(app)
      .get('/user-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['regular-user']);
  });

  it('rejects name colliding with active platform model', async () => {
    // Connection ownership OK
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Platform model collision found
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'gpt-4o-mini' }] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'gpt-4o-mini',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o-mini',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('conflicts with a platform model');
  });

  it('allows name matching inactive platform model', async () => {
    // Connection ownership OK
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Platform model collision check — no active match
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'old-model', connection_id: 'conn-1',
        litellm_model: 'openai/old-model', description: '', is_active: true,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'old-model',
        connection_id: 'conn-1',
        litellm_model: 'openai/old-model',
      });

    expect(res.status).toBe(201);
  });

  it('requires user role', async () => {
    const noRoleToken = jwt.sign(
      { sub: 'no-role-user', resource_access: { 'hill90-ui': { roles: [] } } },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
    );
    const res = await request(app)
      .get('/user-models')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'test' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent model on delete', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .delete('/user-models/uuid-nonexistent')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT rejects name collision with platform model', async () => {
    // Ownership check
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1' }] });
    // Platform collision found
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'gpt-4o' }] });

    const res = await request(app)
      .put('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'gpt-4o' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('conflicts with a platform model');
  });

  it('PUT verifies ownership of new connection', async () => {
    // Model ownership OK (includes model_type for router support)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1', model_type: 'single' }] });
    // Connection ownership fails
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ connection_id: 'other-users-conn' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not owned by you');
  });

  // app#451. Issue text characterised this as fail-closed (over-restrictive,
  // not a security hole) rather than asserted it — proved here with two
  // DISTINCT real authenticated owners (A owns the model being edited, B is
  // the caller), not by inspecting the branch or naming a param. B's PUT
  // must never succeed against A's connection, and the mocked ownership
  // query itself is asserted to be scoped to B's own sub, not merely "some
  // 400 came back" (which a broken query could also produce for the wrong
  // reason).
  it('app#451 SECURITY CONTROL: a user editing their own single model cannot attach another user\'s connection, proven with two distinct authenticated owners', async () => {
    // Model ownership OK — model-b belongs to user-b (B), not platform.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-b', model_type: 'single', created_by: 'user-b' }] });
    // Connection ownership query: A's connection is not found under B's sub.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/user-models/model-b')
      .set('Authorization', `Bearer ${userBToken}`) // caller is B, editing B's own model
      .send({ connection_id: 'regular-users-conn' }); // but this connection belongs to A

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not owned by you');

    // THE ASSERTION THAT MATTERS: the query scoped ownership to the
    // CALLER's own sub (B), never to A's — this is what makes the check
    // fail-closed rather than merely "returned 400 somehow".
    const connCall = mockQuery.mock.calls[1];
    expect(connCall[0]).toContain('created_by = $2');
    expect(connCall[1]).toEqual(['regular-users-conn', 'user-b']);
  });

  // app#451, the fix. POST's connection-ownership check branches on
  // whether the model being written is a platform model (created_by IS
  // NULL) — PUT's did not, so an admin editing an EXISTING platform
  // model's connection_id could never satisfy a check unconditionally
  // scoped to their own sub. A platform connection's created_by is NULL,
  // never equal to any caller's sub, admin included.
  it('app#451 FIX: admin editing a platform model\'s connection_id to a platform connection now succeeds', async () => {
    // Model ownership: admin, editing a PLATFORM model (created_by IS NULL).
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-model-1', model_type: 'single', created_by: null }] });
    // Platform-branch connection query finds the platform connection.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-conn-1' }] });
    // UPDATE.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'platform-model-1', connection_id: 'platform-conn-1', created_by: null }],
    });

    const res = await request(app)
      .put('/user-models/platform-model-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ connection_id: 'platform-conn-1' });

    expect(res.status).toBe(200);

    // THE ASSERTION THAT MATTERS: the connection query took the platform
    // branch (created_by IS NULL, no owner param) — not a query still
    // scoped to the admin's own sub, which is exactly what made this 400
    // before the fix.
    const connCall = mockQuery.mock.calls[1];
    expect(connCall[0]).toContain('created_by IS NULL');
    expect(connCall[1]).toEqual(['platform-conn-1']);
  });

  it('app#451: admin editing a platform model\'s connection_id to a NON-platform connection is still rejected', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-model-1', model_type: 'single', created_by: null }] });
    // Platform-branch query: this connection is not platform-owned, so no row.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/user-models/platform-model-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ connection_id: 'someones-user-conn' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not owned by you');
  });

  it('B1: DELETE scrubs model name from owner policies', async () => {
    // Delete returns model with name and owner
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1', name: 'my-gpt4', created_by: 'regular-user' }] });
    // Stale cleanup updates 1 policy
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    // Verify stale cleanup query was called with correct params
    const scrubCall = mockQuery.mock.calls[1];
    expect(scrubCall[0]).toContain('allowed_models = allowed_models - $1');
    expect(scrubCall[0]).toContain('allowed_models ? $1');
    expect(scrubCall[1]).toEqual(['my-gpt4', 'regular-user']);
  });

  it('B2: DELETE does not modify other users policies', async () => {
    // Delete returns model with name and owner
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1', name: 'my-gpt4', created_by: 'regular-user' }] });
    // Stale cleanup
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    await request(app)
      .delete('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`);

    // Verify the scrub query WHERE clause scopes to the caller's sub only
    const scrubCall = mockQuery.mock.calls[1];
    expect(scrubCall[0]).toContain('created_by = $2');
    expect(scrubCall[1][1]).toBe('regular-user');
  });

  it('B3: DELETE succeeds when no policies reference model', async () => {
    // Delete returns model with name and owner
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1', name: 'my-gpt4', created_by: 'regular-user' }] });
    // Stale cleanup finds no matching policies
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
  });

  it('B4 (#424): a failed stale-policy cleanup is audited, not just console.error\'d — the model delete still succeeds', async () => {
    // Delete returns model with name and owner
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1', name: 'my-gpt4', created_by: 'regular-user' }] });
    // Stale cleanup UPDATE throws
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(app)
      .delete('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`);

    // Non-blocking, deliberately: the model delete already succeeded and
    // must not be undone over a best-effort cleanup step failing.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    // THE ASSERTION THAT MATTERS: before this fix the only trace of this
    // failure was a console.error nobody reads. It must now be audited.
    const failed = mockAuditLog.mock.calls.find((c) => c[0] === 'stale_policy_cleanup_failed');
    expect(failed).toBeDefined();
    expect(failed![1]).toBe('model-1');
    expect(failed![2]).toBe('regular-user');
    expect(failed![4]).toMatchObject({ model_name: 'my-gpt4', owner_sub: 'regular-user' });
    expect(String(failed![4]?.error)).toMatch(/connection reset/);
  });
});
