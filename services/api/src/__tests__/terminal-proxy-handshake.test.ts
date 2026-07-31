/**
 * Terminal WebSocket handshake security.
 *
 * Two defects, both confirmed by reading services/api/src/services/terminal-proxy.ts
 * before these tests were written:
 *
 *   1. NO ORIGIN CHECK. The upgrade handler never read req.headers.origin. Any page a
 *      logged-in user visits could open a WebSocket to the terminal and drive a shell
 *      inside their agent container, because the browser attaches the credential and
 *      the same-origin policy does not apply to WebSockets.
 *
 *   2. TOKEN IN THE QUERY STRING. The token was read from ?token= FIRST. URLs reach
 *      access logs, proxy logs and browser history — all places a bearer credential
 *      must not be. This service logged it itself, on the upgrade line.
 *
 * These tests drive a real HTTP server and real upgrade requests rather than mocking
 * the handler, because the defect lived in the handshake and a mock of the handshake
 * would have proved nothing. The server is closed in afterEach: the api suite already
 * flakes from listeners accumulating across a process, and this must not add to it.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { attachTerminalProxy } from '../services/terminal-proxy';

const GOOD_ORIGIN = 'https://hill90.com';
const TOKEN = 'a-token-the-verifier-will-accept';

// The proxy resolves an agentbox URL from the database. These tests assert only on
// handshake outcomes, so the pool is stubbed to report participation but NO running
// agent — a 404 then means both security gates passed, and no rejection below can be
// mistaken for a security control working.
jest.mock('../db/pool', () => ({
  getPool: () => ({
    query: jest.fn(async (sql: string) => {
      // Participation: yes. Running agent: NO.
      //
      // That combination is deliberate. A request that clears the origin check and the
      // token check then stops at 404 proves both gates passed, without the proxy ever
      // opening a WebSocket to an agentbox that does not exist here. An earlier version
      // of this file let the handshake complete, which dialled out, leaked an open
      // handle and made jest warn that it could not exit — and the api suite already
      // flakes from handles accumulating across a process.
      if (sql.includes('chat_participants') && sql.includes('agents')) {
        return { rows: [] };
      }
      return { rows: [{ '?column?': 1 }] };
    }),
  }),
}));

interface Handshake {
  status: number | null;
  raw: string;
  upgraded: boolean;
}

/**
 * Send a raw upgrade request and report what came back. Raw sockets, because the
 * point is what the server does with headers a WebSocket client library would not
 * let us vary.
 */
