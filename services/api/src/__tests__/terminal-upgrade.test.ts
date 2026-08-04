/**
 * A REAL WebSocket upgrade against a real http.Server (#313).
 *
 * Nothing in this repository exercised one. The terminal proxy is what index.ts calls
 * the most privileged surface in the service — a live shell inside an agent container
 * — and its handshake had no end-to-end coverage of any kind: `verifyTerminalToken`
 * is unit-tested (#308), and everything the proxy DOES with that verdict was not.
 *
 * THE REFUSAL PATH IS FIRST ON PURPOSE. A refusal that silently becomes an acceptance
 * is the failure that matters here, and it is invisible to a unit test of the
 * verifier: every assertion in #308 would still pass if `attachTerminalProxy` ignored
 * the `null` it returns.
 *
 * HOW THIS TALKS TO THE SERVER. Not through the `ws` client — the proxy answers a
 * refusal by writing a raw `HTTP/1.1 4xx` and destroying the socket, and a client
 * library's interpretation of that sits between the assertion and the behaviour. A
 * plain `http.request` with the upgrade headers sees exactly what the server sent:
 * a `response` event for a refusal, an `upgrade` event with 101 for an acceptance.
 */
import * as http from 'http';
import * as crypto from 'crypto';
import { attachTerminalProxy } from '../services/terminal-proxy';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
}));

const ORIGIN = 'https://hill90.example';
const PROTO = 'hill90.terminal.v1';
const THREAD = '11111111-2222-3333-4444-555555555555';

/** What the verifier will return next; each test sets it. */
let verdict: { sub: string; roles?: string[]; exp: number } | null = null;
const verifyToken = jest.fn(async () => verdict);

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => { res.writeHead(200); res.end('not the ws path'); });
  attachTerminalProxy(server, verifyToken as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  // NOT awaited, deliberately. An accepted upgrade leaves two things live: the
  // client socket, which `ws` owns once handleUpgrade has run, and the proxy's
  // OUTBOUND connection to `ws://agentbox-<slug>:8054`, whose DNS lookup cannot
  // resolve here and does not fail quickly. `server.close()` waits for both, so
  // awaiting it hangs the suite for the resolver's timeout.
  //
  // That is a property of the code, not of the test: closing the listener is not
  // closing the sessions, and an accepted terminal keeps a handle until its upstream
  // resolves or gives up. Recorded here rather than hidden behind a longer timeout.
  server.closeAllConnections?.();
  server.close();
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockQuery.mockReset();
  verifyToken.mockClear();
  process.env.TERMINAL_ALLOWED_ORIGINS = ORIGIN;
  verdict = { sub: 'user-1', roles: [], exp: Math.floor(Date.now() / 1000) + 3600 };
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.TERMINAL_ALLOWED_ORIGINS; });

type Outcome =
  | { kind: 'refused'; status: number }
  | { kind: 'upgraded'; status: number; protocol?: string; raw: string }
  | { kind: 'ignored' };

