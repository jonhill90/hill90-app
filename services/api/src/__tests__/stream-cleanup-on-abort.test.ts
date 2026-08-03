/**
 * A client that aborts while `execInContainer` is still pending must not leave a
 * stream nobody owns.
 *
 * THE DEFECT. All three container-stream routes registered the close-listener that
 * destroys the stream AFTER the await that creates it:
 *
 *   agents.ts  /:id/events?follow=true   stream awaited, listener ~113 lines later
 *   agents.ts  /:id/logs?follow=true     stream awaited, listener ~21 lines later
 *   chat.ts    /threads/:id/events       stream awaited PER AGENT, listener after the loop
 *
 * Node emits 'close' once and does not replay it. A client that goes away during
 * that await — an ordinary page navigation — is therefore observed by nobody: the
 * listener attached afterwards never fires, and `tail -f` keeps running inside the
 * container for the life of this process. `res.destroyed` is true by then so the
 * data handlers discard, which is why this never showed up as memory growth or as
 * a failure; it shows up as docker exec sessions that accumulate.
 *
 * TWO CONDITIONS, TESTED SEPARATELY BECAUSE NEITHER CLOSES THE HOLE ALONE:
 *
 *   1. Register cleanup BEFORE the await, and re-check `closed` AFTER it. Only the
 *      second half can destroy a stream that did not exist when cleanup ran.
 *   2. In chat.ts, check `closed` at the TOP OF EACH ITERATION. Destroying eight
 *      streams that should never have been opened is a leak fixed and the work
 *      still wasted.
 *
 * Condition 2 needs its own scenario to be provable in isolation: an abort DURING
 * an exec is already caught by condition 1's post-await check, which breaks. The
 * case only condition 2 can catch is an exec that REJECTS after the client has
 * gone — the loop's inner `catch` swallows that and iteration continues.
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
  { sub: 'owner-user', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
);

/** A live `tail -f`: never ends on its own, and reports whether it was destroyed. */
const liveTail = () => new Readable({ read() { /* nothing until destroyed */ } });

/**
 * An exec whose Nth call is held open until the test releases it. Everything the
 * route awaits before that point resolves normally.
 */
function gatedExec() {
  const gates: Array<{ resolve: (s: Readable) => void; reject: (e: Error) => void }> = [];
  const opened: Readable[] = [];
  mockExecInContainer.mockImplementation(
    () =>
      new Promise<Readable>((resolve, reject) => {
        gates.push({
          resolve: (s: Readable) => { opened.push(s); resolve(s); },
          reject,
        });
      }),
  );
  return { gates, opened };
}

let server: http.Server;
let port: number;

/** Fires the request, waits until the route is inside the exec, then aborts it. */
async function abortDuringExec(path: string, gates: unknown[]) {
  const req = http.request({ host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${userToken}` } });
  req.on('error', () => { /* the abort itself */ });
  req.end();

  const deadline = Date.now() + 5000;
  while (gates.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (gates.length === 0) throw new Error('route never reached execInContainer');

  req.destroy();
  // Let the server observe 'close' before the exec settles. This ordering IS the
  // defect: cleanup runs while the stream does not yet exist.
  await new Promise((r) => setTimeout(r, 120));
}

const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(async () => {
  mockQuery.mockReset();
  mockExecInContainer.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

  const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  delete process.env.DATABASE_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('CONDITION 1: a stream created after the client left is destroyed', () => {
  beforeEach(() => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agents WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ agent_id: 'agent-1', status: 'running' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('agents /:id/events?follow=true destroys a tail -f opened after the abort', async () => {
    const { gates } = gatedExec();

    await abortDuringExec('/agents/agent-uuid/events?follow=true', gates);

    const stream = liveTail();
    gates[0].resolve(stream);           // the exec finally lands, client long gone
    await settle();

    // Without the post-await check nothing ever destroys this: cleanup already ran,
    // and it ran before the stream existed.
    expect(stream.destroyed).toBe(true);
  }, 20000);
});

describe('CONDITION 1 and 2: the chat thread stream, where the hole multiplies by 8', () => {
  /** A thread with `n` running agents, as MAX_AGENTS_PER_GROUP allows up to 8. */
  function threadWithRunningAgents(n: number) {
    const rows = Array.from({ length: n }, (_, i) => ({
      participant_id: `p${i}`, agent_id: `agent-${i}`, status: 'running',
    }));
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM chat_participants\s+WHERE thread_id/.test(sql)) {
        return Promise.resolve({ rows: [{ '?column?': 1 }] });
      }
      if (/JOIN agents a ON a\.id = cp\.participant_id/.test(sql)) {
        return Promise.resolve({ rows });
      }
      if (/SELECT id FROM chat_messages WHERE thread_id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'msg-1' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('CONDITION 2: STOPS THE LOOP rather than opening the other seven', async () => {
    // The one case condition 1 cannot cover. The client aborts during agent 0's
    // exec and that exec then REJECTS — the loop's inner catch swallows it, so the
    // post-await check is never reached and only the top-of-iteration check can
    // stop agent 1 through 7 being opened for a client that has gone.
    threadWithRunningAgents(8);
    const { gates } = gatedExec();

    await abortDuringExec('/chat/threads/thread-1/events?follow=true', gates);

    gates[0].reject(new Error('container is gone'));
    await settle();

    // What this proves, stated exactly: the loop must not proceed to agent 1.
    // Removing the top-of-iteration check makes this fail with 2, not 8 — the
    // harness's second gate never resolves, so the loop parks there rather than
    // running to the end. It demonstrates that iteration CONTINUED past the point
    // it should have stopped; the figure 8 is what production would reach, not
    // something this test observes.
    expect(mockExecInContainer).toHaveBeenCalledTimes(1);
  }, 20000);

  it('CONDITION 1: destroys the stream that was opened after the abort', async () => {
    threadWithRunningAgents(8);
    const { gates } = gatedExec();

    await abortDuringExec('/chat/threads/thread-1/events?follow=true', gates);

    const stream = liveTail();
    gates[0].resolve(stream);
    await settle();

    expect(stream.destroyed).toBe(true);
    // And having destroyed it, it must not go on to open the rest either.
    expect(mockExecInContainer).toHaveBeenCalledTimes(1);
  }, 20000);

  // Guard rail: a client that stays must still get all of its agents' streams, or
  // the two checks have simply broken the feature.
  it('opens every running agent for a client that is still there', async () => {
    threadWithRunningAgents(3);
    mockExecInContainer.mockImplementation(() => Promise.resolve(liveTail()));

    const req = http.request({
      host: '127.0.0.1', port,
      path: '/chat/threads/thread-1/events?follow=true',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    req.on('error', () => {});
    req.end();

    const deadline = Date.now() + 5000;
    while (mockExecInContainer.mock.calls.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mockExecInContainer).toHaveBeenCalledTimes(3);
    req.destroy();
    await settle();
  }, 20000);
});
