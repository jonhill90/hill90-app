/**
 * app#538: one client's `close()` throwing must not sink `closeAllSessions()`
 * for every other live session, or skip the rest of shutdown.
 *
 * THE MEASURED BASELINE. The issue's own text already predicted the shape of
 * the cost correctly — "an abrupt exit instead of the graceful one" — but had
 * not been measured. It has now: a standalone repro (three live sessions,
 * `closeAllSessions(1001, 'x'.repeat(200))` — an oversized `reason`, which
 * `ws`'s `Sender.close()` rejects with a synchronous `RangeError`) produced
 * ZERO close frames sent to any of the three sessions, and skipped both
 * `server.close()` and `closePool()` in the `shutdown()` sequence that calls
 * it — before this fix, every live terminal fell back to the process-wide
 * unhandledRejection backstop in boot/fatal.ts instead of the graceful path.
 * That backstop DOES exist and DOES catch the rejection (confirmed directly —
 * the issue's framing of "nowhere to go" undersells it: the process exits
 * promptly, logged, not hung), which is *why* the real cost is a degraded
 * shutdown rather than a stuck process — precisely the cost the issue itself
 * named.
 *
 * WHY code/reason ARE SHARED IS WHAT MAKES THIS WORSE THAN "ONE WEIRD SOCKET".
 * The issue's own hypothesis for the trigger — "a socket already mid-teardown"
 * — would only break ONE client's close() call, and the others would likely
 * still get their frame (their writes are already in flight independently).
 * But `code`/`reason` are the SAME arguments for every client in one
 * `Promise.all`, so any input that makes `ws` reject the call (invalid code,
 * or — per its own 123-byte limit, checked directly in
 * node_modules/ws/lib/sender.js — an oversized reason) fails identically for
 * ALL of them, all at once. Not reachable through the one caller today
 * (index.ts always passes `1001, 'server shutting down'`, both safe) — but
 * `closeAllSessions` performed zero validation of its own before this fix, so
 * nothing stopped a future caller from being the one that changes that.
 *
 * THIS TEST uses a narrower, more realistic per-CLIENT trigger instead — only
 * the FIRST live client's `close()` throws (mirroring the issue's own
 * "one anomalous socket" hypothesis) — specifically to prove the fix isolates
 * a single failure rather than merely making the shared-argument case less
 * bad. The other two sessions must still end with a real 1001 close frame,
 * observed on their own sockets, and the shutdown-equivalent steps after
 * `closeAllSessions` must still run.
 */
import * as http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { attachTerminalProxy } from '../services/terminal-proxy';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
}));

const ORIGIN = 'https://hill90.example';
const PROTO = 'hill90.terminal.v1';
const THREAD = '11111111-2222-3333-4444-555555555555';

let verdict: { sub: string; roles?: string[]; exp: number } | null = null;
let terminals: { closeAllSessions: (code: number, reason: string, timeoutMs?: number) => Promise<number> };
let server: http.Server;
let port: number;
let upstream: WebSocketServer;
let upstreamServer: http.Server;
let upstreamUrl: string;
const clients: WebSocket[] = [];

beforeAll(async () => {
  upstreamServer = http.createServer();
  upstream = new WebSocketServer({ server: upstreamServer });
  upstream.on('connection', (ws) => { ws.on('message', () => {}); });
  await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
  upstreamUrl = `ws://127.0.0.1:${(upstreamServer.address() as { port: number }).port}/terminal/ws`;

  server = http.createServer();
  terminals = attachTerminalProxy(
    server,
    (async () => verdict) as never,
    { resolveUpstream: async () => upstreamUrl },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const ws of clients) { try { ws.terminate(); } catch { /* already gone */ } }
  for (const ws of upstream.clients) { try { ws.terminate(); } catch { /* already gone */ } }
  server.closeAllConnections?.();
  upstreamServer.closeAllConnections?.();
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => upstreamServer.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ '1': 1 }] });
  process.env.TERMINAL_ALLOWED_ORIGINS = ORIGIN;
  verdict = { sub: 'user-1', roles: [], exp: Math.floor(Date.now() / 1000) + 3600 };
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.TERMINAL_ALLOWED_ORIGINS; });

function connect(): { ws: WebSocket; opened: Promise<void>; closed: Promise<{ code: number; reason: string }> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chat/threads/${THREAD}/terminal`, [PROTO, 'hill90.bearer.tok'], {
    headers: { Origin: ORIGIN },
  });
  clients.push(ws);
  const opened = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const closed = new Promise<{ code: number; reason: string }>((res) =>
    ws.once('close', (code, reason) => res({ code, reason: reason.toString() })));
  return { ws, opened, closed };
}

/**
 * Makes the FIRST call to `WebSocket.prototype.close` throw synchronously
 * (mirroring the issue's own "socket already mid-teardown" hypothesis),
 * every subsequent call behaving normally. Patches the real `ws` module — the
 * same one `terminal-proxy.ts` uses, since Node's module cache guarantees one
 * shared class — so the server-side instances inside `closeAllSessions`'s own
 * `wss.clients` are the ones affected, not a copy.
 */
function makeFirstCloseThrowOnce(): () => void {
  const original = WebSocket.prototype.close;
  let used = false;
  WebSocket.prototype.close = function patchedClose(this: WebSocket, code?: number, data?: unknown) {
    if (!used) {
      used = true;
      throw new RangeError('injected: simulating a socket already mid-teardown (app#538)');
    }
    return original.call(this, code, data as never);
  };
  return () => { WebSocket.prototype.close = original; };
}

describe('app#538 — one client failing to close must not sink the rest', () => {
  it('the other two sessions still get a real 1001 close frame, and shutdown keeps going', async () => {
    const a = connect();
    const b = connect();
    const c = connect();
    await Promise.all([a.opened, b.opened, c.opened]);

    const restoreClose = makeFirstCloseThrowOnce();
    let downstreamRan = false;
    try {
      // Mirrors index.ts's shutdown() shape: closeAllSessions, THEN more steps.
      // Before the fix, a rejection here meant downstreamRan never flips.
      await expect(terminals.closeAllSessions(1001, 'server shutting down')).resolves.toBe(3);
      downstreamRan = true; // stands in for server.close() + closePool()
    } finally {
      restoreClose();
    }

    expect(downstreamRan).toBe(true);

    // Two of the three sockets had a real, unpatched close() call — they must
    // have actually received 1001, not merely "the promise didn't throw".
    const results = await Promise.all(
      [a.closed, b.closed, c.closed].map((p) =>
        Promise.race([
          p.then((e) => ({ settled: true as const, ...e })),
          new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), 3000)),
        ]),
      ),
    );
    const gotClean1001 = results.filter((r) => r.settled && r.code === 1001);
    expect(gotClean1001.length).toBeGreaterThanOrEqual(2);
  }, 15000);
});
