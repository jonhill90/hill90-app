/**
 * A terminal session must not outlive the credential that authorised it.
 *
 * THE DEFECT. The JWT is verified once, at the WebSocket handshake. After that
 * nothing re-checks it, and a 30-second keep-alive ping deliberately holds the
 * socket open against Traefik's idle timeout. So a shell inside the agent
 * container persists for as long as the browser tab stays open — after the token
 * expires, after the user signs out, after their roles are revoked. On the
 * surface this file's own header calls "the most privileged surface in the app".
 *
 * THE TELL that this was intended and never wired: index.ts insists the token
 * carries an expiry —
 *
 *     if (typeof payload.exp !== 'number') return null;
 *
 * — and then returns `{ sub, roles }`, dropping it. The verifier's own type,
 * `Promise<{ sub: string; roles?: string[] } | null>`, has nowhere to put an
 * expiry. Somebody decided a non-expiring token was unacceptable here and the
 * enforcement did not follow.
 *
 * THE TEST HARNESS. The proxy dials agentbox at
 * `ws://agentbox-<slug>:8054/...`, a name that does not resolve off the host, so
 * the outbound socket is stubbed. Otherwise the connection failure would close
 * the client socket first and the test would pass for the wrong reason — it
 * would be observing ECONNREFUSED, not expiry. The close CODE is asserted for
 * the same reason: "the socket closed" is not the claim, "it closed because the
 * credential expired" is.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { EventEmitter } from 'events';

// The outbound connection to agentbox, stubbed: opens, stays open, never errors.
// WebSocketServer stays real — the proxy's own server must behave normally.
class FakeAgentboxSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeAgentboxSocket.OPEN;
  constructor(_url: string) {
    super();
    setImmediate(() => this.emit('open'));
  }
  send(): void { /* the relay is not under test here */ }
  ping(): void { /* keep-alive is not under test here */ }
  close(): void {
    this.readyState = FakeAgentboxSocket.CLOSED;
    this.emit('close');
  }
}

jest.mock('ws', () => {
  const actual = jest.requireActual('ws');
  return { ...actual, WebSocket: FakeAgentboxSocket, WebSocketServer: actual.WebSocketServer };
});

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

import { attachTerminalProxy } from '../services/terminal-proxy';

// A real client, taken before the module mock so the browser side is genuine.
const RealWebSocket = jest.requireActual('ws').WebSocket;

const ORIGIN = 'https://hill90.com';
const PROTOCOLS = 'hill90.terminal.v1, hill90.bearer.tok';
const PATH = '/chat/threads/thread-1/terminal';

let server: http.Server;
let port: number;

/** Seconds-since-epoch, the unit a JWT `exp` uses. */
const inSeconds = (msFromNow: number) => Math.floor((Date.now() + msFromNow) / 1000);

function startProxy(exp: number) {
  server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  attachTerminalProxy(server, async () => ({ sub: 'user-1', roles: ['user'], exp } as any));
  return new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}

/** Open a client socket and report how it ended. */
function openAndAwaitClose(timeoutMs: number): Promise<{ code: number; reason: string } | 'STILL OPEN'> {
  return new Promise((resolve) => {
    const ws = new RealWebSocket(`ws://127.0.0.1:${port}${PATH}`, PROTOCOLS.split(', '), {
      headers: { origin: ORIGIN },
    });
    const timer = setTimeout(() => {
      ws.close();
      resolve('STILL OPEN');
    }, timeoutMs);
    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', () => { /* close still fires */ });
  });
}

describe('a terminal session ends when its token does', () => {
  beforeEach(() => {
    process.env.TERMINAL_ALLOWED_ORIGINS = ORIGIN;
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({
      rows: [{ agent_id: 'scout', work_token: 'wt' }],
    });
  });

  afterEach(async () => {
    delete process.env.TERMINAL_ALLOWED_ORIGINS;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('closes a session whose token expires while it is open', async () => {
    await startProxy(inSeconds(700)); // expires in 0.7s, mid-session

    const ended = await openAndAwaitClose(4000);

    expect(ended).not.toBe('STILL OPEN');
    const { code, reason } = ended as { code: number; reason: string };
    // Not merely "it closed" — closed FOR THIS REASON. An upstream failure or a
    // client hang-up would show a different code.
    expect(code).toBe(4001);
    expect(reason.toLowerCase()).toMatch(/expired|credential/);
  }, 10000);

  /**
   * Defence in depth, and worth being exact about: jwt.verify already rejects an
   * expired token upstream, so production does not reach the proxy with one. The
   * verifier here is a stub that does not check, which is how a real verifier
   * that stopped checking would look. The proxy must refuse on its own account.
   *
   * The contract asserted is REFUSE THE UPGRADE, not open-then-close: the socket
   * must never reach the 'open' state, so no shell exists even momentarily.
   */
  it('never opens a session for a credential that is already spent', async () => {
    await startProxy(inSeconds(-60));

    const opened = await new Promise<boolean>((resolve) => {
      const ws = new RealWebSocket(`ws://127.0.0.1:${port}${PATH}`, PROTOCOLS.split(', '), {
        headers: { origin: ORIGIN },
      });
      let everOpened = false;
      ws.on('open', () => { everOpened = true; ws.close(); });
      ws.on('error', () => { /* the refusal arrives as an error, not a close frame */ });
      ws.on('close', () => resolve(everOpened));
      setTimeout(() => resolve(everOpened), 2500);
    });

    expect(opened).toBe(false);
  }, 10000);

  // Guard rail: an ordinary session must not be cut short by the new timer.
  it('leaves a session with a long-lived token open', async () => {
    await startProxy(inSeconds(3600_000)); // an hour out

    const ended = await openAndAwaitClose(1500);

    expect(ended).toBe('STILL OPEN');
  }, 10000);
});
