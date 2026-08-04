/**
 * Removing a participant must close their terminal — and within the stated time.
 *
 * WHY THIS FILE EXISTS. app#199 added the participation re-check to three places:
 * the two SSE routes and this WebSocket proxy. Only the SSE half got a test.
 * Auditing the day's merges for durability, I deleted the terminal-proxy block
 * entirely and ran the suite: 84 suites, 941 tests, all passing. Nothing objected.
 *
 * AN UNTESTED SECURITY FIX IS INDISTINGUISHABLE FROM ONE THAT WAS REVERTED, and
 * revocation is exactly where that goes unnoticed: the failure mode is a terminal
 * that keeps working for somebody who was removed, which nobody is watching for.
 *
 * IT ALSO PINS THE NUMBER. participation-watch.ts documents "worst case ~30
 * seconds plus one query round-trip" as the security property of #199. That number
 * rests on three separate constants — PING_INTERVAL_MS here and two bare 30000
 * literals in chat.ts — and nothing asserted any of them. Change one to 300_000
 * and the guarantee silently becomes five minutes while the comment still says
 * thirty seconds.
 *
 * The bound is asserted BEHAVIOURALLY rather than by comparing a constant to a
 * literal: nothing may happen before the interval, and the close must have
 * happened by it. A constant assertion would pass if the constant were renamed
 * and the timer left behind; this cannot.
 *
 * THE WIDER POINT, which this file is one instance of: the load-bearing comments
 * written today are TRUE, and nothing would tell us if they became false. They are
 * pinned to a Node version, three constants, and a client's status-checking
 * behaviour, none of which anything watches. Wrongness and unwatchedness are
 * different risks, and the second is the one that survives.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { EventEmitter } from 'events';

/** Stands in for agentbox: opens, stays open, records nothing. */
class FakeAgentbox extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeAgentbox.OPEN;
  bufferedAmount = 0;
  _socket = { pause: () => {}, resume: () => {} };
  static latest: FakeAgentbox | null = null;

  constructor(_url: string) {
    super();
    FakeAgentbox.latest = this;
    setImmediate(() => this.emit('open'));
  }
  send(): void {}
  ping(): void {}
  close(): void {
    this.readyState = FakeAgentbox.CLOSED;
    this.emit('close');
  }
}

jest.mock('ws', () => {
  const actual = jest.requireActual('ws');
  return { ...actual, WebSocket: FakeAgentbox, WebSocketServer: actual.WebSocketServer };
});

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

import { attachTerminalProxy } from '../services/terminal-proxy';

const RealWebSocket = jest.requireActual('ws').WebSocket;

const ORIGIN = 'https://hill90.com';
const PROTOCOLS = ['hill90.terminal.v1', 'hill90.bearer.tok'];
const PATH = '/chat/threads/thread-1/terminal';

/** What participation-watch.ts documents, and what this file holds it to. */
const DOCUMENTED_RECHECK_MS = 30_000;
const CLOSE_ACCESS_REVOKED = 4004;

let server: http.Server;
let port: number;
let participant = true;
const openClients: any[] = [];

beforeEach(async () => {
  // setImmediate stays real so the connection handshake — real sockets — can make
  // progress while the timers under test are faked.
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  process.env.TERMINAL_ALLOWED_ORIGINS = ORIGIN;
  mockQuery.mockReset();
  participant = true;
  openClients.length = 0;
  FakeAgentbox.latest = null;

  mockQuery.mockImplementation((sql: string) => {
    if (/FROM chat_participants/.test(String(sql))) {
      return Promise.resolve({ rows: participant ? [{ '?column?': 1 }] : [] });
    }
    // resolveAgentWsUrl
    return Promise.resolve({ rows: [{ agent_id: 'scout', work_token: 'wt' }] });
  });

  server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  attachTerminalProxy(server, async () => ({
    sub: 'user-1',
    roles: ['user'],
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  jest.useRealTimers();
  delete process.env.TERMINAL_ALLOWED_ORIGINS;
  for (const c of openClients) {
    try { c.terminate(); } catch { /* already gone */ }
  }
  await new Promise<void>((r) => server.close(() => r()));
});

function connect(): Promise<{ ws: any; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve) => {
    const ws = new RealWebSocket(`ws://127.0.0.1:${port}${PATH}`, PROTOCOLS, {
      headers: { origin: ORIGIN },
    });
    openClients.push(ws);
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on('close', (code: number, reason: Buffer) => res({ code, reason: reason.toString() }));
    });
    ws.on('open', () => resolve({ ws, closed }));
    ws.on('error', () => { /* close carries the outcome */ });
  });
}

