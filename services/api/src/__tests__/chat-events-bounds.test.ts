/**
 * GET /chat/threads/:id/events carried both defects already fixed on the agents
 * route — and multiplied them by the number of agents in the thread.
 *
 * app#141 put a ceiling on `?tail=` for /agents/:id/events, and app#143 bounded
 * that read in bytes. The sibling in chat.ts was left as it was:
 *
 *     const tail = Number.isNaN(parsedTail) ? 20 : Math.max(0, parsedTail);   // floor, no ceiling
 *     ...
 *     for (const agent of runningAgents) {                                     // up to 8 per thread
 *       stream.on('data', (chunk) => chunks.push(chunk));                      // no byte cap
 *       ... Buffer.concat(chunks).toString('utf-8')
 *     }
 *
 * So one request from any thread participant could ask for the whole event log
 * of every running agent in the thread at once — MAX_AGENTS_PER_GROUP is 8 —
 * and hold all of it in memory twice. app-api declares no mem_limit (issue #144).
 *
 * That the fix landed on one route and not its twin is the same drift app#141
 * itself was: the export endpoint had the clamp and the events endpoint did not.
 * The bound now lives in one shared module so there is no second copy to miss.
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

const MAX_TAIL = 5000;
const CAP_BYTES = 2 * 1024 * 1024;

/** One line, longer than the byte cap, never terminated. */
function oversizedLineStream(totalBytes = CAP_BYTES * 2) {
  let sent = 0;
  const s: Readable & { pushed?: number } = new Readable({
    read() {
      if (sent >= totalBytes) { this.push(null); return; }
      const n = Math.min(64 * 1024, totalBytes - sent);
      sent += n;
      s.pushed = sent;
      this.push(Buffer.alloc(n, 0x61));
    },
  });
  s.pushed = 0;
  return s;
}

const smallStream = () =>
  Readable.from([Buffer.from(JSON.stringify({ id: 'e1', correlation_id: 'msg-1' }) + '\n')]);

/** Two running agents in the thread, so the per-agent loop is exercised. */
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
    if (/SELECT id FROM chat_messages WHERE thread_id/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'msg-1' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

/** The `-n` values handed to `tail`, one per agent. */
const tailArgs = () =>
  mockExecInContainer.mock.calls.map((c) => {
    const argv = c[1] as string[];
    return Number(argv[argv.indexOf('-n') + 1]);
  });

describe('GET /chat/threads/:id/events is bounded', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    threadWithTwoRunningAgents();
    // A fresh stream per call: a Readable is consumed once, and the route reads
    // one per agent. Returning the same instance twice hangs the second read.
    mockExecInContainer.mockImplementation(() => Promise.resolve(smallStream()));
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('clamps an absurd tail, for every agent in the thread', async () => {
    await request(app)
      .get('/chat/threads/thread-1/events?tail=999999999')
      .set('Authorization', `Bearer ${userToken}`);

    const args = tailArgs();
    expect(args.length).toBe(2); // the loop ran per agent, which is the multiplier
    for (const n of args) expect(n).toBeLessThanOrEqual(MAX_TAIL);
  });

  it('refuses an oversized log with 413 rather than buffering it', async () => {
    mockExecInContainer.mockImplementation(() => Promise.resolve(oversizedLineStream()));

    const res = await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).toMatch(/too large|limit/i);
  });

  it('stops reading at the cap instead of draining the whole stream', async () => {
    // Fresh stream per agent, but keep the first — it is the one the cap must
    // interrupt. Sharing one instance across both agents hangs the second read.
    const created: Array<Readable & { pushed?: number }> = [];
    mockExecInContainer.mockImplementation(() => {
      const s = oversizedLineStream();
      created.push(s);
      return Promise.resolve(s);
    });

    await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${userToken}`);

    // A cap checked after the bytes are in memory is not a cap.
    expect(created[0].pushed).toBeLessThan(CAP_BYTES * 2);
  });

  it('does not read from later agents once it has refused', async () => {
    mockExecInContainer.mockImplementation(() => Promise.resolve(oversizedLineStream()));

    await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${userToken}`);

    // The multiplier is the point: refusing must stop the loop, not repeat
    // per agent.
    expect(mockExecInContainer.mock.calls.length).toBe(1);
  });

  // Guard rails.
  it('leaves the default of 20 alone', async () => {
    await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${userToken}`);

    for (const n of tailArgs()) expect(n).toBe(20);
  });

  it('still returns events for an ordinary request', async () => {
    const res = await request(app)
      .get('/chat/threads/thread-1/events?tail=50')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
