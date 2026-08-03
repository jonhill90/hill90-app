/**
 * The SSE write policy, tested as a decision rather than through a socket.
 *
 * The end-to-end case (sse-backpressure.test.ts) proves the wiring with a real
 * stalled client. These pin the rules that wiring depends on.
 */
import { createBoundedSseWriter, SSE_DEFAULTS, SseResponse, PausableSource } from '../services/sse-writer';

interface FakeRes extends SseResponse {
  written: string[];
  accept: boolean;
  emitDrain(): void;
}

function fakeRes(overrides: Partial<SseResponse> = {}): FakeRes {
  const drainListeners: Array<() => void> = [];
  const res: FakeRes = {
    written: [] as string[],
    accept: true,
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
    write(chunk: string): boolean {
      res.written.push(chunk);
      return res.accept;
    },
    once(_event: 'drain', listener: () => void) {
      drainListeners.push(listener);
    },
    emitDrain() {
      drainListeners.splice(0).forEach((l) => l());
    },
    ...overrides,
  };
  return res;
}

function fakeSource(): PausableSource & { paused: boolean } {
  const s = {
    paused: false,
    pause() { s.paused = true; },
    resume() { s.paused = false; },
  };
  return s;
}

describe('createBoundedSseWriter', () => {
  it('writes through and leaves the source alone while the client keeps up', () => {
    const res = fakeRes();
    const src = fakeSource();
    const w = createBoundedSseWriter(res as unknown as SseResponse, {
      hardCapBytes: SSE_DEFAULTS.hardCapBytes,
      onOverflow: jest.fn(),
    });
    w.setSource(src);

    expect(w.write('data: hello\n\n')).toBe(true);
    expect(res.written).toEqual(['data: hello\n\n']);
    expect(src.paused).toBe(false);
  });

  it('pauses the source when the response reports it is full', () => {
    const res = fakeRes();
    res.accept = false; // write() returns false: the socket buffer is full
    const src = fakeSource();
    const w = createBoundedSseWriter(res as unknown as SseResponse, {
      hardCapBytes: SSE_DEFAULTS.hardCapBytes,
      onOverflow: jest.fn(),
    });
    w.setSource(src);

    w.write('data: x\n\n');

    expect(src.paused).toBe(true);
  });

  it('resumes the source on drain', () => {
    const res = fakeRes();
    res.accept = false;
    const src = fakeSource();
    const w = createBoundedSseWriter(res as unknown as SseResponse, {
      hardCapBytes: SSE_DEFAULTS.hardCapBytes,
      onOverflow: jest.fn(),
    });
    w.setSource(src);
    w.write('data: x\n\n');
    expect(src.paused).toBe(true);

    res.emitDrain();

    expect(src.paused).toBe(false);
  });

  it('gives up once the queue passes the hard cap', () => {
    const res = fakeRes();
    res.writableLength = SSE_DEFAULTS.hardCapBytes + 1;
    const onOverflow = jest.fn();
    const w = createBoundedSseWriter(res as unknown as SseResponse, {
      hardCapBytes: SSE_DEFAULTS.hardCapBytes,
      onOverflow,
    });

    const accepted = w.write('data: x\n\n');

    expect(accepted).toBe(false);
    expect(onOverflow).toHaveBeenCalledWith(SSE_DEFAULTS.hardCapBytes + 1);
    // The frame is refused, not queued on top of a queue that is already too big.
    expect(res.written).toEqual([]);
  });

  it('refuses everything after an overflow, and reports it once', () => {
    const res = fakeRes();
    res.writableLength = SSE_DEFAULTS.hardCapBytes + 1;
    const onOverflow = jest.fn();
    const w = createBoundedSseWriter(res as unknown as SseResponse, {
      hardCapBytes: SSE_DEFAULTS.hardCapBytes,
      onOverflow,
    });

    w.write('a');
    w.write('b');
    w.write('c');

    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(w.overflowed).toBe(true);
    expect(res.written).toEqual([]);
  });

  it('does not write to a response that has ended', () => {
    const res = fakeRes({ writableEnded: true });
    const w = createBoundedSseWriter(res as unknown as SseResponse, {
      hardCapBytes: SSE_DEFAULTS.hardCapBytes,
      onOverflow: jest.fn(),
    });

    expect(w.write('data: x\n\n')).toBe(false);
    expect(res.written).toEqual([]);
  });
});
