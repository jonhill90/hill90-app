/**
 * The thread-event correlation filter refreshes INCREMENTALLY (#216).
 *
 * It used to re-read every message id in the thread every five seconds, per
 * connected client, for the life of the connection — a repeated scan whose
 * cost grew with the thread while the interval stayed fixed. #220 fixed the
 * rebuild; the remaining "memory term" (one full-thread Set per connection,
 * held for its life) is a documented, deliberate tradeoff — see #216.
 *
 * This is a different family from the truncation work: nothing was truncated
 * and no answer was wrong, so there is no "showing N of M" to add. The defect
 * was cost, not correctness — but "the interval is bounded" is a claim about
 * BEHAVIOUR, and the previous version of this file checked it by grepping the
 * route's own source text for `toContain('seq > $2')` / `not.toContain('.clear()')`.
 * That passes as long as those literal substrings exist ANYWHERE in the
 * handler, whether or not they do what the surrounding logic claims — a
 * refresh that queried correctly but never called `.add()` on the results, or
 * one that clamped the watermark to the wrong param, would leave every one of
 * those assertions green. It is a check that reads the code, not one that
 * runs it.
 *
 * These tests instead drive the actual route through a real HTTP request/SSE
 * response, the same way routes-agents-events.test.ts and
 * chat-events-bounds.test.ts already do for this file's siblings, and assert
 * on what a connected client actually receives and what queries the running
 * handler actually issues — not on what the source file contains.
 */
import request from 'supertest';
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
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' },
);

const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

// Real interval, sped up per test — same technique as INFERENCE_POLL_MS in
// routes-agents-events.test.ts. Waiting for the condition, not the clock: see
// waitUntil() below.
const FAST_REFRESH_MS = '20';

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

const REFRESH_SQL = /SELECT id, seq FROM chat_messages WHERE thread_id = \$1 AND seq > \$2/;
const INITIAL_LOAD_SQL = /SELECT id, seq FROM chat_messages WHERE thread_id = \$1/;

/**
 * Routes mockQuery calls by shape. `refreshBatches[n]` is what the nth call
 * to the incremental refresh query returns — after that it repeats empty.
 */
function mockThread({
  initialMessages = [] as Array<{ id: string; seq: number }>,
  refreshBatches = [] as Array<Array<{ id: string; seq: number }>>,
} = {}) {
  let refreshCall = 0;
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    if (/FROM chat_participants\s+WHERE thread_id/.test(sql)) {
      return Promise.resolve({ rows: [{ '?column?': 1 }] }); // isParticipant
    }
    if (/JOIN agents a ON a\.id = cp\.participant_id/.test(sql)) {
      return Promise.resolve({
        rows: [{ participant_id: 'p1', agent_id: 'scout', status: 'running' }],
      });
    }
    if (REFRESH_SQL.test(sql)) {
      const batch = refreshBatches[refreshCall] ?? [];
      refreshCall += 1;
      return Promise.resolve({ rows: batch, __params: params });
    }
    if (INITIAL_LOAD_SQL.test(sql)) {
      return Promise.resolve({ rows: initialMessages });
    }
    return Promise.resolve({ rows: [] });
  });
}

/** Every call that hit the incremental refresh query, with its params. */
function refreshCalls() {
  return mockQuery.mock.calls.filter((c) => REFRESH_SQL.test(c[0] as string));
}

