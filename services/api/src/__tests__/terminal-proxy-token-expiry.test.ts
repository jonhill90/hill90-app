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

type Ending = { code: number; reason: string; everOpened: boolean } | 'STILL OPEN';

/**
 * Open a client socket and report how it ended, INCLUDING whether it ever
 * opened.
 *
 * That last part is not decoration. The expiry is an absolute moment, so if the
 * handshake is slower than the margin — which happens under full-suite load, and
 * did — the socket is refused rather than opened, and the client sees 1006 with
 * no close frame. Asserting only on the code turns that into
 * "expected 4002, received 1006", which reads like the fix failing rather than
 * the test racing. Reporting `everOpened` lets the assertion say which happened.
 */
function openAndAwaitClose(timeoutMs: number): Promise<Ending> {
  return new Promise((resolve) => {
    const ws = new RealWebSocket(`ws://127.0.0.1:${port}${PATH}`, PROTOCOLS.split(', '), {
      headers: { origin: ORIGIN },
    });
    let everOpened = false;
    const timer = setTimeout(() => {
      ws.close();
      resolve('STILL OPEN');
    }, timeoutMs);
    ws.on('open', () => { everOpened = true; });
    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString(), everOpened });
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
    // 3s, not 0.7s. The margin has to cover the handshake under load: at 0.7s
    // this test failed in a full-suite run because the credential expired before
    // the socket opened, so the proxy refused it and the client saw 1006.
    await startProxy(inSeconds(3000));

    const ended = await openAndAwaitClose(9000);

    expect(ended).not.toBe('STILL OPEN');
    const { code, reason, everOpened } = ended as { code: number; reason: string; everOpened: boolean };
    // If this trips, the margin above is too tight for the machine — the session
    // was refused at the handshake, which is a different behaviour from the one
    // under test.
    expect(everOpened).toBe(true);
    // Not merely "it closed" — closed FOR THIS REASON. An upstream failure or a
    // client hang-up would show a different code, and 4001 would mean the
    // credential was refused rather than spent.
    expect(code).toBe(4002);
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
