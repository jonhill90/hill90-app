/**
 * An SSE client that stops reading must not be buffered without limit.
 *
 * THE DEFECT, established by measurement before anything was changed: across
 * services/api there were 18 `res.write(` call sites in non-test code, NONE of
 * which consulted the return value, and no `'drain'` listener,
 * `writableNeedDrain` or `writableLength` check anywhere in the service.
 *
 *     grep -rn "res\\.write(" src/ | grep -v __tests__ | wc -l      ->  18
 *     grep -rnE "(=|if \\(|return )\\s*res\\.write\\(" src/          ->  none
 *     grep -rnE "\\.on\\('drain'|writableNeedDrain|writableLength"   ->  none
 *
 * `res.write()` returns false when the socket buffer is full, and Node keeps
 * buffering in memory if you write anyway. The highest-volume case is
 * /agents/:id/events?follow=true, which relays a container's `tail -f` line by
 * line — the producer is an agent, and it does not slow down because a browser
 * did.
 *
 * THE TEST DRIVES A REAL STALLED CLIENT. It connects over raw http, reads the
 * headers, then stops reading and lets the socket fill while the fake container
 * pushes megabytes. The assertion is that the SOURCE was paused: that is the
 * difference between backpressure and buffering, and it is observable from the
 * fake's own pause() being called. Asserting "the process did not grow" would
 * be a heap measurement and a flake.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { Readable } from 'stream';
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
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

const mockExecInContainer = jest.fn();
const mockGetContainerLogs = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: (...args: unknown[]) => mockGetContainerLogs(...args),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args),
}));

const userToken = jwt.sign(
  { sub: 'owner-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

const adminToken = jwt.sign(
  { sub: 'admin-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

/**
 * A chatty container: complete JSON lines, pushed as fast as they are taken,
 * with pause/resume observable.
 */
function chattyContainer() {
  let pushed = 0;
  const line = `{"id":"${'x'.repeat(400)}","type":"log"}\n`;
  const s: Readable & { paused?: boolean; pushedBytes?: number } = new Readable({
    read() {
      if (pushed > 40 * 1024 * 1024) {
        this.push(null);
        return;
      }
      pushed += line.length;
      s.pushedBytes = pushed;
      this.push(line);
    },
  }) as Readable & { paused?: boolean; pushedBytes?: number };
  s.paused = false;
  s.pushedBytes = 0;
  const realPause = s.pause.bind(s);
  const realResume = s.resume.bind(s);
  s.pause = () => { s.paused = true; return realPause(); };
  s.resume = () => { s.paused = false; return realResume(); };
  return s;
}

/**
 * A chatty container LOG stream: Docker's multiplexed frame format (an 8-byte
 * header — stream type, 3 bytes padding, big-endian uint32 payload size —
 * ahead of each payload), which /:id/logs's stripDockerHeader() expects.
 * Same pause/resume observability as chattyContainer() above.
 */
function dockerFrame(line: string): Buffer {
  const payload = Buffer.from(line, 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0); // stdout
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function chattyLogContainer() {
  let pushed = 0;
  const frame = dockerFrame(`{"id":"${'x'.repeat(400)}","type":"log"}\n`);
  const s: Readable & { paused?: boolean; pushedBytes?: number } = new Readable({
    read() {
      if (pushed > 40 * 1024 * 1024) {
        this.push(null);
        return;
      }
      pushed += frame.length;
      s.pushedBytes = pushed;
      this.push(frame);
    },
  }) as Readable & { paused?: boolean; pushedBytes?: number };
  s.paused = false;
  s.pushedBytes = 0;
  const realPause = s.pause.bind(s);
  const realResume = s.resume.bind(s);
  s.pause = () => { s.paused = true; return realPause(); };
  s.resume = () => { s.paused = false; return realResume(); };
  return s;
}

let server: http.Server;
let port: number;

beforeEach(async () => {
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

  const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  delete process.env.DATABASE_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('SSE backpressure', () => {
  it('pauses the container stream when the client stops reading', async () => {
    const container = chattyContainer();
    mockExecInContainer.mockResolvedValue(container);

    await new Promise<void>((resolve, reject) => {
      // Cleared as soon as the promise settles by any path — left armed for
      // its full 8s otherwise, holding the event loop open well past this
      // test's own end (caught by --detectOpenHandles: a Timeout rooted
      // here, not in the route).
      const noHeadersTimer = setTimeout(() => reject(new Error('no response headers')), 8000);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/agents/agent-uuid/events?follow=true',
          headers: { Authorization: `Bearer ${userToken}` },
        },
        (res) => {
          // Headers received, then deliberately stop reading: no 'data' handler
          // and the socket paused, so the kernel and the server's write buffer
          // fill exactly as they would for a stalled browser.
          clearTimeout(noHeadersTimer);
          res.pause();
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 2500);
        },
      );
      req.on('error', () => { clearTimeout(noHeadersTimer); resolve(); });
      req.end();
    });

    // The claim: the producer was told to wait. Before this change nothing
    // consulted res.write()'s result, so it never was.
    expect(container.paused).toBe(true);
  }, 20000);

  // /:id/logs?follow=true was the one live streaming data path left using a
  // raw res.write() after the sweep above fixed its sibling — same defect,
  // same fix. sse-writer.test.ts already pins the underlying rule (a false
  // write pauses the source, nothing further is written until 'drain', an
  // overflow refuses rather than queuing more); this proves the ROUTE is
  // actually wired to that mechanism rather than writing straight to `res`.
  // A test that just read this stream to completion would pass against the
  // unfixed route too, since it also delivers the log lines successfully —
  // it just also buffers them all in this process's memory for a client
  // that has stopped reading, which is exactly what does not show up in a
  // "did the client eventually get the data" assertion.
  it('pauses the container LOG stream when the client stops reading', async () => {
    const container = chattyLogContainer();
    mockGetContainerLogs.mockResolvedValue(container);

    await new Promise<void>((resolve, reject) => {
      // Same leak-guard cleanup as the /:id/events test above — see its
      // comment for why the timer has to be cleared rather than left to
      // fire out its full 8s on the happy path.
      const noHeadersTimer = setTimeout(() => reject(new Error('no response headers')), 8000);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/agents/agent-uuid/logs?follow=true',
          headers: { Authorization: `Bearer ${adminToken}` },
        },
        (res) => {
          // Headers received, then deliberately stop reading — same stalled-
          // client shape as the /:id/events test above, applied to /:id/logs.
          clearTimeout(noHeadersTimer);
          res.pause();
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 2500);
        },
      );
      req.on('error', () => { clearTimeout(noHeadersTimer); resolve(); });
      req.end();
    });

    // THE ASSERTION THAT MATTERS: the producer was told to wait, not that
    // the stream delivered — raw res.write() delivers too, right up until
    // it silently buffers without limit.
    expect(container.paused).toBe(true);
  }, 20000);
});
