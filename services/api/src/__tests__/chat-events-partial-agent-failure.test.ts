/**
 * GET /chat/threads/:id/events (one-shot, no follow) loops over every running
 * agent in the thread and merges their events into one JSON array. When
 * `execInContainer` fails for a reason OTHER than ReadTooLargeError — a
 * container restart mid-request, an agent whose DB status is stale, a
 * transient network blip to agentbox — the loop caught the error, logged it,
 * and moved on to the next agent:
 *
 *     } catch (err) {
 *       if (err instanceof ReadTooLargeError) { res.status(413)...; return; }
 *       console.error(`[chat-events] Failed to read events from ${agent.agent_id}:`, err);
 *     }
 *     ...
 *     res.json(allEvents);
 *
 * So the caller got a 200 with a JSON array that reads as the thread's
 * complete event history and silently omits every event from the agent whose
 * read failed. This is the same shape agents.ts's own GET /:id/events
 * one-shot path already fixed for its inference-event merge (502 with an
 * explicit detail, "falling through here would hand back a 200 array that
 * looks like the agent's complete event history and silently omits..."), just
 * never propagated to this route's per-agent loop.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

const mockExecInContainer = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args),
}));

const userToken = jwt.sign(
  { sub: 'participant', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const goodStream = () =>
  Readable.from([Buffer.from(JSON.stringify({ id: 'e1', correlation_id: 'msg-1' }) + '\n')]);

function threadWithTwoRunningAgents() {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM chat_participants\s+WHERE thread_id/.test(sql)) {
      return Promise.resolve({ rows: [{ '?column?': 1 }] }); // isParticipant
    }
    if (/JOIN agents a ON a\.id = cp\.participant_id/.test(sql)) {
      return Promise.resolve({
        rows: [
          { participant_id: 'p1', agent_id: 'scout', status: 'running' },
          { participant_id: 'p2', agent_id: 'builder', status: 'running' },
        ],
      });
    }
    if (/SELECT id, seq FROM chat_messages WHERE thread_id = \$1$/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'msg-1', seq: 1 }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('GET /chat/threads/:id/events does not silently drop a failed agent', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    threadWithTwoRunningAgents();
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('does not return 200 with a partial event list when one agent fails to read', async () => {
    // scout succeeds, builder's container exec fails for a reason that is not
    // ReadTooLargeError — a restart, a stale status, a network blip.
    let call = 0;
    mockExecInContainer.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(goodStream());
      return Promise.reject(new Error('container not reachable'));
    });

    const res = await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${userToken}`);

    // The exact defect: a 200 whose body is a bare array reads as the
    // complete history. It must not be that.
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/builder/);
  });

  it('still returns 200 with everything when every agent succeeds', async () => {
    mockExecInContainer.mockImplementation(() => Promise.resolve(goodStream()));

    const res = await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2); // one event from each of the two agents
  });
});
