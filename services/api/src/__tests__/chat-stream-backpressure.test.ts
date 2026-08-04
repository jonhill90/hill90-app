/**
 * `GET /chat/threads/:id/stream` must not buffer a stalled client without
 * limit (#204).
 *
 * THE DEFECT, established by reading the route before trusting the issue
 * text: every frame went through a raw `res.write()` — return value
 * discarded, no 'drain' listener, no `writableLength` check anywhere in the
 * handler. `services/sse-writer.ts` exists for exactly this and
 * `routes/agents.ts` already adopted it; this route had not
 * (`grep -c "sse-writer" src/routes/chat.ts` was 0).
 *
 * WHAT A SLOW CLIENT ACTUALLY EXPERIENCES on the unfixed route: nothing
 * observable to the client itself — no error, no dropped message, the
 * connection just stays open. The cost lands on the SERVER: `res.write()`
 * keeps being called every poll tick regardless of how full the socket
 * buffer already is, so Node keeps queuing frames in process memory for the
 * lifetime of the connection. That is "buffered without limit", not
 * "dropped" and not "blocks something else" — the poll interval keeps
 * ticking and keeps querying the database on schedule throughout.
 *
 * THE TEST drives the handler directly (same technique as
 * sse-timer-cleanup.test.ts) rather than a real socket, because the
 * observable here is server-side: does production stop when the client's
 * buffer is already over the cap, not whether bytes crossed a kernel socket.
 * `res.writableLength` is set to simulate a reader that is not draining the
 * socket, matching what a stalled real client leaves behind.
 */

import { EventEmitter } from 'events';
import express from 'express';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));
jest.mock('../middleware/role', () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  isAdmin: () => false,
}));

function handlerFor(router: express.Router, path: string): any {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods.get,
  );
  if (!layer) throw new Error(`no GET route registered at ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeReq() {
  const req: any = new EventEmitter();
  req.params = { id: '11111111-1111-4111-8111-111111111111' };
  req.query = {};
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
    writableLength: 0,
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(() => true), // a healthy socket accepts the write immediately
    // Matches real Node: writableEnded becomes true synchronously once end() is called.
    end: jest.fn(() => { res.writableEnded = true; }),
    once: jest.fn(),
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

const row = (seq: number) => ({
  seq, id: `m-${seq}`, author_id: 'user-1', author_type: 'user', role: 'user',
  content: 'x'.repeat(1000), status: 'sent', created_at: new Date().toISOString(),
});

describe('the chat stream stops producing for a client whose buffer is already full', () => {
  let capturedIntervals: Array<{ fn: () => any; ms: number }>;

  beforeEach(() => {
    mockQuery.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    capturedIntervals = [];
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms?: any) => {
      capturedIntervals.push({ fn, ms });
      return {} as any;
    }) as any);
    jest.spyOn(global, 'clearInterval').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not hand a poll tick new rows once writableLength has passed the hard cap', async () => {
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');

    const req = fakeReq();
    const res = fakeRes();

    // isParticipant, then the backfill's two queries — the socket is not
    // congested yet, so the backfill goes through normally.
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // isParticipant
    mockQuery.mockResolvedValueOnce({ rows: [] }); // BACKFILL_TAIL_SQL: empty thread
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // THREAD_MESSAGE_COUNT_SQL

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const pollTick = capturedIntervals.find((i) => i.ms === 1000);
    expect(pollTick).toBeDefined();

    // A client that has stopped reading: 9 MB already queued in the
    // response, past sse-writer's 8 MB cap, exactly as a stalled browser tab
    // would leave the socket.
    res.writableLength = 9 * 1024 * 1024;
    mockQuery.mockResolvedValueOnce({ rows: [row(1), row(2)] });

    await pollTick!.fn();
    await new Promise((r) => setImmediate(r));

    // The production defect: with no cap check, the handler wrote the new
    // rows to the response regardless of how full it already was.
    const wroteMessageFrame = res.write.mock.calls.some(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('event: message'),
    );
    expect(wroteMessageFrame).toBe(false);

    // The stream must actually end for a reader nobody is behind, not just
    // silently stop emitting — an SSE stream that goes quiet is
    // indistinguishable from an idle one otherwise.
    expect(res.end).toHaveBeenCalled();
    expect(res.write.mock.calls.some(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('event: error'),
    )).toBe(true);

    // And the producer must have been told to stop, not merely have its
    // output discarded: a further tick must not query the database again for
    // a stream that has already ended.
    const queriesBeforeSecondTick = mockQuery.mock.calls.length;
    await pollTick!.fn();
    expect(mockQuery.mock.calls.length).toBe(queriesBeforeSecondTick);
  });

  it('control: a client that keeps draining still receives new rows on the next tick', async () => {
    // If this fails, the assertions above are vacuous — proof the harness
    // can observe a write actually happening, not just its absence.
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');

    const req = fakeReq();
    const res = fakeRes();

    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const pollTick = capturedIntervals.find((i) => i.ms === 1000);

    // Buffer stays well under the cap — a healthy, reading client.
    res.writableLength = 100;
    mockQuery.mockResolvedValueOnce({ rows: [row(1)] });

    await pollTick!.fn();
    await new Promise((r) => setImmediate(r));

    const wroteMessageFrame = res.write.mock.calls.some(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('event: message'),
    );
    expect(wroteMessageFrame).toBe(true);
  });
});
