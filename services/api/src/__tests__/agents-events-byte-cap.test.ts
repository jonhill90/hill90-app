/**
 * Reading an agent's event log must be bounded in BYTES, not only in lines.
 *
 * app#141 clamped `?tail=` to 5000, which bounds how many lines are requested.
 * It does not bound how long a line is. Anything that can write one enormous
 * line to /var/log/agentbox/events.jsonl — the agent itself, which runs
 * model-driven code — could still make the API read it whole:
 *
 *   const chunks: Buffer[] = [];
 *   stream.on('data', (chunk) => chunks.push(chunk));      // no ceiling
 *   ... Buffer.concat(chunks).toString('utf-8')            // and then again, as a string
 *
 * The streaming path had the same hole in a different shape: `buffer` holds the
 * trailing incomplete line, so a line that never ends never stops growing.
 *
 * THE CAP IS ENFORCED DURING THE READ, NOT AFTER IT. A limit checked once the
 * bytes are already in memory is not a limit — the process has already paid for
 * them. These tests assert the stream is destroyed when the cap trips, which is
 * the observable difference between stopping and merely complaining afterwards.
 * The pattern is the one services/knowledge/app/services/web_page_fetcher.py
 * already uses for HTTP bodies: count as you go, abort on exceed.
 *
 * WHAT THE CALLER SEES. An explicit failure, never a short read dressed up as a
 * complete one: 413 with a message naming the limit on the JSON endpoints, and
 * an `event: error` frame on the SSE stream. A truncated array that looks whole
 * would be a silent-success defect of exactly the kind this repository keeps
 * finding.
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
const mockGetContainerLogs = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: (...args: any[]) => mockGetContainerLogs(...args),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: (...args: any[]) => mockExecInContainer(...args),
}));

function token(roles: string[]) {
  return jwt.sign(
    { sub: 'owner-user', resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
  );
}
const userToken = token(['user']);
const adminToken = token(['admin', 'user']);

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

/** The cap under test. Matches web_page_fetcher.py's MAX_RESPONSE_BYTES. */
const CAP = 2 * 1024 * 1024;

/**
 * One line, far longer than the cap, delivered in chunks and never terminated.
 * `pushed` counts what the stream actually handed over, so a test can tell
 * whether the reader stopped early or drank the whole thing.
 */
function oversizedLineStream(totalBytes = CAP * 3) {
  const CHUNK = 64 * 1024;
  let sent = 0;
  const s: any = new Readable({
    read() {
      if (sent >= totalBytes) {
        this.push(null);
        return;
      }
      const n = Math.min(CHUNK, totalBytes - sent);
      sent += n;
      s.pushed = sent;
      this.push(Buffer.alloc(n, 0x61)); // 'a' — deliberately no newline
    },
  });
  s.pushed = 0;
  s.destroyedByReader = false;
  const realDestroy = s.destroy.bind(s);
  s.destroy = (...args: any[]) => {
    s.destroyedByReader = true;
    return realDestroy(...args);
  };
  return s;
}

function smallLogStream() {
  return Readable.from([
    Buffer.from(JSON.stringify({ id: 'e1', timestamp: '2026-08-03T00:00:00Z', type: 'x' }) + '\n'),
  ]);
}

describe('the agent event read is bounded in bytes, incrementally', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    mockGetContainerLogs.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agents WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ agent_id: 'agent-1', status: 'running' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /events refuses an oversized log with 413 rather than buffering it', async () => {
    const stream = oversizedLineStream();
    mockExecInContainer.mockResolvedValue(stream);

    const res = await request(app)
      .get('/agents/agent-uuid/events')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).toMatch(/too large|limit/i);
  });

  it('GET /events STOPS READING at the cap instead of checking afterwards', async () => {
    const stream = oversizedLineStream();
    mockExecInContainer.mockResolvedValue(stream);

    await request(app)
      .get('/agents/agent-uuid/events')
      .set('Authorization', `Bearer ${userToken}`);

    // The difference between a cap and a post-mortem: the reader must have hung
    // up. If it drank all 6 MB and complained after, `pushed` would be the whole
    // stream and nothing would have been destroyed.
    expect(stream.destroyedByReader).toBe(true);
    expect(stream.pushed).toBeLessThan(CAP * 2);
  });

  it('the SSE stream reports an explicit error frame, not a silent stall', async () => {
    const stream = oversizedLineStream();
    mockExecInContainer.mockResolvedValue(stream);

    const res = await request(app)
      .get('/agents/agent-uuid/events?follow=true')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.text).toMatch(/event: error/);
    expect(res.text).toMatch(/too large|limit/i);
  });

  it('GET /events/export refuses an oversized log with 413', async () => {
    const stream = oversizedLineStream();
    mockExecInContainer.mockResolvedValue(stream);

    const res = await request(app)
      .get('/agents/agent-uuid/events/export')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(413);
  });

  it('GET /logs refuses an oversized log with 413', async () => {
    const stream = oversizedLineStream();
    mockGetContainerLogs.mockResolvedValue(stream);

    const res = await request(app)
      .get('/agents/agent-uuid/logs')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(413);
  });

  // Guard rails: the cap must not change an ordinary read.
  it('an ordinary log still returns 200', async () => {
    mockExecInContainer.mockResolvedValue(smallLogStream());

    const res = await request(app)
      .get('/agents/agent-uuid/events')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
