/**
 * How a terminal session ENDS, observed on a real socket (#313).
 *
 * The handshake got coverage in #314. Everything after it did not, and could not:
 * `resolveAgentWsUrl` derives the upstream host from a validated agent slug, so no
 * database value could point the proxy at a test server; with the upstream absent,
 * `agentWs.on('error')` runs `cleanupAll()`, which clears the expiry timer and the
 * ping interval before either can fire. `resolveUpstream` is the seam that removes
 * that, and this file is what it was for.
 *
 * THE CLOSE CODES ARE THE POINT, not merely that the socket shut. terminal-proxy.ts
 * says it plainly: 4001 means the credential was refused, 4002 that it was good and
 * ran out, 4004 that it is still valid and the access behind it is gone. `terminalClose.ts`
 * in the ui auto-reconnects on any code it does not recognise, so a session that ends
 * with the wrong number becomes a reconnect loop against an upgrade that will refuse
 * it — the removed user whose terminal retries for ever, saying nothing.
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
const CLOSE_CREDENTIAL_EXPIRED = 4002;
const CLOSE_ACCESS_REVOKED = 4004;

let verdict: { sub: string; roles?: string[]; exp: number } | null = null;
let server: http.Server;
let port: number;
/** Stands in for agentbox: accepts the relay connection and holds it open. */
let upstream: WebSocketServer;
let upstreamServer: http.Server;
let upstreamUrl: string;
/** Every client socket this file opens, so teardown can close what it started. */
const clients: WebSocket[] = [];

beforeAll(async () => {
  upstreamServer = http.createServer();
  upstream = new WebSocketServer({ server: upstreamServer });
  upstream.on('connection', (ws) => { ws.on('message', () => {}); });
  await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
  upstreamUrl = `ws://127.0.0.1:${(upstreamServer.address() as { port: number }).port}/terminal/ws`;

  server = http.createServer();
  attachTerminalProxy(
    server,
    (async () => verdict) as never,
    { resolveUpstream: async () => upstreamUrl },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  // NOT --forceExit. CI runs plain `jest`, so a file that leaves handles open hangs
  // the whole run rather than failing it — and this file opens four kinds: client
  // sockets, the proxy's outbound sockets, the stand-in upstream's server sockets,
  // and two listeners. Each is closed here, in that order, because closing a
  // listener does not close the sessions on it.
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
  mockQuery.mockResolvedValue({ rows: [{ '1': 1 }] });   // participant, by default
  process.env.TERMINAL_ALLOWED_ORIGINS = ORIGIN;
  verdict = { sub: 'user-1', roles: [], exp: Math.floor(Date.now() / 1000) + 3600 };
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.TERMINAL_ALLOWED_ORIGINS; });

/** Open a real client session and report how it ends. */
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

describe('4002 — the session does not outlive the credential', () => {
  it('closes with 4002 when the token expires, and says so', async () => {
    // A credential with ~1.2s left. The proxy arms setTimeout(exp - now) at upgrade.
    verdict = { sub: 'user-1', roles: [], exp: Math.floor(Date.now() / 1000) + 1 };

    const { opened, closed } = connect();
    await opened;                       // the handshake succeeded — the session is live
    const end = await closed;

    expect(end.code).toBe(CLOSE_CREDENTIAL_EXPIRED);
    expect(end.reason).toMatch(/credential expired/i);
  }, 15000);

  it('POSITIVE CONTROL: a long-lived credential does NOT close the session', async () => {
    verdict = { sub: 'user-1', roles: [], exp: Math.floor(Date.now() / 1000) + 3600 };

    const { ws, opened, closed } = connect();
    await opened;

    const ended = await Promise.race([
      closed.then((e) => `closed ${e.code}`),
      new Promise<string>((r) => setTimeout(() => r('still open'), 2500)),
    ]);
    ws.close();

    // Without this the 4002 test passes for any reason a socket might shut.
    expect(ended).toBe('still open');
  }, 15000);
});

describe('4004 — access removed while the session is open', () => {
  // The re-check rides `PING_INTERVAL_MS = 30_000`, so the interval is FAKED — but
  // only setInterval/clearInterval, and installed BEFORE the socket exists.
  //
  // Both halves of that are load-bearing, and the first version of this file got both
  // wrong. Faking after connecting leaves the already-created interval real, so
  // advancing does nothing and the test waits for a close that never comes. Faking
  // everything breaks the handshake, which needs real setTimeout and real I/O.
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate',
        'nextTick', 'queueMicrotask', 'performance', 'Date', 'hrtime',
        'requestAnimationFrame', 'cancelAnimationFrame',
      ],
    });
  });
  afterEach(() => { jest.useRealTimers(); });

  it('closes with 4004 when participation is revoked mid-session', async () => {
    let participant = true;
    mockQuery.mockImplementation(() => Promise.resolve({ rows: participant ? [{ '1': 1 }] : [] }));

    const { opened, closed } = connect();
    await opened;

    participant = false;                 // removed from the thread
    jest.advanceTimersByTime(31_000);    // one ping tick, which carries the re-check

    const end = await closed;
    expect(end.code).toBe(CLOSE_ACCESS_REVOKED);
    expect(end.reason).toMatch(/revoked/i);
  }, 15000);

  it('POSITIVE CONTROL: a still-valid participant survives the same tick', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '1': 1 }] });

    const { ws, opened, closed } = connect();
    await opened;
    jest.advanceTimersByTime(31_000);

    const ended = await Promise.race([
      closed.then((e) => `closed ${e.code}`),
      new Promise<string>((r) => setTimeout(() => r('still open'), 1500)),
    ]);
    ws.close();
    expect(ended).toBe('still open');
  }, 15000);

  it('an ADMIN is exempt from the re-check, as at connect', async () => {
    verdict = { sub: 'admin-1', roles: ['admin'], exp: Math.floor(Date.now() / 1000) + 3600 };
    mockQuery.mockResolvedValue({ rows: [] });    // not a participant at all

    const { ws, opened, closed } = connect();
    await opened;
    jest.advanceTimersByTime(31_000);

    const ended = await Promise.race([
      closed.then((e) => `closed ${e.code}`),
      new Promise<string>((r) => setTimeout(() => r('still open'), 1500)),
    ]);
    ws.close();
    expect(ended).toBe('still open');
  }, 15000);
});
