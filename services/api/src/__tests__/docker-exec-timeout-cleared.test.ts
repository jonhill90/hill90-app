/**
 * A command that finishes must not leave its timeout armed.
 *
 * THE DEFECT, in both `execInContainerWithExit` and `execWithStdin`:
 *
 *     const timeoutPromise = new Promise<never>((_, reject) => {
 *       setTimeout(() => { rawStream.destroy(); reject(...); }, timeoutMs);
 *     });
 *     await Promise.race([streamPromise, timeoutPromise]);
 *
 * `Promise.race` settles the moment the command finishes and the function
 * returns — but the timer stayed armed for its whole window, holding `rawStream`
 * and the closure. `grep -c clearTimeout src/services/docker.ts` returned 0.
 *
 * WHY IT WAS INVISIBLE. Nothing goes wrong when it eventually fires:
 * `rawStream.destroy()` on a finished stream is a no-op, and the late `reject` is
 * handled, because `Promise.race` leaves handlers attached to every input. That
 * was measured, not assumed: a settled race whose loser rejects afterwards
 * produces zero `unhandledRejection` events. It never crashed. It accrued.
 *
 * INSTALL_TIMEOUTS is builtin 30s / apt 120s / binary 300s and MAX_INSTALL_RETRIES
 * means one install arms several, so under install activity these overlap.
 *
 * WHY getTimerCount AND NOT A WAIT. This asserts the leak, not its consequence. A
 * test that advanced the clock and checked nothing bad happened would pass on the
 * unfixed code too — the whole problem is that firing late is harmless. The only
 * observable that distinguishes fixed from broken is whether the timer is still
 * ARMED when the call returns. Same instrument as relay-backpressure.test.ts.
 */
import { Readable } from 'stream';

const mockInspectContainer = jest.fn();
const mockExecCreate = jest.fn();
const mockExecStart = jest.fn();
const mockExecInspect = jest.fn();

jest.mock('dockerode', () =>
  jest.fn().mockImplementation(() => ({
    getContainer: () => ({
      inspect: mockInspectContainer,
      exec: mockExecCreate,
    }),
  })),
);

import { execInContainerWithExit, execWithStdin } from '../services/docker';

/** A docker multiplexed frame: 8-byte header, then the payload. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1; // stdout
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** A command that completes immediately — the race's winner. */
function finishedStream(): Readable & { write?: unknown; end?: unknown } {
  const s = Readable.from([frame('done\n')]) as Readable & { write?: unknown; end?: unknown };
  // execWithStdin writes to the hijacked stream; accept and ignore.
  s.write = jest.fn();
  s.end = jest.fn();
  return s;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockInspectContainer.mockReset();
  mockExecCreate.mockReset();
  mockExecStart.mockReset();
  mockExecInspect.mockReset();

  mockInspectContainer.mockResolvedValue({
    Config: { Labels: { 'managed-by': 'hill90-api' } },
  });
  mockExecCreate.mockImplementation(async () => ({
    start: mockExecStart,
    inspect: mockExecInspect,
  }));
  mockExecStart.mockImplementation(async () => finishedStream());
  mockExecInspect.mockResolvedValue({ ExitCode: 0 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the exec timeout is cancelled when the command wins the race', () => {
  it('execInContainerWithExit leaves no timer armed after the command finishes', async () => {
    const before = jest.getTimerCount();

    const result = await execInContainerWithExit('scout', ['echo', 'hi'], 300_000);

    // The command really did complete — otherwise this asserts nothing.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done');

    // A 5-minute timer still armed here is the leak, and it is invisible by every
    // other means: it fires harmlessly, so only its existence distinguishes them.
    expect(jest.getTimerCount()).toBe(before);
  });

  it('execWithStdin leaves no timer armed after the command finishes', async () => {
    const before = jest.getTimerCount();

    const result = await execWithStdin('scout', ['tee', '/tmp/x'], Buffer.from('payload'), 300_000);

    expect(result.exitCode).toBe(0);
    expect(jest.getTimerCount()).toBe(before);
  });

  // Guard rails: the cancellation must not have removed the timeout itself.
  it('still times out a command that never finishes', async () => {
    const hung = new Readable({ read() { /* never ends */ } }) as Readable & { write?: unknown; end?: unknown };
    hung.write = jest.fn();
    hung.end = jest.fn();
    mockExecStart.mockImplementation(async () => hung);

    const pending = execInContainerWithExit('scout', ['sleep', 'forever'], 30_000);
    const assertion = expect(pending).rejects.toThrow(/timed out after 30s/);

    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;

    // And the timeout path must not leave its own timer behind either — which is
    // why the clear is in a `finally` rather than after the race.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('arms no timer at all when no timeout is requested', async () => {
    const before = jest.getTimerCount();
    await execInContainerWithExit('scout', ['echo', 'hi']);
    expect(jest.getTimerCount()).toBe(before);
  });
});
