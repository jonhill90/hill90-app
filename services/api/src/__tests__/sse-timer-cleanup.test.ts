/**
 * An SSE handler must not leak its timers when the client disconnects during setup.
 *
 * THE BUG, in `GET /chat/threads/:id/stream`. The order of operations is:
 *
 *     await isParticipant(...)          // await #1
 *     res.flushHeaders()
 *     await poll()                      // await #2 — a database round trip
 *     const interval  = setInterval(poll, 1000)
 *     const heartbeat = setInterval(..., 30000)
 *     req.on('close', () => { clearInterval(interval); clearInterval(heartbeat) })
 *
 * The close listener is registered LAST, after two awaits. If the client goes away
 * during either of them — which is the normal outcome of a page navigation while the
 * backfill query is in flight — Node emits `'close'` on the request with no listener
 * attached. Events are not replayed, so the listener registered a moment later never
 * fires, and both intervals run for the lifetime of the process.
 *
 * `req.on('close')` is the ONLY cleanup path in this handler. Unlike the agent event
 * stream, which also clears on `stream.on('end')` and `stream.on('error')`, there is
 * no second chance here.
 *
 * WHAT THIS IS AND IS NOT. It is a resource leak, worth fixing because a timer that
 * outlives its response is a bug regardless of anything else. It is NOT a fix for the
 * api suite's flakiness and must not be described as one: `poll` returns early when
 * `res.writableEnded || res.destroyed`, so a leaked interval performs no database work
 * and cannot consume a queued mock value. See docs/decisions/api-suite-flakiness.md.
 */

import { EventEmitter } from 'events';
import express from 'express';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));
jest.mock('../middleware/role', () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  isAdmin: () => false,
}));

/** Pull the final handler out of the router layer for a given route path. */
function handlerFor(router: express.Router, path: string): any {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods.get,
  );
  if (!layer) throw new Error(`no GET route registered at ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

/** A request that behaves like a client which disconnected during setup. */
function fakeReq() {
  const req: any = new EventEmitter();
  req.params = { id: '11111111-1111-4111-8111-111111111111' };
  req.query = {};
  // The handler reads req.headers['last-event-id'] for SSE resume. Omitting it threw
  // a TypeError that the handler's own catch swallowed, so the first version of this
  // test failed with "setInterval never called" — a symptom two steps from the cause.
  req.headers = {};
  req.user = { sub: 'user-1', roles: ['user'] };
  req.destroyed = false;
  return req;
}

function fakeRes() {
  const res: any = {
    headersSent: true,
    writableEnded: false,
    destroyed: false,
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

describe('SSE handlers release their timers when the client disconnects during setup', () => {
  let setIntervalSpy: jest.SpyInstance;
  let clearIntervalSpy: jest.SpyInstance;
  const live = new Set<any>();

  beforeEach(() => {
    live.clear();
    mockQuery.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockImplementation(((fn: any, ms?: any) => {
        const h = realSet(fn, ms as any);
        live.add(h);
        return h;
      }) as any);
    clearIntervalSpy = jest
      .spyOn(global, 'clearInterval')
      .mockImplementation(((h: any) => {
        live.delete(h);
        return realClear(h);
      }) as any);
  });

  afterEach(() => {
    // Never leave a real timer behind, whatever the assertions did.
    for (const h of live) clearInterval(h);
    live.clear();
    jest.restoreAllMocks();
  });

  it('clears both intervals when close fires BEFORE the listener is attached', async () => {
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');

    const req = fakeReq();
    const res = fakeRes();

    // isParticipant's query resolves normally.
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    // The backfill poll's query is where the client goes away. Emitting 'close'
    // here reproduces a page navigation during the backfill: the handler has not
    // reached `req.on('close', ...)` yet, so nothing is listening.
    mockQuery.mockImplementationOnce(async () => {
      req.destroyed = true;
      res.destroyed = true;
      req.emit('close');
      return { rows: [] };
    });
    mockQuery.mockResolvedValue({ rows: [] });

    await handler(req, res, jest.fn());
    // Let any microtasks settle so a correct implementation has had its chance.
    await new Promise((r) => setImmediate(r));

    // The property is that NO timer survives the disconnect — not that any particular
    // number was created. A correct handler may legitimately create none at all, having
    // noticed the client left before it got that far, and an earlier version of this
    // assertion demanded two and so failed against the fix. Assert the outcome.
    const created = setIntervalSpy.mock.results.map((r) => r.value);
    const cleared = clearIntervalSpy.mock.calls.map((c) => c[0]);
    // Report the leak by its interval period, not the handle object — dumping a Node
    // Timeout produces ~40 lines of circular internals and buries the point.
    const leaked = created
      .filter((h) => !cleared.includes(h))
      .map((h: any) => `${h._idleTimeout}ms`);

    expect(leaked).toEqual([]);
    expect(live.size).toBe(0);
  });

  it('still clears both intervals on a normal disconnect, after the listener exists', async () => {
    // The control. If this fails, the first test proves nothing — a handler that
    // never creates intervals at all would satisfy it.
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');

    const req = fakeReq();
    const res = fakeRes();
    // The participation check must PASS, or the handler 404s and creates no intervals
    // at all — which would satisfy the leak assertions in the other test for entirely
    // the wrong reason. That is what this control exists to rule out.
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValue({ rows: [] });

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const created = setIntervalSpy.mock.results.map((r) => r.value);
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(live.size).toBeGreaterThan(0); // still streaming: timers must be ALIVE

    req.destroyed = true;
    res.destroyed = true;
    req.emit('close');

    expect(live.size).toBe(0);
  });
});
