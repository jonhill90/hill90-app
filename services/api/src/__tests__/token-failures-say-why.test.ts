/**
 * A refused token must say WHY, on every path that refuses one.
 *
 * `middleware/auth.ts` learned this on 2026-08-03 (#114): a bare `catch {}` meant an
 * expired token, a token signed with the wrong key, and a request reaching a verifier
 * configured for a different issuer all produced the same silent 401 — "623 logs of
 * this suite contained six 401s that could not be told apart". The fix records the
 * cause and never logs the token.
 *
 * The lesson was written down and the shape survived in two other places, found by
 * auditing the #133 sweep's own classifier (#289):
 *
 *   services/model-router-refresh.ts:53   catch { res.status(401)…'invalid token' }
 *   index.ts (WebSocket terminal verifier) catch { return null }
 *
 * Both bind nothing and log nothing. The second is on the surface index.ts itself
 * calls "the most privileged surface in the app".
 *
 * These tests assert the property rather than the wording: a distinguishable failure
 * produces a distinguishable record, and the token never appears in it.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { verifyTerminalToken } from '../services/terminal-token';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(), stopAndRemoveContainer: jest.fn(), inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(), removeAgentVolumes: jest.fn(), reconcileAgentStatuses: jest.fn(),
}));
jest.mock('../services/agent-files', () => ({ writeAgentFiles: jest.fn(), removeAgentFiles: jest.fn() }));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
// Set BEFORE the app is required: model-router-token.ts reads this at module scope,
// so a beforeEach assignment would arrive after the module had already decided the
// feature was unconfigured (and every request would 503 instead of reaching the code
// under test — which is what the first run of this suite actually did).
// #459: the model-router key must be Ed25519, because that is what production
// uses and what the handler now VERIFIES against. It was an RSA key here only
// because nothing checked — the fixtures below were RS256 tokens the service
// could never have issued, and they passed because the handler base64-decoded
// the payload and trusted it. The RSA pair above stays: it is the KEYCLOAK
// signing key for the auth-middleware tests further down, a different subject.
const mrKeys = crypto.generateKeyPairSync('ed25519');
process.env.MODEL_ROUTER_SIGNING_PRIVATE_KEY = mrKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

/** A genuine model-router token: EdDSA, this service's key, real iss/aud. */
function mintModelRouterToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'EdDSA', typ: 'JWT' });
  const payload = b64({
    iss: 'hill90-api',
    aud: 'hill90-model-router',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  });
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`), mrKeys.privateKey);
  return `${header}.${payload}.${sig.toString('base64url')}`;
}
const { createApp } = require('../app');
const TEST_ISSUER = 'https://test-issuer.example.com/realms/platform';
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

let warned: string[] = [];
beforeEach(() => {
  warned = [];
  jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.DATABASE_URL;
});

describe('POST /internal/model-router/refresh-token', () => {
  const post = (bearer: string) =>
    request(app)
      .post('/internal/model-router/refresh-token')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ refresh_secret: 'whatever' });

  it('a malformed token is refused AND recorded', async () => {
    const res = await post('not-a-jwt');
    expect(res.status).toBe(401);
    expect(warned.join('\n')).toMatch(/model-router-refresh/);
    expect(warned.join('\n')).toMatch(/malformed/i);
  });

  it('a token whose payload will not parse is recorded DIFFERENTLY from a malformed one', async () => {
    const res = await post(`${Buffer.from('{}').toString('base64url')}.@@notbase64@@.sig`);
    expect(res.status).toBe(401);
    const record = warned.join('\n');
    expect(record).toMatch(/model-router-refresh/);
    // The point of the whole exercise: two different faults, two different records.
    expect(record).not.toMatch(/malformed JWT/);
  });

  it('a token with no sub is recorded as that, not as "invalid"', async () => {
    const noSub = mintModelRouterToken({ foo: 'bar' });
    const res = await post(noSub);
    expect(res.status).toBe(401);
    expect(warned.join('\n')).toMatch(/sub/i);
  });

  it('never writes the token into the record', async () => {
    const secret = mintModelRouterToken({ sub: 'agent-1' });
    await post(`${secret}`.slice(0, 40));
    expect(warned.join('\n')).not.toContain(secret.slice(0, 40));
  });

  it('POSITIVE CONTROL: a well-formed token gets PAST the identity step', async () => {
    const good = mintModelRouterToken({ sub: 'agent-1' });
    const res = await post(good);

    // It still ends in 401 — no agent row matches this refresh secret in the fake —
    // and that is the point of the control rather than a flaw in it: the assertion
    // is on WHICH step refused. `token rejected` is the decode step's record and
    // must be absent; the later step has recorded its own failure since #258.
    expect(res.status).toBe(401);
    expect(warned.join('\n')).not.toMatch(/token rejected/);
    expect(warned.join('\n')).toMatch(/agent-1/);
  });
});

describe('the WebSocket terminal verifier', () => {
  const getSigningKey = async () => publicKey as unknown as string;

  it('refuses a token signed with the wrong key AND records the cause', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = jwt.sign({ sub: 'u1' }, other.privateKey, { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' });
    const principal = await verifyTerminalToken(token, { issuer: TEST_ISSUER, getSigningKey });
    expect(principal).toBeNull();
    expect(warned.join('\n')).toMatch(/terminal-proxy/);
    expect(warned.join('\n')).toMatch(/signature/i);
  });

  it('records an EXPIRED token differently from a badly signed one', async () => {
    const token = jwt.sign({ sub: 'u1' }, privateKey, { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: -10 });
    const principal = await verifyTerminalToken(token, { issuer: TEST_ISSUER, getSigningKey });
    expect(principal).toBeNull();
    expect(warned.join('\n')).toMatch(/expired/i);
  });

  it('records a wrong-issuer token as that', async () => {
    const token = jwt.sign({ sub: 'u1' }, privateKey, { algorithm: 'RS256', issuer: 'https://elsewhere/realms/x', expiresIn: '1h' });
    const principal = await verifyTerminalToken(token, { issuer: TEST_ISSUER, getSigningKey });
    expect(principal).toBeNull();
    expect(warned.join('\n')).toMatch(/issuer/i);
  });

  // #313: this boundary must not be more permissive than the HTTP one #306 fixed.
  // Both are the same claim — that the caller is identifiable — and a terminal
  // session with no identifiable owner is worse than a request with one, because
  // it persists and does things after the check has passed.
  it('refuses a token with no sub AND records the cause — the same claim #306 makes at the HTTP boundary', async () => {
    const token = jwt.sign({}, privateKey, { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' });
    const principal = await verifyTerminalToken(token, { issuer: TEST_ISSUER, getSigningKey });
    expect(principal).toBeNull();
    expect(warned.join('\n')).toMatch(/terminal-proxy/);
    expect(warned.join('\n')).toMatch(/sub/i);
  });

  it('refuses an empty-string sub too, not only a missing one', async () => {
    const token = jwt.sign({ sub: '' }, privateKey, { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' });
    const principal = await verifyTerminalToken(token, { issuer: TEST_ISSUER, getSigningKey });
    expect(principal).toBeNull();
    expect(warned.join('\n')).toMatch(/sub/i);
  });

  it('never writes the token into the record', async () => {
    const token = jwt.sign({ sub: 'u1' }, privateKey, { algorithm: 'RS256', issuer: 'https://elsewhere/realms/x', expiresIn: '1h' });
    await verifyTerminalToken(token, { issuer: TEST_ISSUER, getSigningKey });
    expect(warned.join('\n')).not.toContain(token);
  });

  it('POSITIVE CONTROL: a valid token still yields the principal, and records nothing', async () => {
    const token = jwt.sign(
      { sub: 'u1', resource_access: { 'hill90-ui': { roles: ['admin'] } } },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
    );
    const principal = await verifyTerminalToken(token, { issuer: TEST_ISSUER, getSigningKey });
    expect(principal).toMatchObject({ sub: 'u1', roles: ['admin'] });
    expect(typeof principal!.exp).toBe('number');
    expect(warned).toEqual([]);
  });
});
