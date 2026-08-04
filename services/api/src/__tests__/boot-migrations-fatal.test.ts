/**
 * A failed migration must stop the process, not start it on an unknown schema.
 *
 * WHAT WAS THERE. `index.ts` ran migrations inside
 * `try { … } catch (err) { console.error('[startup] Migration failed, agent routes
 * may return 503:', err) }` — and then carried on. The API listened, answered its
 * health check, and served requests against whatever schema the database happened
 * to have, while the code above it assumed the schema it shipped with. The promised
 * 503 does not exist anywhere in the service: a route reading a column that was
 * never added answers 500, and only when something reaches it.
 *
 * That is this codebase's most-repeated defect family — an operation that fails and
 * reports success — sitting on the one step that decides whether every other step is
 * operating on the data it thinks it is.
 *
 * HOW IT IS PROVEN. Both shapes are run as real child processes against a REAL
 * `runMigrations` pointed at an unreachable database, which is the likeliest way
 * this fails in production. The pre-fix shape is not described here, it is executed —
 * and the assertion is that it prints LISTENING, which is the API going on to serve.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const API_ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(API_ROOT, 'node_modules/.bin/tsx');

type Run = { code: number; stdout: string; stderr: string };

function run(source: string): Run {
  const r = spawnSync(TSX, ['-e', source], { cwd: API_ROOT, encoding: 'utf8', timeout: 30000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A pool that cannot connect: port 1 refuses, fast and deterministically. */
const DEAD_POOL = `
  import { Pool } from 'pg';
  const pool = new Pool({
    connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/none',
    connectionTimeoutMillis: 1000,
  });
`;

describe('a migration failure at startup', () => {
  it('POSITIVE CONTROL: the pre-fix shape logs it and serves anyway', () => {
    const r = run(`
      ${DEAD_POOL}
      import { runMigrations } from './src/db/migrate';
      (async () => {
        // Exactly what index.ts had, comment and all.
        try {
          await runMigrations(pool);
          console.log('[startup] Database migrations complete');
        } catch (err: any) {
          console.error('[startup] Migration failed, agent routes may return 503:', err.message);
        }
        console.log('LISTENING');     // <- the API goes on to serve
        process.exit(0);
      })();
    `);

    expect(r.stderr).toMatch(/Migration failed/);
    // The whole defect, in one assertion: it failed, and it served.
    expect(r.stdout).toContain('LISTENING');
    expect(r.code).toBe(0);
  });

  it('now refuses to start, and says why on stderr before exiting', () => {
    const r = run(`
      ${DEAD_POOL}
      import { runMigrations } from './src/db/migrate';
      import { dieOnStartupFailure } from './src/boot/fatal';
      const start = async () => {
        try {
          await runMigrations(pool);
        } catch (err) {
          throw new Error('database migrations failed — refusing to serve on an unverified schema', { cause: err });
        }
        console.log('LISTENING');
      };
      dieOnStartupFailure(start());
    `);

    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('LISTENING');
    expect(r.stderr).toMatch(/\[startup\] fatal: the service could not start/);
    expect(r.stderr).toMatch(/refusing to serve on an unverified schema/);
    // The wrapper must not hide the cause — otherwise the operator learns that
    // migrations failed and never learns why.
    expect(r.stderr).toMatch(/ECONNREFUSED|connect/i);
  });

  it('the message reaches stderr — a pipe drops it if the exit does not wait', () => {
    // Not a restatement of the test above: `spawnSync` gives the child a PIPE, and
    // `console.error` then `process.exit()` loses the write on a pipe. This is the
    // assertion that would catch that regression in boot/fatal.ts, from the caller
    // that matters most.
    const r = run(`
      ${DEAD_POOL}
      import { runMigrations } from './src/db/migrate';
      import { dieOnStartupFailure } from './src/boot/fatal';
      dieOnStartupFailure((async () => { await runMigrations(pool) })());
    `);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });
});

describe('a missing migrations directory', () => {
  // The branch that used to `return` quietly. Induced by executing the SAME module
  // from a directory with no `migrations/` beside it, which is what an image built
  // without the build script's `cp -r src/db/migrations dist/db/migrations` looks
  // like from the code's point of view.
  const probeDir = path.join(API_ROOT, 'src/db/__probe_no_migrations__');

  beforeAll(() => {
    fs.mkdirSync(probeDir, { recursive: true });
    fs.copyFileSync(path.join(API_ROOT, 'src/db/migrate.ts'), path.join(probeDir, 'migrate.ts'));
  });
  afterAll(() => fs.rmSync(probeDir, { recursive: true, force: true }));

  it('is fatal, and needs no database to say so', () => {
    const r = run(`
      import { Pool } from 'pg';
      import { runMigrations } from './src/db/__probe_no_migrations__/migrate';
      // A pool that could never connect: if the directory check did not run FIRST,
      // this would fail with a connection error instead and the assertion below
      // would be measuring the wrong thing.
      const pool = new Pool({ connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/none' });
      runMigrations(pool).then(
        () => { console.log('RETURNED QUIETLY'); process.exit(0) },
        (err) => { console.error('THREW:', err.message); process.exit(3) },
      );
    `);

    // The branch that used to `return` quietly.
    expect(r.stdout).not.toContain('RETURNED QUIETLY');
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/migrations directory is missing/);
    expect(r.stderr).toMatch(/cp -r src\/db\/migrations/);
    // And it got there without a database, which is the point of reading the
    // directory before connecting.
    expect(r.stderr).not.toMatch(/ECONNREFUSED/);
  });
});
