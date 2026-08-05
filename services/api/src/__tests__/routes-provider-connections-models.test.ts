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

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
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

describe('Provider Connections — Model Listing', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAxiosPost.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;
  });

  // B1: GET /:id/models valid connection
  it('B1: GET /:id/models returns model list', async () => {
    // Connection ownership lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });

    // AI service response
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        models: [
          { id: 'openai/gpt-4o', display_name: 'gpt-4o', detected_type: 'chat', capabilities: ['chat'] },
        ],
      },
    });

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);
    expect(res.body.provider).toBe('openai');
  });

  // B2: GET non-owned connection
  it('B2: GET non-owned connection returns 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/provider-connections/other-conn/models')
      .set('Authorization', `Bearer ${userBToken}`);

    expect(res.status).toBe(404);
  });

  // B3: AI service returns error
  it('B3: AI service error returns models:[] with error', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });

    mockAxiosPost.mockRejectedValueOnce({
      response: { data: { error: 'Invalid API key' } },
    });

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.error).toBe('Invalid API key');
  });

  // Wrong-record sweep (app#470): `errorMsg = err.response?.data?.error ||
  // err.message` has no final `|| ''` fallback, unlike its two siblings in
  // this same file (the /validate route, and the bulk-validate loop), which
  // both end `... || err.message || ''`. A rejection with neither
  // `response.data.error` nor `.message` — a plain object, the shape axios
  // itself is not the only thing capable of throwing here — made errorMsg
  // undefined, and JSON.stringify DROPS an undefined `error` key entirely.
  // That is the exact bug this route's own B7 test above says #396 fixed
  // one layer up (a decrypt failure rendering as "no models" instead of a
  // reason): a caller checking `if (data.error)` saw neither a models list
  // nor an explanation — worse than an empty string, because the key
  // wasn't there to check at all. Matches the sibling `|| ''` fallback
  // exactly, not a stronger guarantee: an empty string is still what a
  // truly informationless rejection produces, same as its siblings.
  it('THE ASSERTION THAT MATTERS: a rejection with neither response.data.error nor .message still keeps the error key present', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });

    mockAxiosPost.mockRejectedValueOnce({ code: 'ECONNREFUSED' });

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    // Present and a string — not dropped by JSON.stringify(undefined) —
    // even though its value can legitimately be '' when truly nothing is
    // available, matching this file's own established sibling fallback.
    expect('error' in res.body).toBe(true);
    expect(typeof res.body.error).toBe('string');
  });

  // POSITIVE CONTROL for #361: this route used `WHERE id = $1 AND
  // created_by = $2` with no admin branch, unlike DELETE /:id in
  // routes/provider-connections.ts, which already has one. A platform
  // connection (created_by IS NULL) could never match that predicate for
  // ANYONE — admin included — so listing a platform connection's available
  // models always 404'd, even though the connection is visible on the
  // Connections page (#359) with a fully clickable button that reaches this
  // route.
  it('B5: admin can list models for a platform connection (created_by IS NULL) — #361', async () => {
    // Ownership query, admin branch: must not bind created_by, or it could
    // never match a NULL-owned row.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'platform-conn', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        models: [
          { id: 'openai/gpt-4o', display_name: 'gpt-4o', detected_type: 'chat', capabilities: ['chat'] },
        ],
      },
    });

    const res = await request(app)
      .get('/provider-connections/platform-conn/models')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);
    const fetchCall = mockQuery.mock.calls[0];
    expect(fetchCall[0]).not.toContain('created_by');
    expect(fetchCall[1]).toEqual(['platform-conn']);
  });

  // The arm that stops this fix becoming a privilege bug.
  it('B6: non-admin still gets 404 listing models for a platform connection they do not own — #361', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/provider-connections/platform-conn/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
  });

  // app#396: services/ai's /internal/list-provider-models returns HTTP 200
  // with `{models: [], error: "..."}` when the provider key can't be
  // decrypted — deliberately, so a decrypt failure doesn't read as a
  // transport error. Axios does not throw on a 200, so this response landed
  // in the SUCCESS branch — a different code path from B3/B4 above, which
  // both exercise axios REJECTING. Before the fix, `response.data?.models
  // || []` was the only field read there, so `error` was silently dropped
  // and a decrypt failure rendered to the user as "this provider has no
  // models" instead of the real reason.
  it('B7 (app#396): a 200 response carrying models:[] AND error forwards the error, not just the empty list', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });

    // A RESOLVED axios call, status 200, exactly what services/ai sends on
    // a decrypt failure — not a rejection, which is what B3/B4 test.
    mockAxiosPost.mockResolvedValueOnce({
      data: { models: [], error: 'Failed to decrypt provider key' },
    });

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    // THE ASSERTION THAT MATTERS: the error survives the round trip.
    expect(res.body.error).toBe('Failed to decrypt provider key');
  });

  it('a 200 response with models and no error still omits the error key entirely, not error: undefined', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });
    mockAxiosPost.mockResolvedValueOnce({
      data: { models: [{ id: 'openai/gpt-4o' }] },
    });

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect('error' in res.body).toBe(false);
  });

  // B4: AI service timeout
  it('B4: AI service timeout returns actionable error', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });

    mockAxiosPost.mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'));

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.error).toContain('timeout');
  });
});