describe('GET /chat/threads/:id/events?follow=true — correlation refresh behaves incrementally (#216)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_EVENTS_REFRESH_MS = FAST_REFRESH_MS;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_EVENTS_REFRESH_MS;
  });

  it('forwards an event correlated to a message that arrives AFTER connect, once the refresh has run', (done) => {
    mockThread({
      initialMessages: [],
      refreshBatches: [[{ id: 'msg-late', seq: 5 }]],
    });

    const controlStream = new PassThrough();
    mockExecInContainer.mockResolvedValueOnce(controlStream);

    const lateEvent = JSON.stringify({ id: 'e1', correlation_id: 'msg-late' });

    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.get(
        `http://127.0.0.1:${port}/chat/threads/thread-1/events?follow=true`,
        { headers: { Authorization: `Bearer ${userToken}` } },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });

          waitUntil(() => refreshCalls().length >= 1, 'the incremental refresh to have run')
            .then(() => {
              // The message only exists in the world AFTER this point — it was
              // not part of the initial load, only of the refresh batch above.
              // If the refresh's rows never make it into threadMessageIds,
              // this event is silently dropped rather than forwarded.
              controlStream.write(`${lateEvent}\n`);
              return waitUntil(() => body.includes(lateEvent), 'the late-correlated event to be forwarded');
            })
            .then(() => {
              expect(body).toContain(lateEvent);
            })
            .catch((err) => { done(err); return; })
            .finally(() => {
              req.destroy();
              controlStream.destroy();
              server.close(() => done());
            });
        },
      );
      req.on('error', (err) => { server.close(); done(err); });
    });
  }, 10000);

  it('keeps matching a message present before connect across several empty refresh ticks (never clears)', (done) => {
    mockThread({
      initialMessages: [{ id: 'msg-early', seq: 1 }],
      refreshBatches: [[], [], []], // nothing new arrives; only staleness would break this
    });

    const controlStream = new PassThrough();
    mockExecInContainer.mockResolvedValueOnce(controlStream);

    const earlyEvent = JSON.stringify({ id: 'e2', correlation_id: 'msg-early' });

    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.get(
        `http://127.0.0.1:${port}/chat/threads/thread-1/events?follow=true`,
        { headers: { Authorization: `Bearer ${userToken}` } },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });

          // Let several empty refreshes tick before emitting — a `.clear()`
          // reintroduced ahead of a query would wipe msg-early and never
          // restore it, since the mocked refresh never returns it again.
          waitUntil(() => refreshCalls().length >= 3, 'three empty refresh ticks to have run')
            .then(() => {
              controlStream.write(`${earlyEvent}\n`);
              return waitUntil(() => body.includes(earlyEvent), 'the early-correlated event to still be forwarded');
            })
            .then(() => {
              expect(body).toContain(earlyEvent);
            })
            .catch((err) => { done(err); return; })
            .finally(() => {
              req.destroy();
              controlStream.destroy();
              server.close(() => done());
            });
        },
      );
      req.on('error', (err) => { server.close(); done(err); });
    });
  }, 10000);

  it('each refresh queries only what is above the watermark it last saw, and the watermark advances', (done) => {
    mockThread({
      initialMessages: [{ id: 'msg-0', seq: 3 }],
      refreshBatches: [
        [{ id: 'msg-1', seq: 10 }],
        [{ id: 'msg-2', seq: 20 }],
      ],
    });

    const controlStream = new PassThrough();
    mockExecInContainer.mockResolvedValueOnce(controlStream);

    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.get(
        `http://127.0.0.1:${port}/chat/threads/thread-1/events?follow=true`,
        { headers: { Authorization: `Bearer ${userToken}` } },
        () => {
          waitUntil(() => refreshCalls().length >= 2, 'two refresh ticks to have run')
            .then(() => {
              const calls = refreshCalls();
              // First tick starts from the watermark set by the initial load.
              expect(calls[0][1]).toEqual(['thread-1', 3]);
              // Second tick starts from the watermark the FIRST tick advanced
              // to (10) — not a re-scan of the whole thread and not stuck at
              // the initial value. This is the actual bound this issue is
              // about, measured from the query the handler issued, not read
              // off its source text.
              expect(calls[1][1]).toEqual(['thread-1', 10]);
            })
            .catch((err) => { done(err); return; })
            .finally(() => {
              req.destroy();
              controlStream.destroy();
              server.close(() => done());
            });
        },
      );
      req.on('error', (err) => { server.close(); done(err); });
    });
  }, 10000);
});

describe('GET /chat/threads/:id/events?follow=true — initial load stays complete', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('matches an event correlated to a pre-existing message immediately, with no refresh needed', async () => {
    mockThread({ initialMessages: [{ id: 'msg-existing', seq: 7 }] });

    const existingEvent = JSON.stringify({ id: 'e3', correlation_id: 'msg-existing' });
    mockExecInContainer.mockResolvedValueOnce(
      require('stream').Readable.from([Buffer.from(`${existingEvent}\n`)]),
    );

    const res = await request(app)
      .get('/chat/threads/thread-1/events')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('msg-existing');
  });
});
