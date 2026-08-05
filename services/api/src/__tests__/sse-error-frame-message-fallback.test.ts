/**
 * The SSE `event: error` frames in `GET /:id/events?follow=true` and
 * `GET /:id/logs?follow=true` wrote `err.message` directly into the wire
 * frame: `res.write(\`event: error\ndata: ${err.message}\n\n\`)`.
 *
 * THE DEFECT, and why it is the highest-priority instance of this sweep's
 * finding: this is the only place in the pattern with a USER-VISIBLE
 * consequence rather than a persisted or response-body one. `stream.on(
 * 'error', (err: Error) => ...)` is typed `Error` by the Node Readable
 * contract, but nothing enforces that at runtime — an exec/log stream can
 * emit any value on 'error' — and the surrounding `catch (err: any)` around
 * the whole try block accepts a non-Error rejection outright. Either way,
 * `err.message` on a value with no `.message` is `undefined`, and the
 * frame's `data:` line becomes the literal text "undefined" — a client
 * rendering that error frame shows the user a broken error instead of an
 * error, with no way to tell "undefined" the string from a genuine error
 * whose message happens to be the word undefined.
 *
 * WHAT THIS TEST PROVES. That both call sites, in both routes, write a
 * real, non-"undefined" string when the underlying failure carries no
 * `.message`. It does not test the byte-cap error frame a few lines above
 * (`event: error` with a JSON-encoded body) — that one already builds its
 * own message text and was never at risk.
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

const adminToken = jwt.sign(
  { sub: 'owner-user', resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

let server: http.Server;
let port: number;

/** Reads the raw HTTP response body as text, resolving once the socket ends. */
function readBody(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${adminToken}` } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString('utf-8'); });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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

describe('GET /:id/events?follow=true SSE error frame', () => {
  it('THE ASSERTION THAT MATTERS: a stream error with no .message does not write the literal text "undefined"', async () => {
    const stream = new Readable({ read() { /* nothing */ } });
    mockExecInContainer.mockResolvedValue(stream);

    const bodyPromise = readBody('/agents/agent-uuid/events?follow=true');
    // Give the route time to attach its 'error' listener before it fires.
    await new Promise((r) => setTimeout(r, 50));
    // A value with no .message at all — the runtime gap TypeScript's
    // `(err: Error)` annotation does not close.
    stream.emit('error', { code: 'ESTREAMFAIL' });

    const body = await bodyPromise;
    expect(body).toContain('event: error');
    expect(body).not.toMatch(/data: undefined\n/);
  }, 10000);

  it('a rejection from execInContainer itself does not write the literal text "undefined"', async () => {
    mockExecInContainer.mockRejectedValue({ code: 'ENOEXEC' });

    const body = await readBody('/agents/agent-uuid/events?follow=true');

    expect(body).toContain('event: error');
    expect(body).not.toMatch(/data: undefined\n/);
  }, 10000);
});

describe('GET /:id/logs?follow=true SSE error frame', () => {
  it('THE ASSERTION THAT MATTERS: a stream error with no .message does not write the literal text "undefined"', async () => {
    const stream = new Readable({ read() { /* nothing */ } });
    mockGetContainerLogs.mockResolvedValue(stream);

    const bodyPromise = readBody('/agents/agent-uuid/logs?follow=true');
    await new Promise((r) => setTimeout(r, 50));
    stream.emit('error', { code: 'ESTREAMFAIL' });

    const body = await bodyPromise;
    expect(body).toContain('event: error');
    expect(body).not.toMatch(/data: undefined\n/);
  }, 10000);

  it('a rejection from getContainerLogs itself does not write the literal text "undefined"', async () => {
    mockGetContainerLogs.mockRejectedValue({ code: 'ENOEXEC' });

    const body = await readBody('/agents/agent-uuid/logs?follow=true');

    expect(body).toContain('event: error');
    expect(body).not.toMatch(/data: undefined\n/);
  }, 10000);
});