/** Perform a genuine upgrade request and report what the server did with it. */
function upgrade(opts: { origin?: string | null; token?: string | null; path?: string }): Promise<Outcome> {
  const headers: Record<string, string> = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
  };
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  if (opts.token !== null) headers['Sec-WebSocket-Protocol'] = `${PROTO}, hill90.bearer.${opts.token ?? 'a-token'}`;
  else headers['Sec-WebSocket-Protocol'] = PROTO;

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET',
      path: opts.path ?? `/chat/threads/${THREAD}/terminal`,
      headers,
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ kind: 'ignored' }); }, 3000);
    req.on('response', (res) => { clearTimeout(timer); res.resume(); resolve({ kind: 'refused', status: res.statusCode ?? 0 }); });
    req.on('upgrade', (res, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        kind: 'upgraded',
        status: res.statusCode ?? 0,
        protocol: res.headers['sec-websocket-protocol'] as string | undefined,
        raw: JSON.stringify(res.headers),
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

/** The participation and agent-resolution queries, both satisfied. */
function dbAllows() {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM chat_participants/i.test(sql) && /JOIN agents/i.test(sql)) {
      return Promise.resolve({ rows: [{ agent_id: 'demo-agent', work_token: 'wt' }] });
    }
    if (/chat_participants/i.test(sql)) return Promise.resolve({ rows: [{ '1': 1 }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('the upgrade is REFUSED, and the refusal reaches the wire', () => {
  it('an origin outside the allowlist is 403 — before the credential is examined', async () => {
    const out = await upgrade({ origin: 'https://evil.example' });
    expect(out).toEqual({ kind: 'refused', status: 403 });
    // The order is the security property: a refused origin must not learn whether
    // the token it captured is any good.
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('an ABSENT origin is 403 too — a non-browser caller is not a trusted caller', async () => {
    const out = await upgrade({ origin: null });
    expect(out).toEqual({ kind: 'refused', status: 403 });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('an empty allowlist refuses everything, including the configured origin', async () => {
    process.env.TERMINAL_ALLOWED_ORIGINS = '';
    const out = await upgrade({});
    expect(out).toEqual({ kind: 'refused', status: 403 });
  });

  it('no token in the subprotocol is 401', async () => {
    const out = await upgrade({ token: null });
    expect(out).toEqual({ kind: 'refused', status: 401 });
  });

  it('a token the verifier REJECTS is 401 — the null is acted on, not ignored', async () => {
    verdict = null;
    const out = await upgrade({});
    expect(out).toEqual({ kind: 'refused', status: 401 });
    expect(verifyToken).toHaveBeenCalled();
    // This is the assertion #308 could not make: its five tests would all pass even
    // if attachTerminalProxy dropped the verdict on the floor.
  });

  it('an already-expired credential is 401 even when the verifier accepts it', async () => {
    verdict = { sub: 'user-1', roles: [], exp: Math.floor(Date.now() / 1000) - 1 };
    const out = await upgrade({});
    expect(out).toEqual({ kind: 'refused', status: 401 });
  });

  it('a credential with no exp is 401 — fail closed on a missing expiry', async () => {
    verdict = { sub: 'user-1', roles: [] } as never;
    const out = await upgrade({});
    expect(out).toEqual({ kind: 'refused', status: 401 });
  });

  it('a non-participant is 403', async () => {
    mockQuery.mockResolvedValue({ rows: [] });   // not a participant
    const out = await upgrade({});
    expect(out).toEqual({ kind: 'refused', status: 403 });
  });

  it('a thread with no running agent is 404, after access has been allowed', async () => {
    mockQuery.mockImplementation((sql: string) =>
      /JOIN agents/i.test(sql)
        ? Promise.resolve({ rows: [] })                 // no running agent
        : Promise.resolve({ rows: [{ '1': 1 }] }));     // but the user IS a participant
    const out = await upgrade({});
    expect(out).toEqual({ kind: 'refused', status: 404 });
  });

  it('a path that is not a terminal is left alone for other handlers', async () => {
    const out = await upgrade({ path: '/something/else' });
    expect(out.kind).toBe('ignored');
  });
});

describe('the upgrade is ACCEPTED — the control that stops the refusals passing vacuously', () => {
  it('a valid caller gets 101, and the echoed subprotocol never contains the token', async () => {
    dbAllows();
    const out = await upgrade({ token: 'the-secret-token' });

    expect(out.kind).toBe('upgraded');
    if (out.kind !== 'upgraded') return;
    expect(out.status).toBe(101);
    // Only ever the plain version is selected: echoing the bearer entry would put the
    // credential in a response header, which is logged like any other.
    expect(out.protocol).toBe(PROTO);
    expect(out.raw).not.toContain('the-secret-token');
  });

  it('an ADMIN reaches the same 101 without being a thread participant', async () => {
    verdict = { sub: 'admin-1', roles: ['admin'], exp: Math.floor(Date.now() / 1000) + 3600 };
    mockQuery.mockImplementation((sql: string) =>
      /JOIN agents/i.test(sql)
        ? Promise.resolve({ rows: [{ agent_id: 'demo-agent', work_token: 'wt' }] })
        : Promise.resolve({ rows: [] }));   // NOT a participant
    const out = await upgrade({});
    expect(out.kind).toBe('upgraded');
  });
});
