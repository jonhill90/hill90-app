/**
 * app#443, agents.ts's `GET /:id/events?follow=true` inference poll. This
 * catch used to be silent — the client saw only heartbeats for as long as
 * `getRecentInference` kept failing, no different from a genuinely quiet
 * agent — and was inconsistent with this SAME route's one-shot branch, which
 * 502s explicitly when the identical query fails.
 *
 * global.setInterval is mocked to capture the tick function rather than
 * relying on FAST_POLL_MS + real wall-clock waits (the convention in
 * routes-agents-events.test.ts): failureThresholdFor(pollMs) at the default
 * 3000ms cadence is 4, and a real-timer test would need to actually wait
 * ~12s per direction to exercise it. Same http.get + app.listen() connection
 * technique as that file, since an open SSE stream never completes for
 * supertest's request().
 */
import * as http from 'http';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PassThrough } from 'stream';
import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const AGENT_UUID = '550e8400-e29b-41d4-a716-446655440000';

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

jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn().mockReturnValue('/data/agentbox/test-agent'),
  removeAgentFiles: jest.fn(),
}));

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

const userToken = jwt.sign(
  { sub: 'regular-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
);

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

function mockRunningAgent() {
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
  });
}

describe('agents.ts /:id/events inference poll failure signal', () => {
  let capturedIntervals: Array<{ fn: () => any; ms: number }>;
  let server: http.Server;
  let clientReq: http.ClientRequest | undefined;
  let body: string;

  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    capturedIntervals = [];
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms?: any) => {
      capturedIntervals.push({ fn, ms });
      return {} as any;
    }) as any);
    jest.spyOn(global, 'clearInterval').mockImplementation((() => {}) as any);
    body = '';
    clientReq = undefined;
  });

  afterEach((done) => {
    jest.restoreAllMocks();
    delete process.env.DATABASE_URL;
    // The client's SSE connection is still open (this suite exists to prove
    // the stream deliberately stays open on a poll failure), so server.close()
    // never calls back on its own — it waits for every connection to end.
    clientReq?.destroy();
    if (server) server.close(() => done());
    else done();
  });

  async function connect(): Promise<{ pollTick: { fn: () => any; ms: number } }> {
    mockRunningAgent();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // backfill inference: no rows

    const controlStream = new PassThrough();
    mockExecInContainer.mockResolvedValueOnce(controlStream);

    return new Promise((resolve, reject) => {
      server = app.listen(0, () => {
        const port = (server.address() as any).port;
        const req = http.get(
          `http://127.0.0.1:${port}/agents/${AGENT_UUID}/events?follow=true&tail=50`,
          { headers: { Authorization: `Bearer ${userToken}` } },
          (res) => {
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          },
        );
        clientReq = req;
        req.on('error', () => { /* destroyed deliberately in afterEach */ });

        waitUntil(() => capturedIntervals.some((i) => i.ms === 3000), 'the inference poll interval to be armed')
          .then(() => resolve({ pollTick: capturedIntervals.find((i) => i.ms === 3000)! }))
          .catch(reject);
      });
    });
  }

  function errorFrames() {
    return body
      .split('\n\n')
      .filter((f) => f.startsWith('event: error'))
      .map((f) => JSON.parse(f.split('data: ')[1].trim()));
  }

  // POSITIVE CONTROL, direction one: sustained failure. Default cadence is
  // 3000ms, so failureThresholdFor(3000) = ceil(10000/3000) = 4.
  it('a poll that keeps failing emits the error frame within the stated bound (4 consecutive 3s failures)', async () => {
    const { pollTick } = await connect();

    for (let i = 0; i < 3; i++) {
      mockQuery.mockRejectedValueOnce(new Error('db down'));
      await pollTick.fn();
      await new Promise((r) => setImmediate(r));
    }
    expect(errorFrames()).toHaveLength(0); // 3 failures, below threshold 4

    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await pollTick.fn();
    await new Promise((r) => setImmediate(r));

    const frames = errorFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0].error).toBe('Updates may be delayed');
  });

  // POSITIVE CONTROL, direction two: one transient blip, then recovery.
  it('one failed poll followed by a successful one emits nothing', async () => {
    const { pollTick } = await connect();

    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await pollTick.fn();
    await new Promise((r) => setImmediate(r));

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await pollTick.fn();
    await new Promise((r) => setImmediate(r));

    expect(errorFrames()).toHaveLength(0);
  });

  it('does not end the stream — inconsistent-looking with the one-shot 502, but deliberate: recoverable vs not', async () => {
    const { pollTick } = await connect();

    for (let i = 0; i < 4; i++) {
      mockQuery.mockRejectedValueOnce(new Error('db down'));
      await pollTick.fn();
      await new Promise((r) => setImmediate(r));
    }

    expect(errorFrames()).toHaveLength(1);

    // Still open: a subsequent successful poll still delivers data normally.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'row-1', agent_id: 'test-agent', model_name: 'gpt-4o-mini',
        request_type: 'chat.completion', status: 'success', latency_ms: 1,
        input_tokens: 1, output_tokens: 1, cost_usd: '0.01',
        created_at: new Date('2026-03-08T12:00:10Z'),
      }],
    });
    await pollTick.fn();
    await new Promise((r) => setImmediate(r));

    expect(body).toContain('"id":"inference-row-1"');
  });
});
