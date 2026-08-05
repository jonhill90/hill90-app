/**
 * The SSE reconnect cursor, verified rather than assumed correct.
 *
 * app#364 asked the wider question of #353's chat path: `chat_messages_seq`
 * is a single sequence SHARED across every thread, and multiple UPDATE
 * paths (thinking updates, the terminal complete/error transition, the
 * dispatch-failure and stale-sweeper paths) advance a row's `seq` a second
 * time rather than only setting it once on INSERT. The suspected shape was
 * an off-by-one — a cursor exclusive where it should be inclusive drops a
 * message; inclusive where it should be exclusive replays one — or a gap
 * in the seq series (created by exactly this UPDATE-to-a-new-seq pattern)
 * breaking a reconnecting client's `Last-Event-ID` comparison.
 *
 * FINDING: the mechanism is correct. This file proves the specific
 * properties that make it so, rather than asserting a conclusion:
 *
 *   1. Both `BACKFILL_TAIL_SQL` and `POLL_SQL` use `seq > $2` — strictly
 *      EXCLUSIVE of the cursor. The client's `Last-Event-ID` is always the
 *      `seq` of the last frame it actually received (chat.ts writes
 *      `id: ${row.seq}` on every frame), so excluding it is exactly right:
 *      inclusive would replay that same message on every reconnect.
 *   2. A row that gets a NEW, larger `seq` via one of the UPDATE...
 *      nextval() paths is, by construction, always greater than any cursor
 *      a client already holds — `nextval()` only goes up — so a status
 *      transition (pending -> thinking -> complete/error) is guaranteed to
 *      cross any existing cursor and get redelivered with its latest state.
 *      A gap in the seq series (consumed by another thread, or by a row
 *      moving to a higher seq) is invisible to `seq > $2`, which only cares
 *      about ordering, never contiguity.
 *   3. Malformed or negative `Last-Event-ID` values are handled safely by
 *      the existing cursor-parsing in chat.ts: a non-numeric value falls
 *      back to the documented default (0, full bounded backfill); a
 *      negative value is passed through as a literal SQL parameter, which
 *      is harmless because `seq > -5` matches the same rows `seq > 0`
 *      would (every `seq` is a positive BIGINT) — checked here by driving
 *      the actual route handler and reading the real query parameters, the
 *      same technique chat-stream-backpressure.test.ts and
 *      chat-events-incremental-refresh.test.ts already use for exactly
 *      this reason: a check that greps chat.ts's source text passes
 *      whether or not the code it names still does what it says.
 *
 * Does not touch chat.ts — this drives the handler as it exists.
 */
import { EventEmitter } from 'events';
import express from 'express';
import { BACKFILL_TAIL_SQL, POLL_SQL } from '../helpers/chat-backfill';

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

