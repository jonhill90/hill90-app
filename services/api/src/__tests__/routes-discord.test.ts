/**
 * app#508. A Discord channel binding used to be entirely DB-backed: a real
 * row, a 201, and nothing anywhere signalling that the Discord bot has no
 * deployed container to ever act on the binding — an operation that
 * succeeds while accomplishing nothing, the estate's own defect family at
 * product level. Verified against the live host (2026-08-06): no
 * discord-bot container exists at all, running or stopped, and the deploy
 * pipeline does not build or start one.
 *
 * SECOND HALF OF THE FIX, and the reason this file changed shape rather than
 * just gaining tests: the first version warned on a 201 whenever the bot
 * wasn't RUNNING — which treated "confirmed absent, can never work" and
 * "exists but merely stopped, a normal transient" identically. A bot that is
 * down for maintenance is a legitimate binding target; a bot with no
 * container object anywhere is not, and creating a binding for one leaves a
 * row nothing will ever consume. The distinction now drives the response:
 * `absent` is REFUSED before any write (409, nothing left behind); `stopped`
 * and `unknown` still succeed (201) with an informational note, because
 * refusing either would break a legitimate workflow (a bot that's merely
 * down, or a check that could not complete) to fix what is, for that
 * caller, a cosmetic warning.
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

const mockInspectContainerPresence = jest.fn();
jest.mock('../services/docker', () => ({
  inspectContainerPresence: (...args: unknown[]) => mockInspectContainerPresence(...args),
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
const RUNNING = { exists: true, running: true };
const STOPPED = { exists: true, running: false };
const ABSENT = { exists: false, running: false };

beforeEach(() => {
  mockQuery.mockReset();
  mockInspectContainerPresence.mockReset();
});

describe('GET /discord/status distinguishes running, stopped, absent and unknown', () => {
  it('POSITIVE CONTROL: the bot container is actually running', async () => {
    mockInspectContainerPresence.mockResolvedValueOnce(RUNNING);

    const res = await request(app)
      .get('/discord/status')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deployed).toBe(true);
    expect(res.body.status).toBe('ready');
    expect(mockInspectContainerPresence).toHaveBeenCalledWith('app-discord-bot');
  });

  it('THE ASSERTION THAT MATTERS: a token being configured does not mean the bot is deployed', async () => {
    const savedToken = process.env.DISCORD_BOT_SERVICE_TOKEN;
    process.env.DISCORD_BOT_SERVICE_TOKEN = 'a-real-looking-token';
    mockInspectContainerPresence.mockResolvedValueOnce(ABSENT);

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
    expect(res.body.message).toMatch(/no container/i);
  });

  it('a container that EXISTS but is not running is "stopped", not "not_deployed"', async () => {
    // The distinction app#508's second half exists for: this must not read
    // the same as a bot that was never deployed at all.
    mockInspectContainerPresence.mockResolvedValueOnce(STOPPED);

    const res = await request(app)
      .get('/discord/status')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    // deployed: true — a container object exists; this is a legitimate
    // target, just not active right now.
    expect(res.body.deployed).toBe(true);
    expect(res.body.status).toBe('stopped');
    expect(res.body.message).toMatch(/not currently running/i);
    expect(res.body.message).not.toMatch(/never/i);
  });

  it('distinguishes "verified absent" from "could not check"', async () => {
    mockInspectContainerPresence.mockRejectedValueOnce(new Error('docker proxy unreachable'));

    const res = await request(app)
      .get('/discord/status')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deployed).toBe(false);
    expect(res.body.status).toBe('unknown');
    expect(res.body.message).toMatch(/could not verify/i);
  });
});

describe('POST /discord/bindings refuses a bot that cannot ever exist, accepts one that is merely stopped', () => {
  it('THE ASSERTION THAT MATTERS: a confirmed-absent bot is REFUSED — 409, and nothing is written', async () => {
    mockInspectContainerPresence.mockResolvedValueOnce(ABSENT);

    const res = await request(app)
      .post('/discord/bindings')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ channel_id: 'chan-1', guild_id: 'guild-1', agent_id: 'agent-1' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no container/i);
    // Nothing left behind: the write must never have been attempted.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('TWIN: a bot that is merely STOPPED is a legitimate binding target — 201, with an informational note, not a refusal', async () => {
    mockInspectContainerPresence.mockResolvedValueOnce(STOPPED);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'binding-2', channel_id: 'chan-2', guild_id: 'guild-1', agent_id: 'agent-1' }],
    });

    const res = await request(app)
      .post('/discord/bindings')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ channel_id: 'chan-2', guild_id: 'guild-1', agent_id: 'agent-1' });

    // The write really did happen — a stopped bot is not a failure.
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('binding-2');
    expect(res.body.warning).toMatch(/not currently running/i);
    expect(res.body.warning).not.toMatch(/never/i);
  });

  it('a check that could not complete does not block the write either — 201, with a "could not verify" note', async () => {
    mockInspectContainerPresence.mockRejectedValueOnce(new Error('docker proxy unreachable'));
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'binding-3', channel_id: 'chan-3', guild_id: 'guild-1', agent_id: 'agent-1' }],
    });

    const res = await request(app)
      .post('/discord/bindings')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ channel_id: 'chan-3', guild_id: 'guild-1', agent_id: 'agent-1' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('binding-3');
    expect(res.body.warning).toMatch(/could not verify/i);
  });

  it('no warning field at all when the bot is genuinely running', async () => {
    mockInspectContainerPresence.mockResolvedValueOnce(RUNNING);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'binding-4', channel_id: 'chan-4', guild_id: 'guild-1', agent_id: 'agent-1' }],
    });

    const res = await request(app)
      .post('/discord/bindings')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ channel_id: 'chan-4', guild_id: 'guild-1', agent_id: 'agent-1' });

    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
  });
});