function handshake(
  port: number,
  opts: { path: string; origin?: string; protocols?: string },
): Promise<Handshake> {
  return new Promise((resolve) => {
    const socket = require('net').connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${opts.path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ];
      if (opts.origin !== undefined) lines.push(`Origin: ${opts.origin}`);
      if (opts.protocols !== undefined) lines.push(`Sec-WebSocket-Protocol: ${opts.protocols}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });

    let raw = '';
    socket.on('data', (d: Buffer) => { raw += d.toString('utf8'); });

    // The fallback timer MUST be cleared, and `finish` must run once.
    //
    // The first version of this helper left the timer pending whenever the socket
    // closed first — ten tests, ten leaked timers, and jest reporting it could not
    // exit. --detectOpenHandles pointed at this line, not at the code under test. It
    // matters more than usual here: this suite already flakes because handles
    // accumulate across a process, so a test file for a security fix must not be the
    // thing that makes the suite less trustworthy.
    let done = false;
    let timer: NodeJS.Timeout;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const m = raw.match(/^HTTP\/1\.1 (\d{3})/);
      resolve({
        status: m ? parseInt(m[1], 10) : null,
        raw,
        upgraded: /^HTTP\/1\.1 101/.test(raw),
      });
      socket.destroy();
    };
    socket.on('close', finish);
    timer = setTimeout(finish, 1200);
  });
}

describe('terminal websocket handshake', () => {
  let server: http.Server;
  let port: number;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    process.env.TERMINAL_ALLOWED_ORIGINS = `${GOOD_ORIGIN},https://www.hill90.com`;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    attachTerminalProxy(server, async (token: string) =>
      token === TOKEN ? { sub: 'user-1', roles: ['user'] } : null,
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    logSpy.mockRestore();
    jest.restoreAllMocks();
    delete process.env.TERMINAL_ALLOWED_ORIGINS;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const P = '/chat/threads/t1/terminal';

  // ---- Control. If this fails, every rejection below is meaningless. ----

  it('lets an allowed origin with a subprotocol token THROUGH both security gates', async () => {
    const r = await handshake(port, {
      path: P,
      origin: GOOD_ORIGIN,
      protocols: `hill90.terminal.v1, hill90.bearer.${TOKEN}`,
    });
    // 404 = "no running agent for this thread", which is only reachable after the
    // origin check and the token check have both passed. Asserting NOT 403/401 is the
    // point: it stops every rejection below from passing for the wrong reason.
    expect(r.status).toBe(404);
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });

  // ---- Defect 1: Origin ----

  it('REFUSES a cross-origin handshake', async () => {
    const r = await handshake(port, {
      path: P,
      origin: 'https://evil.example',
      protocols: `hill90.terminal.v1, hill90.bearer.${TOKEN}`,
    });
    expect(r.upgraded).toBe(false);
    expect(r.status).toBe(403);
  });

  it('REFUSES an origin that merely looks like the allowed one', async () => {
    // Substring matching would accept all of these. Exact match must not.
    for (const origin of [
      'https://hill90.com.evil.example',
      'https://evilhill90.com',
      'http://hill90.com',            // wrong scheme
      'https://hill90.com:8443',      // wrong port
    ]) {
      const r = await handshake(port, {
        path: P, origin, protocols: `hill90.terminal.v1, hill90.bearer.${TOKEN}`,
      });
      expect(r.upgraded).toBe(false);
      expect(r.status).toBe(403);
    }
  });

  it('REFUSES a handshake with no Origin header at all', async () => {
    // Browsers always send one. Something that omits it is not the browser client
    // this endpoint exists for, so it fails closed.
    const r = await handshake(port, {
      path: P, protocols: `hill90.terminal.v1, hill90.bearer.${TOKEN}`,
    });
    expect(r.upgraded).toBe(false);
    expect(r.status).toBe(403);
  });

  it('REFUSES everything when the allowlist is not configured', async () => {
    delete process.env.TERMINAL_ALLOWED_ORIGINS;
    const r = await handshake(port, {
      path: P, origin: GOOD_ORIGIN, protocols: `hill90.terminal.v1, hill90.bearer.${TOKEN}`,
    });
    expect(r.upgraded).toBe(false);
    expect(r.status).toBe(403);
  });

  // ---- Defect 2: token in the URL ----

  it('does NOT accept a token in the query string', async () => {
    const r = await handshake(port, {
      path: `${P}?token=${TOKEN}`,
      origin: GOOD_ORIGIN,
      // No subprotocol: the query string is the only credential offered.
    });
    expect(r.upgraded).toBe(false);
    expect(r.status).toBe(401);
  });

  it('does NOT accept a query-string token even when the origin is allowed and a protocol is offered', async () => {
    // The version-only subprotocol carries no credential, so this must still fail —
    // otherwise the query string is silently still live.
    const r = await handshake(port, {
      path: `${P}?token=${TOKEN}`,
      origin: GOOD_ORIGIN,
      protocols: 'hill90.terminal.v1',
    });
    expect(r.upgraded).toBe(false);
    expect(r.status).toBe(401);
  });

  it('rejects an invalid token offered in the subprotocol', async () => {
    const r = await handshake(port, {
      path: P, origin: GOOD_ORIGIN, protocols: 'hill90.terminal.v1, hill90.bearer.not-valid',
    });
    expect(r.upgraded).toBe(false);
    expect(r.status).toBe(401);
  });

  // ---- The credential must not be written to logs ----

  it('never logs the token, even when it is passed in the URL', async () => {
    await handshake(port, {
      path: `${P}?token=${TOKEN}`, origin: GOOD_ORIGIN,
    });
    const logged = logSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain(TOKEN);
  });

  it('never echoes the token back in the response headers', async () => {
    // Selecting the bearer subprotocol would put the credential in
    // Sec-WebSocket-Protocol on the way back, and responses get logged too.
    const r = await handshake(port, {
      path: P, origin: GOOD_ORIGIN, protocols: `hill90.terminal.v1, hill90.bearer.${TOKEN}`,
    });
    expect(r.raw).not.toContain(TOKEN);
  });
});
