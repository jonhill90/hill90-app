/**
 * A token with no `sub` must be refused BEFORE the upgrade, on the wire — not
 * merely rejected inside `verifyTerminalToken` in isolation (#313).
 *
 * `terminal-upgrade.test.ts` proves `attachTerminalProxy` acts on whatever
 * `verifyToken` returns, but its `verifyToken` is a jest mock — it never runs
 * the real verifier, so it cannot prove THIS fix. This file wires the real
 * `verifyTerminalToken` into a real `http.Server`, signs a real token with no
 * `sub`, and drives a genuine upgrade request with `http.request` — the same
 * technique `terminal-upgrade.test.ts` uses and for the same reason: the
 * proxy answers a refusal by writing a raw `HTTP/1.1 4xx` and destroying the
 * socket, and a client library's interpretation of that sits between the
 * assertion and the behaviour a real caller sees.
 *
 * REFUSED AT VERIFY TIME, NOT LATER. The check lives inside
 * `verifyTerminalToken`, so a sub-less token never reaches `isParticipant` and
 * the socket is never handed to `wss.handleUpgrade` at all — a refusal after
 * the handshake would be a different and worse thing than one before it: the
 * caller would have already been treated as a connected principal.
 *
 * WHAT TODAY'S EXPOSURE ACTUALLY IS, so this isn't read as more urgent than it
 * is: production's `hill90-ui` carries the `basic` client scope (#278, #306),
 * so no production token lacks `sub`. This path is reachable on a
 * misconfigured or local realm — the same bound #306 stated for the HTTP
 * boundary — and that bound is real, not a reason to leave the WS boundary
 * more permissive than the one #306 already closed.
 */
import * as http from 'http';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { attachTerminalProxy } from '../services/terminal-proxy';
import { verifyTerminalToken } from '../services/terminal-token';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
}));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISSUER = 'https://test-issuer.example.com/realms/platform';
const getSigningKey = async () => publicKey as unknown as string;

const ORIGIN = 'https://hill90.example';
const PROTO = 'hill90.terminal.v1';
const THREAD = '11111111-2222-3333-4444-555555555555';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => { res.writeHead(200); res.end('not the ws path'); });
  attachTerminalProxy(server, (token: string) => verifyTerminalToken(token, { issuer: ISSUER, getSigningKey }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  // Not awaited — see terminal-upgrade.test.ts's identical note. An accepted
  // upgrade in the twin below leaves an outbound connection to
  // ws://agentbox-<slug>:8054 whose DNS lookup does not fail quickly.
  server.closeAllConnections?.();
  server.close();
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockQuery.mockReset();
  // Baseline: not a participant, not a crash. Without this, a sub-less token
  // that isn't refused at verify time reaches `isParticipant('', threadId)`
  // against an unconfigured mock (resolves `undefined`), which throws deep
  // inside the handler and hangs the socket instead of answering with a
  // status this test can read — a test-harness artifact, not evidence about
  // the fix.
  mockQuery.mockResolvedValue({ rows: [] });
  process.env.TERMINAL_ALLOWED_ORIGINS = ORIGIN;
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.TERMINAL_ALLOWED_ORIGINS; });

type Outcome =
  | { kind: 'refused'; status: number }
  | { kind: 'upgraded'; status: number }
  | { kind: 'ignored' };

/** A genuine upgrade request — same technique as terminal-upgrade.test.ts. */
function upgrade(token: string): Promise<Outcome> {
  const headers: Record<string, string> = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
    Origin: ORIGIN,
    'Sec-WebSocket-Protocol': `${PROTO}, hill90.bearer.${token}`,
  };
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET',
      path: `/chat/threads/${THREAD}/terminal`,
      headers,
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ kind: 'ignored' }); }, 3000);
    // THE ASSERTION THIS FILE EXISTS FOR: the refusal must arrive as an HTTP
    // response on this socket — a `response` event with a status code — not as
    // a promise rejection inside `verifyTerminalToken` that nothing on the
    // wire ever reflects. If the fix instead threw past its own try/catch,
    // this request would hang until the timer fires 'ignored', not 'refused'.
    req.on('response', (res) => { clearTimeout(timer); res.resume(); resolve({ kind: 'refused', status: res.statusCode ?? 0 }); });
    req.on('upgrade', (res, socket) => { clearTimeout(timer); socket.destroy(); resolve({ kind: 'upgraded', status: res.statusCode ?? 0 }); });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

function dbAllows() {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM chat_participants/i.test(sql) && /JOIN agents/i.test(sql)) {
      return Promise.resolve({ rows: [{ agent_id: 'demo-agent', work_token: 'wt' }] });
    }
    if (/chat_participants/i.test(sql)) return Promise.resolve({ rows: [{ '1': 1 }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('a token with no sub, real end to end, against the real verifier (#313)', () => {
  it('is refused with 401 on the wire, before the socket is ever upgraded', async () => {
    const noSubToken = jwt.sign({}, privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });

    const out = await upgrade(noSubToken);

    expect(out).toEqual({ kind: 'refused', status: 401 });
    // The participation query must never have been reached — refused at
    // verify time means the request never got far enough to ask.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('TWIN: the identical token, with a sub, still upgrades', async () => {
    dbAllows();
    const good = jwt.sign({ sub: 'user-1' }, privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });

    const out = await upgrade(good);

    expect(out.kind).toBe('upgraded');
  });
});
