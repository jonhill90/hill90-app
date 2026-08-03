/**
 * An async route handler that rejects must produce a 500, not take the process down.
 *
 * Express 4 ignores the promise an async handler returns. When that promise
 * rejects, Express never calls `next(err)`, so nothing responds to the request
 * AND the rejection is unhandled. Node exits on an unhandled rejection by
 * default, and this service registers no handler for one — measured against the
 * production runtime:
 *
 *   $ docker run --rm node:20-alpine node repro.js   →   PROCESS EXIT CODE 1
 *
 * So a single database error on any handler whose awaits sit outside a
 * try/catch terminates the API. Eighteen handlers were in that state across
 * routes/provider-connections.ts, routes/user-models.ts and the browser-action
 * helper in routes/chat.ts.
 *
 * These tests assert the property at the boundary — a rejecting handler is
 * answered with 500 — rather than at eighteen call sites, because the next
 * handler someone writes should inherit the guarantee.
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';
import '../boot/async-errors';

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

const userToken = jwt.sign(
  { sub: 'regular-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

/**
 * Bound every request. Before the fix the symptom is not a wrong status, it is
 * NO status: Express never answers, so an unbounded request would hang the
 * suite rather than fail it. `NO RESPONSE` is the red signal.
 */
async function statusWithin(ms: number, req: request.Test): Promise<number | 'NO RESPONSE'> {
  return Promise.race([
    req.then((r) => r.status).catch(() => 'NO RESPONSE' as const),
    new Promise<'NO RESPONSE'>((r) => setTimeout(() => r('NO RESPONSE'), ms)),
  ]);
}

describe('a rejecting async handler is answered, not left to kill the process', () => {
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    errSpy.mockRestore();
  });

  // The property, on a minimal app: this is what Express 4 does not do by itself.
  it('a bare async handler that throws gets a 500 rather than hanging', async () => {
    const app = express();
    app.get('/boom', async () => {
      throw new Error('db is down');
    });

    expect(await statusWithin(2000, request(app).get('/boom'))).toBe(500);
  });

  // The same property on a real route that had unguarded awaits.
  it('GET /provider-connections answers 500 when the pool rejects', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    const status = await statusWithin(
      2000,
      request(app).get('/provider-connections').set('Authorization', `Bearer ${userToken}`)
    );

    expect(status).toBe(500);
  });

  // routes/chat.ts's browser actions reach the pool through a shared helper whose
  // first two awaits are outside its try, so the rejection surfaces in the handler.
  it('POST /chat/threads/:id/browser-click answers 500 when the pool rejects', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
    const status = await statusWithin(
      2000,
      request(app)
        .post('/chat/threads/thread-1/browser-click')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ x_percent: 10, y_percent: 20 })
    );

    expect(status).toBe(500);
  });
});
