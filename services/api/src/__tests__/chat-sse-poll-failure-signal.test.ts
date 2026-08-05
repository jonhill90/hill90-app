/**
 * app#443, chat.ts's three follow-mode sites: the thread-message poll
 * (`/threads/:id/stream`), the per-agent `tail -f` stream, and the
 * incremental correlation-id refresh (both on `/threads/:id/events`). All
 * three used to catch their own errors, log server-side only, and keep the
 * connection open — heartbeats kept flowing, so the client had no way to
 * tell "nothing new happened" from "this has been silently broken."
 *
 * Same technique as chat-sse-reconnect-cursor.test.ts: mock setInterval to
 * capture the tick function and invoke it directly, rather than waiting on
 * real wall-clock time. Drives the actual route handlers.
 */
import { EventEmitter } from 'events';
import express from 'express';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));
jest.mock('../middleware/role', () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  isAdmin: () => false,
}));

const mockExecInContainer = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: (...args: unknown[]) => mockExecInContainer(...args),
}));

function handlerFor(router: express.Router, path: string): any {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods.get,
  );
  if (!layer) throw new Error(`no GET route registered at ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeReq(query: Record<string, string> = {}) {
  const req: any = new EventEmitter();
  req.params = { id: '11111111-1111-4111-8111-111111111111' };
  req.query = query;
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
    write: jest.fn(() => true),
    end: jest.fn(() => { res.writableEnded = true; }),
    once: jest.fn(),
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

/** Every 'event: error' frame written so far, parsed. */
function errorFrames(res: ReturnType<typeof fakeRes>) {
  return res.write.mock.calls
    .map((c: any[]) => c[0])
    .filter((s: any) => typeof s === 'string' && s.startsWith('event: error'))
    .map((s: string) => JSON.parse(s.split('data: ')[1].trim()));
}

describe('chat.ts /threads/:id/stream poll failure signal', () => {
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

  async function connect() {
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/stream');
    const req = fakeReq();
    const res = fakeRes();

    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // isParticipant
    mockQuery.mockResolvedValueOnce({ rows: [] });                  // BACKFILL_TAIL_SQL
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });    // THREAD_MESSAGE_COUNT_SQL

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const pollTick = capturedIntervals.find((i) => i.ms === 1000);
    if (!pollTick) throw new Error('poll interval (1000ms) was not armed');
    return { res, pollTick };
  }

  // POSITIVE CONTROL, direction one: sustained failure.
  it('a stream whose poll keeps failing emits the error frame within the stated bound (10 consecutive 1s failures)', async () => {
    const { res, pollTick } = await connect();

    for (let i = 0; i < 10; i++) {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      await pollTick.fn();
      await new Promise((r) => setImmediate(r));
    }

    const frames = errorFrames(res);
    expect(frames).toHaveLength(1);
    expect(frames[0].error).toBe('Updates may be delayed');
  });

  // POSITIVE CONTROL, direction two: one transient blip, then recovery.
  it('one failed poll followed by a successful one emits nothing', async () => {
    const { res, pollTick } = await connect();

    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    await pollTick.fn();
    await new Promise((r) => setImmediate(r));

    mockQuery.mockResolvedValueOnce({ rows: [] }); // POLL_SQL succeeds
    await pollTick.fn();
    await new Promise((r) => setImmediate(r));

    expect(errorFrames(res)).toHaveLength(0);
  });

  it('does not end the stream — the frame is informational, not terminal', async () => {
    const { res, pollTick } = await connect();

    for (let i = 0; i < 10; i++) {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      await pollTick.fn();
      await new Promise((r) => setImmediate(r));
    }

    expect(errorFrames(res)).toHaveLength(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(res.writableEnded).toBe(false);
  });

  it('a stream that recovers and later breaks again is told again, not just once for the connection', async () => {
    const { res, pollTick } = await connect();

    for (let i = 0; i < 10; i++) {
      mockQuery.mockRejectedValueOnce(new Error('first outage'));
      await pollTick.fn();
      await new Promise((r) => setImmediate(r));
    }
    expect(errorFrames(res)).toHaveLength(1);

    mockQuery.mockResolvedValueOnce({ rows: [] }); // recovers
    await pollTick.fn();
    await new Promise((r) => setImmediate(r));

    for (let i = 0; i < 10; i++) {
      mockQuery.mockRejectedValueOnce(new Error('second outage'));
      await pollTick.fn();
      await new Promise((r) => setImmediate(r));
    }

    expect(errorFrames(res)).toHaveLength(2);
  });
});

describe('chat.ts /threads/:id/events per-agent tail stream error signal', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM chat_participants\s+WHERE thread_id/.test(sql)) {
        return Promise.resolve({ rows: [{ '?column?': 1 }] }); // isParticipant
      }
      if (/JOIN agents a ON a\.id = cp\.participant_id/.test(sql)) {
        return Promise.resolve({
          rows: [{ participant_id: 'p1', agent_id: 'scout', status: 'running' }],
        });
      }
      if (/SELECT id, seq FROM chat_messages WHERE thread_id = \$1$/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // No interval to capture here — the failure this site guards is a single
  // 'error' event on a tail -f child stream, not a recurring tick, so there
  // is nothing to drive with a mocked setInterval. `end` provides a signal
  // to await instead of a fixed interval index.
  it('a dead per-agent tail stream emits the error frame immediately — no threshold to wait out', async () => {
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/events');
    const req = fakeReq({ follow: 'true' });
    const res = fakeRes();

    const stream = new EventEmitter() as any;
    stream.pause = jest.fn();
    stream.resume = jest.fn();
    stream.destroy = jest.fn();
    mockExecInContainer.mockResolvedValueOnce(stream);

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    stream.emit('error', new Error('container gone'));
    await new Promise((r) => setImmediate(r));

    const frames = errorFrames(res);
    expect(frames).toHaveLength(1);
    expect(frames[0].error).toBe('An agent stream stopped');
    expect(frames[0].detail).toContain('scout');
    // Does not end the connection — other agents, if any, may still be fine.
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe('chat.ts /threads/:id/events incremental correlation refresh failure signal', () => {
  let capturedIntervals: Array<{ fn: () => any; ms: number }>;

  beforeEach(() => {
    // execInContainer rejects: the route's own try/catch around opening each
    // agent's tail -f logs "Failed to open stream" and moves on, so the
    // agent-stream mechanics stay out of the way of the refresh-interval
    // assertions below. A thread with ZERO running agents cannot be used for
    // this instead — the route returns 409 before ever reaching SSE setup.
    mockExecInContainer.mockReset();
    mockExecInContainer.mockRejectedValue(new Error('not needed for this test'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    capturedIntervals = [];
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms?: any) => {
      capturedIntervals.push({ fn, ms });
      return {} as any;
    }) as any);
    jest.spyOn(global, 'clearInterval').mockImplementation((() => {}) as any);

    mockQuery.mockReset();
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM chat_participants\s+WHERE thread_id/.test(sql)) {
        return Promise.resolve({ rows: [{ '?column?': 1 }] });
      }
      if (/JOIN agents a ON a\.id = cp\.participant_id/.test(sql)) {
        return Promise.resolve({
          rows: [{ participant_id: 'p1', agent_id: 'scout', status: 'running' }],
        });
      }
      if (/SELECT id, seq FROM chat_messages WHERE thread_id = \$1$/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function connect() {
    const chatRouter = (await import('../routes/chat')).default;
    const handler = handlerFor(chatRouter, '/threads/:id/events');
    const req = fakeReq({ follow: 'true' });
    const res = fakeRes();

    await handler(req, res, jest.fn());
    await new Promise((r) => setImmediate(r));

    const refreshTick = capturedIntervals.find((i) => i.ms === 5000);
    if (!refreshTick) throw new Error('refresh interval (5000ms default) was not armed');
    return { res, refreshTick };
  }

  // POSITIVE CONTROL, direction one: sustained failure. Default cadence is
  // 5000ms, so failureThresholdFor(5000) = ceil(10000/5000) = 2.
  it('a refresh that keeps failing emits the error frame within the stated bound (2 consecutive 5s failures)', async () => {
    const { res, refreshTick } = await connect();

    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await refreshTick.fn();
    await new Promise((r) => setImmediate(r));
    expect(errorFrames(res)).toHaveLength(0); // one failure, below threshold 2

    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await refreshTick.fn();
    await new Promise((r) => setImmediate(r));

    const frames = errorFrames(res);
    expect(frames).toHaveLength(1);
    expect(frames[0].error).toBe('New messages may not be detected');
  });

  // POSITIVE CONTROL, direction two: one transient blip, then recovery.
  it('one failed refresh followed by a successful one emits nothing', async () => {
    const { res, refreshTick } = await connect();

    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await refreshTick.fn();
    await new Promise((r) => setImmediate(r));

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await refreshTick.fn();
    await new Promise((r) => setImmediate(r));

    expect(errorFrames(res)).toHaveLength(0);
  });
});
