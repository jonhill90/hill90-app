/**
 * app#508. A Discord channel binding used to be entirely DB-backed: a real
 * row, a 201, and nothing anywhere signalling that the Discord bot has no
 * deployed container to ever act on the binding — an operation that
 * succeeds while accomplishing nothing, the estate's own defect family at
 * product level. Verified against the live host (2026-08-06): no
 * discord-bot container exists at all, running or stopped, and the deploy
 * pipeline does not build or start one.
 *
 * These tests exercise the fix's two write-time and read-time signals:
 * GET /discord/status now checks the real container (not just whether a
 * token is configured), and POST /discord/bindings carries the same
 * warning at the moment of creation, not only on a separate page load.
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
}));

const mockIsContainerRunning = jest.fn();
jest.mock('../services/docker', () => ({
  isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
  );
}

const userToken = makeToken('user-1', ['user']);

beforeEach(() => {
  mockQuery.mockReset();
  mockIsContainerRunning.mockReset();
});

describe('GET /discord/status reports the real container, not just token config', () => {
  it('POSITIVE CONTROL: the bot container is actually running', async () => {
    mockIsContainerRunning.mockResolvedValueOnce(true);

    const res = await request(app)
      .get('/discord/status')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deployed).toBe(true);
    expect(res.body.status).toBe('ready');
    expect(mockIsContainerRunning).toHaveBeenCalledWith('app-discord-bot');
  });

  it('THE ASSERTION THAT MATTERS: a token being configured does not mean the bot is deployed', async () => {
    const savedToken = process.env.DISCORD_BOT_SERVICE_TOKEN;
    process.env.DISCORD_BOT_SERVICE_TOKEN = 'a-real-looking-token';
    mockIsContainerRunning.mockResolvedValueOnce(false);

    const res = await request(app)
      .get('/discord/status')
      .set('Authorization', `Bearer ${userToken}`);

    if (savedToken === undefined) delete process.env.DISCORD_BOT_SERVICE_TOKEN;
    else process.env.DISCORD_BOT_SERVICE_TOKEN = savedToken;

    // A configured token alone must never produce "ready" — this is
    // production's actual state (a token can exist in vault with no bot
    // container ever having existed).
    expect(res.body.configured).toBe(true);
    expect(res.body.deployed).toBe(false);
    expect(res.body.status).toBe('not_deployed');
    expect(res.body.message).toMatch(/no running container/i);
  });

  it('distinguishes "verified not running" from "could not check"', async () => {
    mockIsContainerRunning.mockRejectedValueOnce(new Error('docker proxy unreachable'));

    const res = await request(app)
      .get('/discord/status')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deployed).toBe(false);
    expect(res.body.status).toBe('unknown');
    expect(res.body.message).toMatch(/could not verify/i);
  });
});

describe('POST /discord/bindings carries the same warning at creation time', () => {
  it('THE ASSERTION THAT MATTERS: a real row is still created (201), but with an explicit warning when the bot is not running', async () => {
    mockIsContainerRunning.mockResolvedValueOnce(false);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'binding-1', channel_id: 'chan-1', guild_id: 'guild-1', agent_id: 'agent-1' }],
    });

    const res = await request(app)
      .post('/discord/bindings')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ channel_id: 'chan-1', guild_id: 'guild-1', agent_id: 'agent-1' });

    // The write itself really did succeed — 201 stays honest.
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('binding-1');
    // THE ASSERTION THAT MATTERS: the response also says the binding
    // cannot do anything yet, at the moment the caller most needs to know.
    expect(res.body.warning).toMatch(/no running container/i);
  });

  it('TWIN: no warning field at all when the bot is genuinely running', async () => {
    mockIsContainerRunning.mockResolvedValueOnce(true);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'binding-2', channel_id: 'chan-2', guild_id: 'guild-1', agent_id: 'agent-1' }],
    });

    const res = await request(app)
      .post('/discord/bindings')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ channel_id: 'chan-2', guild_id: 'guild-1', agent_id: 'agent-1' });

    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
  });
});
