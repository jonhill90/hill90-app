/**
 * The two entrypoint rejections, INDUCED IN A REAL PROCESS (#133 sweep).
 *
 * Every other site in that sweep was classified by reading try-coverage. These two
 * are the ones being fixed, so they get the standard the rest could not meet: the
 * promise actually rejects, and the assertion is on what the process does about it.
 *
 * WHY A CHILD PROCESS. The claim under test is "this kills the API". In-process
 * assertions cannot show that — Jest installs its own `unhandledRejection` handling,
 * so the very signal being measured is intercepted before a listener of ours sees it,
 * and a test that dies proves nothing to a runner that has already died. So each case
 * runs a real `node` process to completion and asserts on its EXIT CODE and stderr.
 * An exit code of 1 with `UnhandledPromiseRejection` in stderr is the death itself,
 * not a proxy for it.
 *
 * The pre-fix shapes below are not descriptions of the old code. They are the old
 * code, run.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const API_ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(API_ROOT, 'node_modules/.bin/tsx');

type Run = { code: number; stderr: string; stdout: string };

/**
 * Run a TypeScript snippet to completion. Never throws on a non-zero exit.
 *
 * `spawnSync`, not `execFileSync`: the latter RETURNS only stdout, so a successful
 * run reported `stderr: ''` whether the child had written to stderr or not. That is
 * an empty result standing in for an unread one, and it failed the exit-0 case here
 * for a reason that had nothing to do with the code under test.
 */
function run(source: string): Run {
  const r = spawnSync(TSX, ['-e', source], {
    cwd: API_ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const IMPORT = `import { dieOnStartupFailure, shutdownSafely, installUnhandledRejectionBackstop } from './src/boot/fatal';`;

describe('startup failure takes the process down — the fix decides HOW', () => {
  it('POSITIVE CONTROL: the pre-fix shape kills the process on an unhandled rejection', () => {
    // index.ts:118 was exactly this: an async start(), called bare.
    const r = run(`
      const start = async () => { throw new Error('reconcile pass failed') };
      start();
      setTimeout(() => { console.log('STILL ALIVE') }, 300);
    `);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/reconcile pass failed/);
    // Deliberately NOT asserting Node's banner wording: it differs between the
    // Node 20 in the image and whatever runs this locally, and the exit code plus
    // the dead timer already are the death.
    // The process never reached the timer: it was already gone.
    expect(r.stdout).not.toContain('STILL ALIVE');
  });

  it('dieOnStartupFailure still stops it, with the cause named and the code chosen', () => {
    const r = run(`
      ${IMPORT}
      const start = async () => { throw new Error('reconcile pass failed') };
      dieOnStartupFailure(start());
      setTimeout(() => { console.log('STILL ALIVE') }, 300);
    `);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/\[startup\] fatal: the service could not start/);
    expect(r.stderr).toMatch(/reconcile pass failed/);
    // Deliberate, not accidental: our message, not Node's crash banner.
    expect(r.stderr).not.toMatch(/UnhandledPromiseRejection/);
    expect(r.stdout).not.toContain('STILL ALIVE');
  });
});

describe('shutdown failure must not pre-empt the shutdown', () => {
  it('POSITIVE CONTROL: the pre-fix shape dies before its own exit(0)', () => {
    // `process.on('SIGTERM', shutdown)` ignores the promise, so a closePool()
    // rejection had nowhere to go — and the exit it was about to request never ran.
    const r = run(`
      const closePool = async () => { throw new Error('pool did not close') };
      const shutdown = async () => {
        console.log('SHUTDOWN START');
        await closePool();
        console.log('EXIT REQUESTED');
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.kill(process.pid, 'SIGTERM');
      setTimeout(() => {}, 500);
    `);

    expect(r.stdout).toContain('SHUTDOWN START');
    // The tell: a requested, clean stop reported itself as a crash.
    expect(r.stdout).not.toContain('EXIT REQUESTED');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pool did not close/);
  });

  it('shutdownSafely logs the failure and completes the stop, exit 0', () => {
    const r = run(`
      ${IMPORT}
      const closePool = async () => { throw new Error('pool did not close') };
      const shutdown = async () => {
        console.log('SHUTDOWN START');
        await shutdownSafely(closePool);
      };
      process.on('SIGTERM', shutdown);
      process.kill(process.pid, 'SIGTERM');
      setTimeout(() => {}, 500);
    `);

    expect(r.stdout).toContain('SHUTDOWN START');
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/\[shutdown\] closing the pool failed; exiting anyway/);
    expect(r.stderr).toMatch(/pool did not close/);
  });
});

describe('the backstop, and what it is not', () => {
  it('turns a silent death into a logged one, and keeps the exit code', () => {
    const r = run(`
      ${IMPORT}
      installUnhandledRejectionBackstop();
      void (async () => { throw new Error('nobody is listening') })();
      setTimeout(() => { console.log('STILL ALIVE') }, 300);
    `);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/backstop, not a fix/);
    expect(r.stderr).toMatch(/nobody is listening/);
    // Registering a listener SUPPRESSES Node's own exit; the explicit exit(1) is
    // what keeps this a log rather than a behaviour change.
    expect(r.stdout).not.toContain('STILL ALIVE');
  });

  it('does NOT make the work happen — the rejected operation is still lost', () => {
    const r = run(`
      ${IMPORT}
      installUnhandledRejectionBackstop();
      const importantWork = async () => {
        throw new Error('never wrote the row');
        // unreachable on purpose
      };
      void importantWork();
      setTimeout(() => { console.log('WORK COMPLETED') }, 300);
    `);

    expect(r.stdout).not.toContain('WORK COMPLETED');
    expect(r.code).toBe(1);
    // The point of the assertion: the backstop improves the OBITUARY, not the outcome.
  });
});