/** Real I/O does not advance with fake timers, so wait on the condition. */
async function settle(turns = 40) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

const raced = <T,>(p: Promise<T>, sentinel: T) =>
  Promise.race([p, (async () => { await settle(60); return sentinel; })()]);

describe('the terminal closes when participation is revoked', () => {
  it('POSITIVE CONTROL: closes with 4004 once the viewer is removed', async () => {
    const { closed } = await connect();
    await settle();
    expect(mockQuery.mock.calls.length).toBeGreaterThan(0); // it was admitted

    participant = false;
    await jest.advanceTimersByTimeAsync(DOCUMENTED_RECHECK_MS);
    await settle();

    const result = await raced(closed, { code: -1, reason: 'STILL OPEN' });

    // Deleting this whole block from terminal-proxy.ts left 941 tests passing.
    expect(result.code).toBe(CLOSE_ACCESS_REVOKED);
    expect(result.reason).toMatch(/revoked/i);
  }, 20000);

  it('holds the documented bound: nothing before the interval, closed by it', async () => {
    const { closed } = await connect();
    await settle();

    participant = false;

    // Just short of the interval — the guarantee is "within ~30s", and a check
    // that fired early would be a different (if harmless) contract.
    await jest.advanceTimersByTimeAsync(DOCUMENTED_RECHECK_MS - 1_000);
    await settle();
    expect(await raced(closed, { code: -1, reason: 'STILL OPEN' })).toEqual({
      code: -1, reason: 'STILL OPEN',
    });

    // And by the interval it must be gone. If PING_INTERVAL_MS were raised to
    // 300_000, this advance would never reach a tick and the documented
    // thirty-second property would be silently false — which is the whole reason
    // this assertion is behavioural rather than a constant comparison.
    await jest.advanceTimersByTimeAsync(1_000);
    await settle();
    expect((await raced(closed, { code: -1, reason: 'STILL OPEN' })).code).toBe(
      CLOSE_ACCESS_REVOKED,
    );
  }, 20000);

  it('leaves a still-valid participant connected', async () => {
    // Guard rail. Without it, "close everything on every tick" would pass the
    // control above and break every terminal in the product.
    const { closed } = await connect();
    await settle();

    await jest.advanceTimersByTimeAsync(DOCUMENTED_RECHECK_MS * 3);
    await settle();

    expect(await raced(closed, { code: -1, reason: 'STILL OPEN' })).toEqual({
      code: -1, reason: 'STILL OPEN',
    });
  }, 20000);

  it('fails closed: an unreadable participation query ends the session', async () => {
    const { closed } = await connect();
    await settle();

    mockQuery.mockImplementation((sql: string) => {
      if (/FROM chat_participants/.test(String(sql))) {
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve({ rows: [{ agent_id: 'scout', work_token: 'wt' }] });
    });

    await jest.advanceTimersByTimeAsync(DOCUMENTED_RECHECK_MS);
    await settle();

    // "I could not tell" must not mean "allowed" — the same rule the SSE half is
    // held to, now held here.
    expect((await raced(closed, { code: -1, reason: 'STILL OPEN' })).code).toBe(
      CLOSE_ACCESS_REVOKED,
    );
  }, 20000);
});
