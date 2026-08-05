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
let terminals: { closeAllSessions: (code: number, reason: string, timeoutMs?: number) => Promise<number> };
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
  terminals = attachTerminalProxy(
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

/**
 * An exp that leaves at least `bufferSeconds` of real runway no matter where
 * `nowMs` falls within its current second. See the 4002 test above for why
 * Math.floor(nowMs/1000)+N (the previous approach) could not promise that.
 */
function expWithGuaranteedRunway(bufferSeconds: number, nowMs: number = Date.now()): number {
  return Math.ceil(nowMs / 1000) + bufferSeconds;
}

/**
 * The instant that minimizes Math.floor(nowMs/1000)+N's real runway: 1ms
 * before nowMs's current second started, i.e. .999 of the PREVIOUS second.
 * floor() only depends on which whole second a value falls in, so nudging
 * within nowMs's OWN second changes nothing — floor(nowMs/1000) is already
 * identical whichever millisecond of that second you pick. Landing one
 * second earlier is what makes Math.floor(forced/1000)+1 resolve to nowMs's
 * current second, i.e. an exp already at or before nowMs itself.
 */
function worstCaseInstantForOldFormula(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) * 1000 - 1;
}

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
    // Math.floor(Date.now()/1000)+1 (the previous formula here) discards the
    // sub-second remainder before adding one whole second, so real runway
    // was anywhere in (0, 1] depending on where "now" fell in its current
    // second — on a loaded runner the credential could already be expired
    // by the time terminal-proxy.ts's upgrade handler reads Date.now(), which
    // 401s (correct behaviour for an expired token) before the handshake this
    // test needs ever completes. That's a race in this fixture, not a
    // product defect: verified directly against terminal-proxy.ts, which
    // refuses with 401 whenever `expiresAtMs <= Date.now()` at upgrade time.
    //
    // expWithGuaranteedRunway uses Math.ceil instead: runway is always in
    // [bufferSeconds, bufferSeconds + 1), never approaching 0 regardless of
    // where "now" falls in its second. Forced here to the worst instant for
    // the OLD formula (1ms before a second rolls over) so this test always
    // exercises the boundary it exists to guard, rather than depending on
    // being unlucky enough to hit it — the guarantee is proven every run.
    verdict = {
      sub: 'user-1',
      roles: [],
      exp: expWithGuaranteedRunway(2, worstCaseInstantForOldFormula()),
    };

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

describe('1001 — shutdown says going away instead of vanishing (#318)', () => {
  it('a live session is closed with 1001 and a reason, not severed', async () => {
    const { opened, closed } = connect();
    await opened;

    const count = await terminals.closeAllSessions(1001, 'server shutting down');

    expect(count).toBe(1);
    const end = await closed;
    // 1006 is what the client saw before: no code at all, indistinguishable from a
    // network fault on a surface that distinguishes 4001/4002/4004 on purpose.
    expect(end.code).toBe(1001);
    expect(end.reason).toBe('server shutting down');
  }, 15000);

  it('the drain WAITS for the close rather than sleeping through it', async () => {
    const { opened } = connect();
    await opened;

    const started = Date.now();
    await terminals.closeAllSessions(1001, 'server shutting down');
    const elapsed = Date.now() - started;

    // The ceiling is 2000ms. A healthy socket must cost a fraction of it — if this
    // ever approaches the bound, the implementation has started sleeping.
    expect(elapsed).toBeLessThan(500);
  }, 15000);

  it('is bounded when a peer never answers, rather than hanging shutdown', async () => {
    const { ws, opened } = connect();
    await opened;
    // Stop reading: the server's close frame is sent, the client never echoes it, and
    // `ws` would otherwise wait out its own 30s close timeout.
    (ws as unknown as { _socket: { pause: () => void } })._socket.pause();

    const started = Date.now();
    await terminals.closeAllSessions(1001, 'server shutting down', 300);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
    ws.terminate();
  }, 15000);

  it('with no live sessions it is a no-op, not a wait', async () => {
    const started = Date.now();
    const count = await terminals.closeAllSessions(1001, 'server shutting down');
    expect(count).toBe(0);
    expect(Date.now() - started).toBeLessThan(100);
  }, 15000);
});
