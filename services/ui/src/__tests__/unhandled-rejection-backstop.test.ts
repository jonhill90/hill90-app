/**
 * The gap this closes, INDUCED IN A REAL PROCESS, same standard as api's own
 * `boot-fatal.test.ts` (services/api/src/__tests__/boot-fatal.test.ts).
 *
 * WHY A CHILD PROCESS. Vitest installs its own `unhandledRejection` handling, so an
 * in-process assertion would have the signal under test intercepted before our
 * listener ever saw it, and a worker that dies proves nothing to a runner that has
 * already died. Each case runs a real `node` process (via `tsx`, since this is
 * TypeScript with no build step here) to completion and asserts on its exit code and
 * stderr — the death itself, not a proxy for it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const UI_ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(UI_ROOT, 'node_modules/.bin/tsx');

type Run = { code: number; stderr: string; stdout: string };

function run(source: string): Run {
  const r = spawnSync(TSX, ['-e', source], {
    cwd: UI_ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const IMPORT = `import { installUnhandledRejectionBackstop } from './src/instrumentation/unhandled-rejection-backstop';`;

describe('the UI had no unhandledRejection backstop at all — this is the gap, real', () => {
  it('POSITIVE CONTROL: with nothing installed, a leaked rejection kills the process unlabeled', () => {
    // The pre-fix shape: this is what services/ui does today, everywhere, for any
    // future promise leak — Node 20's own default, with no log line naming it.
    const r = run(`
      void (async () => { throw new Error('leaked from a route handler') })();
      setTimeout(() => { console.log('STILL ALIVE') }, 300);
    `);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/leaked from a route handler/);
    // No '[fatal]' prefix anywhere — this is Node's own unlabeled crash banner.
    expect(r.stderr).not.toMatch(/\[fatal\]/);
    expect(r.stdout).not.toContain('STILL ALIVE');
  });

  it('installUnhandledRejectionBackstop turns the same death into a logged, labeled one', () => {
    const r = run(`
      ${IMPORT}
      installUnhandledRejectionBackstop();
      void (async () => { throw new Error('leaked from a route handler') })();
      setTimeout(() => { console.log('STILL ALIVE') }, 300);
    `);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/\[fatal\] unhandled promise rejection — exiting \(this is a backstop, not a fix\)/);
    expect(r.stderr).toMatch(/leaked from a route handler/);
    // Registering a listener SUPPRESSES Node's own exit; the explicit exit(1) is
    // what keeps this a log rather than a behaviour change (a server left running,
    // silently, after a rejection nobody handled).
    expect(r.stdout).not.toContain('STILL ALIVE');
  });

  it('does NOT make the work happen — the rejected operation is still lost', () => {
    const r = run(`
      ${IMPORT}
      installUnhandledRejectionBackstop();
      const importantWork = async () => {
        throw new Error('never sent the response');
      };
      void importantWork();
      setTimeout(() => { console.log('WORK COMPLETED') }, 300);
    `);

    expect(r.stdout).not.toContain('WORK COMPLETED');
    expect(r.code).toBe(1);
    // The assertion that matters: the backstop improves the obituary, not the outcome.
  });
});

describe('the Next.js runtime guard in src/instrumentation.ts', () => {
  it('Edge adds zero unhandledRejection listeners', async () => {
    const r = run(`
      process.env.NEXT_RUNTIME = 'edge';
      import('./src/instrumentation').then(async (mod) => {
        // Node 20's tsx -e wraps this TypeScript module as CommonJS under
        // default; newer Node versions also expose the named export. Exercise
        // the actual register hook under either loader shape.
        const register = mod.register ?? mod.default?.register;
        if (typeof register !== 'function') throw new TypeError('instrumentation.register is not a function');
        const before = process.listeners('unhandledRejection').length;
        await register();
        const added = process.listeners('unhandledRejection').length - before;
        console.log('EDGE_UNHANDLED_REJECTION_LISTENERS_ADDED=' + added);
      });
    `);
    expect(r.stdout).toContain('EDGE_UNHANDLED_REJECTION_LISTENERS_ADDED=0');
    expect(r.code).toBe(0);
  });

  it('Node adds the intended listener and retains fatal behavior', () => {
    const r = run(`
      process.env.NEXT_RUNTIME = 'nodejs';
      import('./src/instrumentation').then(async (mod) => {
        const register = mod.register ?? mod.default?.register;
        if (typeof register !== 'function') throw new TypeError('instrumentation.register is not a function');
        const before = process.listeners('unhandledRejection').length;
        await register();
        const added = process.listeners('unhandledRejection').length - before;
        console.error('NODE_UNHANDLED_REJECTION_LISTENERS_ADDED=' + added);
        void (async () => { throw new Error('leaked under nodejs runtime') })();
      });
    `);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('NODE_UNHANDLED_REJECTION_LISTENERS_ADDED=1');
    expect(r.stderr).toMatch(/\[fatal\] unhandled promise rejection/);
    expect(r.stderr).toMatch(/leaked under nodejs runtime/);
  });
});
