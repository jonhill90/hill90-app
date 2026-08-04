/**
 * Removing a participant must end their in-flight streams (issue #196).
 *
 * Participation was checked once, at connect. app#156 armed a deadline on the
 * token's `exp`, so EXPIRY ended a stream — REVOCATION did not. Remove someone
 * from a thread while their terminal or event stream was open and it kept
 * delivering until their token happened to expire: the system reported the removal
 * succeeded while the thing it was meant to stop carried on.
 *
 * The re-check rides the timers that already exist — `PING_INTERVAL_MS` in the
 * terminal proxy, the 30s heartbeats on the two SSE routes — so these use fake
 * timers and advance them, which makes the assertion about a DECISION rather than
 * a race against a wall clock.
 *
 * THE SECURITY PROPERTY IS THE INTERVAL: worst case ~30s plus one query
 * round-trip between the removal committing and the stream closing. Not immediate.
 *
 * FAIL CLOSED is tested separately and deliberately. It is the branch most likely
 * to be quietly wrong, because the "allowed" path is the one anyone exercises by
 * hand: a check that treats "I could not tell" as "allowed" looks identical in
 * every manual test and differs only when the database is unhappy.
 */
import { stillAuthorised, endStreamForRevokedAccess } from '../helpers/participation-watch';

describe('stillAuthorised — the shared policy', () => {
  it('allows a viewer who is still a participant', async () => {
    await expect(stillAuthorised(async () => true, 'test')).resolves.toBe(true);
  });

  it('refuses a viewer who has been removed', async () => {
    await expect(stillAuthorised(async () => false, 'test')).resolves.toBe(false);
  });

  it('FAILS CLOSED when the participation query throws', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const allowed = await stillAuthorised(async () => {
        throw new Error('remaining connection slots are reserved');
      }, 'test');

      // "I could not tell" must not mean "allowed".
      expect(allowed).toBe(false);
      // And it must be visible, or a database that is always unhappy becomes a
      // service that always disconnects, silently.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('fails closed on a rejected promise as well as a thrown error', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        stillAuthorised(() => Promise.reject(new Error('timeout')), 'test'),
      ).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('endStreamForRevokedAccess', () => {
  it('tells the client why before ending, rather than going quiet', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const written: string[] = [];
      const res = { write: (c: string) => written.push(c), end: jest.fn() };

      endStreamForRevokedAccess(res, 'chat-events');

      // A stream that stops without saying anything is indistinguishable from a
      // network blip, which is the one failure the user cannot act on.
      expect(written.join('')).toMatch(/Access revoked/);
      expect(written.join('')).toMatch(/no longer a participant/);
      expect(res.end).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

/*
 * The wiring, not just the policy. The three call sites each had to put the check
 * inside an existing timer and end the stream — a unit test of `stillAuthorised`
 * proves the decision and nothing about whether anyone consults it.
 *
 * Fake timers make this a statement about the tick rather than a 30-second wait.
 * They fake timers only, not sockets, so supertest's real I/O still works: the
 * request stays pending until the route ends the response, which is exactly the
 * event under test.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../app');

const userToken = jwt.sign(
  { sub: 'viewer', resource_access: { 'hill90-ui': { roles: ['user'] } } },
  privateKey,
  { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' },
);

describe('the chat message stream ends when participation is revoked', () => {
  let participant = true;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockQuery.mockReset();
    participant = true;
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM chat_participants/.test(sql)) {
        return Promise.resolve({ rows: participant ? [{ '?column?': 1 }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.DATABASE_URL;
  });

  it('closes on the next heartbeat after the viewer is removed', async () => {
    const app = createApp({ issuer: TEST_ISSUER, getSigningKey: async () => publicKey });

    // `.then()` is what SENDS it. supertest defers until the Test is awaited or
    // chained, so building the request and revoking access before awaiting would
    // have tested a non-participant receiving 404 — a different fact, and one that
    // passes whether or not any re-check exists. The first version of this test
    // did exactly that, and the mock proved it: `participant flag: false` at the
    // INITIAL check.
    const pending = request(app)
      .get('/chat/threads/thread-1/stream')
      .set('Authorization', `Bearer ${userToken}`)
      .then((r) => r);

    // Wait on the CONDITION, not the clock: the request is real I/O and fake
    // timers do not advance it. docs/decisions/api-suite-flakiness.md prescribes
    // exactly this — poll until the handler has actually queried — and a fixed
    // sleep here would be the race this repository has already paid for.
    const deadline = Date.now() + 5000;
    while (mockQuery.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(mockQuery.mock.calls.length).toBeGreaterThan(0);  // it was admitted
    await jest.advanceTimersByTimeAsync(50);

    participant = false;                       // an operator removes them

    // One tick of the timer that already existed.
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(50);   // let the async re-check settle

    /*
     * Bounded on purpose. If the stream does NOT close, `pending` never settles —
     * and with `setTimeout` faked, jest's own test timeout cannot fire either, so
     * the unfixed code HANGS THE RUN instead of failing it. That is what happened
     * the first time this red control was taken, and a hang is a far worse signal
     * than a failure: it looks like infrastructure, not like a defect.
     *
     * `setImmediate` is left real (see useFakeTimers above) precisely so this
     * bound does not depend on the clock under test.
     */
    const settled = await Promise.race([
      pending.then((r) => r.text),
      (async () => {
        for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
        return 'STREAM NEVER CLOSED';
      })(),
    ]);

    expect(settled).toMatch(/Access revoked/);
  }, 20000);
});
