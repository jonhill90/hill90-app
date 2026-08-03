/**
 * GET /health/detailed must require a session. GET /health must not.
 *
 * MEASURED IN PRODUCTION before anything was changed, anonymously, from the
 * public internet:
 *
 *   GET https://api.hill90.com/health/detailed  -> 200
 *   GET https://api.hill90.com/health           -> 200
 *   GET https://api.hill90.com/agents           -> 401
 *   GET https://api.hill90.com/me               -> 401
 *
 *   {"status":"healthy","service":"api","uptime_seconds":303304,
 *    "node_version":"v20.20.2","database":{"status":"connected","latency_ms":1},
 *    "memory":{"rss_mb":115,"heap_used_mb":41,"heap_total_mb":48},
 *    "platform":{"agents":{"total":0,"running":0},"threads":0,
 *                "workflows":{"total":0,"enabled":0}}}
 *
 * Anyone on the internet could read the exact Node build, how long the process
 * had been up, whether the database was reachable and how fast it answered, the
 * process's memory profile, and the tenant's inventory of agents, threads and
 * workflows. Every neighbouring route refused them. This is the same defect
 * app#134 fixed on the UI's /api/services/health; that sweep covered the UI's
 * 43 routes and did not reach services/api.
 *
 * AUTHENTICATION, NOT THE ADMIN ROLE — the same reasoning as app#134. The only
 * caller is the UI's monitoring page, which is linked from the dashboard and
 * reachable by any signed-in user; it reaches this route through
 * /api/health/[...path], which proxies via proxyToApi and already carries a
 * session. Requiring `admin` here would 403 ordinary users on a page they are
 * meant to see. The test below pins that, so the gate cannot later be
 * "tightened" into something that breaks the caller.
 *
 * /health STAYS OPEN: the platform's TenantApiDown alert probes
 * api.hill90.com/health, so closing it would blind the estate's monitoring.
 * That is asserted here rather than left to memory.
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
  getPool: () => ({ query: mockQuery }),
  closePool: jest.fn(),
}));

function makeToken(sub: string, roles: string[]): string {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
  );
}

const userToken = makeToken('regular-user', ['user']);
const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

describe('GET /health/detailed is not public', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ total: 0, running: 0, enabled: 0 }] });
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(401);
  });

  it('probes NOTHING when the caller is anonymous', async () => {
    await request(app).get('/health/detailed');
    // Answering 401 *after* querying the database would still let an anonymous
    // caller drive load into the internal network on demand, and would still
    // leak reachability through timing. The refusal must come first.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not leak the runtime or the inventory to an anonymous caller', async () => {
    const res = await request(app).get('/health/detailed');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('node_version');
    expect(body).not.toContain('uptime_seconds');
    expect(body).not.toContain('platform');
  });

  it('serves any signed-in user, not only admins', async () => {
    const res = await request(app)
      .get('/health/detailed')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('api');
    expect(res.body).toHaveProperty('node_version');
  });
});

describe('GET /health stays public', () => {
  it('answers an anonymous caller, because TenantApiDown probes it', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'healthy', service: 'api' });
  });
});
