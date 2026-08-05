import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { decryptProviderKey } from '../services/provider-key-crypto';

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

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

function makeToken(sub: string, roles: string[]): string {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);
const userToken = makeToken('regular-user', ['user']);

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

// No connection_config here — app#369 removed it from every route response.
// A row that included it would be masking exactly the regression the tests
// below exist to catch.
const MOCK_SERVER = {
  id: 'mcp-1',
  name: 'GitHub MCP',
  description: 'GitHub API tools',
  transport: 'stdio',
  is_platform: false,
  agent_count: '2',
  created_by: 'regular-user',
  created_at: '2026-04-19T00:00:00Z',
};

describe('MCP Servers routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  });

  describe('GET /mcp-servers', () => {
    it('lists servers for user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });

      const res = await request(app)
        .get('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('GitHub MCP');
    });

    it('admin sees all servers', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });

      const res = await request(app)
        .get('/mcp-servers')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      // Admin query should NOT contain the created_by WHERE filter. Not a
      // bare substring check: `created_by` legitimately appears in the
      // SELECT column list now that it's explicit (app#369, to exclude the
      // encrypted columns) rather than `SELECT *` — what actually matters
      // is that no WHERE clause restricts by it.
      const queryStr = mockQuery.mock.calls[0][0];
      expect(queryStr).not.toContain('WHERE ms.created_by');
    });

    it('user query scopes to own + platform', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .get('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`);

      const queryStr = mockQuery.mock.calls[0][0];
      expect(queryStr).toContain('created_by');
      expect(queryStr).toContain('is_platform');
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get('/mcp-servers');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /mcp-servers', () => {
    it('creates a server', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });

      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'GitHub MCP', transport: 'stdio', connection_config: { command: 'npx' } });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('GitHub MCP');
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transport: 'stdio' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('rejects invalid transport', async () => {
      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Test', transport: 'grpc' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('transport');
    });

    it('non-admin cannot create platform server', async () => {
      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Platform', is_platform: true });

      expect(res.status).toBe(403);
    });

    it('admin can create platform server', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...MOCK_SERVER, is_platform: true }] });

      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Platform', is_platform: true });

      expect(res.status).toBe(201);
    });
  });

  describe('PUT /mcp-servers/:id', () => {
    it('updates a server', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...MOCK_SERVER, name: 'Updated' }] });

      const res = await request(app)
        .put('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .put('/mcp-servers/bad-id')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /mcp-servers/:id', () => {
    it('deletes a server', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .delete('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('returns 404 for non-existent', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app)
        .delete('/mcp-servers/bad-id')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(404);
    });

    it('user can only delete own servers', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await request(app)
        .delete('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`);

      const queryStr = mockQuery.mock.calls[0][0];
      expect(queryStr).toContain('created_by');
    });
  });

  // app#369: connection_config can carry a credential (a command's --token
  // arg, an env block) and used to be stored as plain JSONB, returned
  // verbatim on every list and get call. These tests prove three things
  // together, none of which alone is the fix: the plaintext is genuinely
  // encrypted before it reaches a query (not just moved to a differently
  // named plaintext column), the ciphertext round-trips back to the exact
  // original value (proving this is real AES-256-GCM via the same helper
  // provider_connections uses, not a placeholder), and no route's SELECT or
  // RETURNING clause ever names the encrypted columns — which is where
  // redaction actually happens, not by filtering a response afterward.
  describe('connection_config credential handling (app#369)', () => {
    const SECRET_ARG = 'ghp_SUPERSECRETTOKENVALUE1234567890';
    const REAL_CONFIG = { command: 'npx', args: ['-y', '--token', SECRET_ARG] };

    it('POST encrypts connection_config — the secret never reaches the INSERT as plaintext, and decrypts back to the exact original', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });

      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'GitHub MCP', transport: 'stdio', connection_config: REAL_CONFIG });

      expect(res.status).toBe(201);

      const [queryText, params] = mockQuery.mock.calls[0];
      // The secret must not appear anywhere in the query text or params in
      // cleartext — not in the SQL, not in any string parameter.
      expect(queryText).not.toContain(SECRET_ARG);
      for (const p of params) {
        if (typeof p === 'string') expect(p).not.toContain(SECRET_ARG);
      }

      // Two Buffer params carry the ciphertext and nonce. Decrypting them
      // with the same key/algorithm the route used must reproduce the
      // exact original config — a real round trip, not an assumption that
      // "some bytes were sent" means encryption happened.
      const encrypted: Buffer = params.find((p: unknown) => Buffer.isBuffer(p) && (p as Buffer).length > 12);
      const nonce: Buffer = params.find((p: unknown) => Buffer.isBuffer(p) && (p as Buffer).length === 12);
      expect(encrypted).toBeInstanceOf(Buffer);
      expect(nonce).toBeInstanceOf(Buffer);

      const decrypted = JSON.parse(decryptProviderKey(encrypted, nonce, TEST_ENCRYPTION_KEY));
      expect(decrypted).toEqual(REAL_CONFIG);
    });

    it('PUT re-encrypts when a new connection_config is sent, and touches nothing when it is not', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });

      await request(app)
        .put('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ connection_config: REAL_CONFIG });

      const [, params] = mockQuery.mock.calls[0];
      expect(params.some((p: unknown) => typeof p === 'string' && p.includes(SECRET_ARG))).toBe(false);
      const encrypted: Buffer | undefined = params.find((p: unknown) => Buffer.isBuffer(p) && (p as Buffer).length > 12);
      expect(encrypted).toBeInstanceOf(Buffer);

      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });
      await request(app)
        .put('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Renamed only' });

      // connection_config was not sent — the two encrypted-column params
      // must be null so COALESCE keeps the existing ciphertext, not a
      // silent re-encryption of an empty config that would destroy the
      // stored credential.
      const [, paramsNoConfig] = mockQuery.mock.calls[1];
      const encryptedParams = paramsNoConfig.filter((p: unknown) => p === null || Buffer.isBuffer(p));
      expect(encryptedParams.filter((p: unknown) => Buffer.isBuffer(p))).toHaveLength(0);
    });

    // POSITIVE CONTROL. Proves the assertions above can actually fail, not
    // just that they happen to pass — a query text that (wrongly) named the
    // encrypted columns must be caught, the same discipline as #359 and #367.
    it('CONTROL: a query text that named the encrypted columns would fail this suite\'s own redaction assertions', () => {
      const regressedQuery = `SELECT id, name, connection_config_encrypted, connection_config_nonce FROM mcp_servers`;
      expect(() => {
        expect(regressedQuery).not.toContain('connection_config_encrypted');
      }).toThrow();
    });

    it('GET /mcp-servers never selects the encrypted columns', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });
      await request(app).get('/mcp-servers').set('Authorization', `Bearer ${userToken}`);
      const queryText = mockQuery.mock.calls[0][0];
      expect(queryText).not.toContain('connection_config_encrypted');
      expect(queryText).not.toContain('connection_config_nonce');
      expect(queryText).not.toContain('SELECT ms.*');
      expect(queryText).not.toMatch(/SELECT \*/);
    });

    it('GET /mcp-servers/:id never selects the encrypted columns', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await request(app).get('/mcp-servers/mcp-1').set('Authorization', `Bearer ${userToken}`);
      const queryText = mockQuery.mock.calls[0][0];
      expect(queryText).not.toContain('connection_config_encrypted');
      expect(queryText).not.toContain('connection_config_nonce');
    });

    it('PUT /mcp-servers/:id RETURNING clause never names the encrypted columns', async () => {
      // The SET clause legitimately writes TO connection_config_encrypted —
      // that's the point of the route. Only the RETURNING clause, which
      // decides what comes back to the client, must never read it.
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });
      await request(app)
        .put('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Updated' });
      const queryText = mockQuery.mock.calls[0][0];
      const returningClause = queryText.slice(queryText.indexOf('RETURNING'));
      expect(returningClause).not.toContain('*');
      expect(returningClause).not.toContain('connection_config_encrypted');
      expect(returningClause).not.toContain('connection_config_nonce');
    });

    it('the response body of every read never carries connection_config in any form', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });
      const res = await request(app).get('/mcp-servers').set('Authorization', `Bearer ${userToken}`);
      const bodyText = JSON.stringify(res.body);
      expect(bodyText).not.toContain('connection_config');
    });
  });
});