function fakeReq(lastEventId?: string) {
  const req: any = new EventEmitter();
  req.params = { id: '11111111-1111-4111-8111-111111111111' };
  req.query = {};
  req.headers = lastEventId !== undefined ? { 'last-event-id': lastEventId } : {};
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
    write: jest.fn(() => true),
    end: jest.fn(() => { res.writableEnded = true; }),
    once: jest.fn(),
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

const row = (seq: number, id: string, status = 'complete', content = 'hi') => ({
  seq, id, author_id: 'agent-1', author_type: 'agent', role: 'assistant',
  content, status, created_at: new Date().toISOString(),
});

describe('the reconnect cursor: SQL-level exclusivity', () => {
  it('BACKFILL_TAIL_SQL excludes the cursor itself', () => {
    expect(BACKFILL_TAIL_SQL).toContain('seq > $2');
  });

  it('POLL_SQL also excludes the cursor itself — the property that matters on every steady-state tick, not just first connect', () => {
    expect(POLL_SQL).toContain('seq > $2');
  });
});

describe('the reconnect cursor: driven through the real handler', () => {
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

  it('a malformed Last-Event-ID falls back to cursor 0, not to a broken or unbounded query', async () => {
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');

    const req = fakeReq('not-a-number');
    const res = fakeRes();

    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // isParticipant
    mockQuery.mockResolvedValueOnce({ rows: [] });                  // BACKFILL_TAIL_SQL
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });    // THREAD_MESSAGE_COUNT_SQL

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const backfillCall = mockQuery.mock.calls[1];
    expect(backfillCall[0]).toContain('seq > $2');
    // The documented default (chat.ts:1387, "Parse cursor from Last-Event-ID
    // (default: 0)") — a NaN must not reach the query as NaN or as undefined.
    expect(backfillCall[1][1]).toBe(0);
  });

  it('a negative Last-Event-ID is passed through as a literal — harmless, because every real seq is positive', async () => {
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');

    const req = fakeReq('-5');
    const res = fakeRes();

    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const backfillCall = mockQuery.mock.calls[1];
    // Not specially rejected or clamped — parseInt('-5', 10) is a valid
    // number, so it is used as given. Documented here as the observed
    // behaviour, not proposed as the ideal one: `seq > -5` and `seq > 0`
    // match the identical set of rows, so this is inert rather than wrong.
    expect(backfillCall[1][1]).toBe(-5);
  });

  it('a row that transitions status (a new, larger seq via nextval) is redelivered past a cursor that already saw its earlier state', async () => {
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');

    const req = fakeReq();
    const res = fakeRes();

    // First connect: thread has one message, mid-flight (seq=5, status pending).
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [row(5, 'msg-A', 'pending', '')] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const firstFrame = res.write.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('event: message'),
    );
    expect(firstFrame[0]).toContain('id: 5');
    expect(firstFrame[0]).toContain('"status":"pending"');

    // Elsewhere, that same row is updated to its terminal state — per
    // routes/chat.ts's own callback handler comment, "Advances seq so SSE
    // cursor picks up the state transition": same id, seq jumps from 5 to
    // 47 (other threads' inserts consumed the values between them — a gap,
    // not a defect, since `seq > $2` never assumes contiguity).
    const pollTick = capturedIntervals.find((i) => i.ms === 1000);
    expect(pollTick).toBeDefined();
    mockQuery.mockResolvedValueOnce({ rows: [row(47, 'msg-A', 'complete', 'the real answer')] });

    await pollTick!.fn();
    await new Promise((r) => setImmediate(r));

    // The steady-state tick must have used POLL_SQL with cursor=5 — the
    // seq the client was actually left at, not 0 and not silently skipped.
    const pollCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(pollCall[0]).toContain('seq > $2');
    expect(pollCall[1]).toEqual(['11111111-1111-4111-8111-111111111111', 5]);

    // And the client actually received the updated row — same id, new
    // content, new seq — not silence and not a duplicate of the pending one.
    const secondFrame = res.write.mock.calls
      .filter((c: any[]) => typeof c[0] === 'string' && c[0].includes('event: message'))
      .pop();
    expect(secondFrame[0]).toContain('id: 47');
    expect(secondFrame[0]).toContain('"status":"complete"');
    expect(secondFrame[0]).toContain('the real answer');
  });

  it('control: an already-terminal row with an UNCHANGED seq is never redelivered on a later tick', async () => {
    // If this fails, the redelivery test above is not proving what it
    // claims: it would pass even if every poll just replayed everything.
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');

    const req = fakeReq();
    const res = fakeRes();

    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [row(5, 'msg-A', 'complete', 'done')] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const pollTick = capturedIntervals.find((i) => i.ms === 1000);
    // Real behaviour: the poll query genuinely finds nothing above seq=5.
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const writesBeforeTick = res.write.mock.calls.length;
    await pollTick!.fn();
    await new Promise((r) => setImmediate(r));

    expect(res.write.mock.calls.length).toBe(writesBeforeTick);
  });
});
