import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * The migration file list, read BEFORE any database connection is opened.
 *
 * Ordering is deliberate. This used to run after `pool.connect()`, which meant a
 * broken image could only be diagnosed by a service that had already reached the
 * database — and it meant the branch could not be exercised without one. A missing
 * directory is a build defect and is knowable from disk alone.
 */
function readMigrationFiles(): string[] {
  try {
    return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    // NOT survivable, and it used to be. This returned quietly, so an image built
    // without `cp -r src/db/migrations dist/db/migrations` (package.json's build
    // step) started with whatever schema the database happened to have and said
    // only "skipping" — a successful start on an unknown schema, which is the
    // failure this module exists to prevent.
    throw new Error(
      `[migrate] migrations directory is missing at ${MIGRATIONS_DIR} — the image was built without it ` +
      "(see the build script's `cp -r src/db/migrations dist/db/migrations`); refusing to start on an unverified schema",
      { cause: err },
    );
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  // Before the connection: a broken image should not need a database to say so.
  const files = readMigrationFiles();

  const client = await pool.connect();
  try {
    // Acquire advisory lock to prevent concurrent migration runs
    await client.query('SELECT pg_advisory_lock(42)');

    // Create tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    const appliedSet = new Set(applied.map((r: { filename: string }) => r.filename));

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      console.log(`[migrate] Applying ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`[migrate] Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    // THE CAUSE MUST SURVIVE. An unlock that throws in here would replace the
    // migration error that brought us to `finally` — the caller would then be told
    // the connection failed to unlock, and never told which migration broke.
    // Postgres drops a session-level advisory lock when the connection is released
    // anyway, so a failed unlock is not worth losing the real error over.
    try {
      await client.query('SELECT pg_advisory_unlock(42)');
    } catch (unlockErr) {
      console.error('[migrate] advisory unlock failed (the lock is released with the connection):', unlockErr);
    }
    client.release();
  }
}
