/**
 * The terminal proxy must not queue without limit for a peer that is not reading.
 *
 * THE DEFECT, at the proxy rather than in the policy module: both directions
 * relayed with a bare send and consulted `bufferedAmount` nowhere —
 *
 *     agentWs.on('message', (data, isBinary) => {
 *       if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
 *     });
 *
 * — so a peer that stops reading accumulates the whole stream inside this
 * process. `app-api` declares no mem_limit (issue #144), so the ceiling was the
 * VPS's memory, shared with the platform.
 *
 * This drives the client → agentbox direction, because the agentbox side is the
 * stub here and its `bufferedAmount` can therefore be held at "not reading".
 * Before the fix the proxy relays every message regardless and the session stays
 * open; after it, the session ends with a stated reason once the queue passes the
 * hard cap.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { EventEmitter } from 'events';

/** Stands in for agentbox, with a queue depth the test controls. */
class StalledAgentbox extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = StalledAgentbox.OPEN;
  bufferedAmount = 0;
  sent: unknown[] = [];
  _socket = { pause: () => {}, resume: () => {} };
  static latest: StalledAgentbox | null = null;

  constructor(_url: string) {
    super();
    StalledAgentbox.latest = this;
    setImmediate(() => this.emit('open'));
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  ping(): void {}
  close(): void {
    this.readyState = StalledAgentbox.CLOSED;
    this.emit('close');
  }
}

jest.mock('ws', () => {
  const actual = jest.requireActual('ws');
  return { ...actual, WebSocket: StalledAgentbox, WebSocketServer: actual.WebSocketServer };
});

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

import { attachTerminalProxy } from '../services/terminal-proxy';

const RealWebSocket = jest.requireActual('ws').WebSocket;

const ORIGIN = 'https://hill90.com';
const PROTOCOLS = ['hill90.terminal.v1', 'hill90.bearer.tok'];
const PATH = '/chat/threads/thread-1/terminal';

let server: http.Server;
let port: number;
/**
 * Every client this test opens. server.close() waits for open connections, so a
 * test that leaves one up hangs the afterEach rather than failing — which is how
 * the guard-rail case first presented, as a 5s hook timeout with nothing wrong
 * in the assertion.
 */
const openClients: any[] = [];

beforeEach(async () => {
  process.env.TERMINAL_ALLOWED_ORIGINS = ORIGIN;
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ agent_id: 'scout', work_token: 'wt' }] });
  StalledAgentbox.latest = null;
  openClients.length = 0;

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

describe('the terminal relay is bounded when a peer stops reading', () => {
  it('ends the session with a stated reason once the queue passes the hard cap', async () => {
    const { ws, closed } = await connect();

    // agentbox has stopped reading: everything sent to it is queueing here.
    await new Promise((r) => setImmediate(r));
    const upstream = StalledAgentbox.latest!;
    upstream.bufferedAmount = 9 * 1024 * 1024; // above the 8 MB cap

    ws.send('a');
    ws.send('b');
    ws.send('c');

    const { code, reason } = await Promise.race([
      closed,
      new Promise<{ code: number; reason: string }>((r) =>
        setTimeout(() => r({ code: -1, reason: 'STILL OPEN' }), 4000),
      ),
    ]);

    // Not merely closed — closed for this reason. A relay that silently stopped
    // forwarding would be indistinguishable from an idle terminal.
    expect(code).toBe(4003);
    expect(reason.toLowerCase()).toMatch(/buffer|backpressure|not reading/);
  }, 10000);

  it('stops forwarding once it has given up, rather than queueing more', async () => {
    const { ws } = await connect();
    await new Promise((r) => setImmediate(r));
    const upstream = StalledAgentbox.latest!;
    upstream.bufferedAmount = 9 * 1024 * 1024;

    ws.send('first');
    await new Promise((r) => setTimeout(r, 300));
    ws.send('second');
    ws.send('third');
    await new Promise((r) => setTimeout(r, 300));

    expect(upstream.sent.length).toBeLessThanOrEqual(1);
  }, 10000);

  // Guard rail: an ordinary session must relay normally.
  it('relays normally when the peer is reading', async () => {
    const { ws } = await connect();
    await new Promise((r) => setImmediate(r));
    const upstream = StalledAgentbox.latest!;
    upstream.bufferedAmount = 0;

    ws.send('ls');
    await new Promise((r) => setTimeout(r, 300));

    // ws delivers frames as Buffers; compare content, not identity.
    expect(upstream.sent.map((d) => String(d))).toContain('ls');
  }, 10000);
});
