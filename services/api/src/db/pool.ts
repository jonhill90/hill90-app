import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

/**
 * Anything that can run a query: the pool, or a client inside a transaction.
 *
 * Helpers shared between transactional and non-transactional callers take this
 * rather than reaching for `getPool()` themselves — a helper that opens its own
 * connection silently escapes the transaction its caller opened, which is the
 * quiet way a rollback stops covering what the reader assumes it covers.
 */
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

/**
 * Run `fn` inside a single transaction on one connection, committing on return
 * and rolling back on throw (#212).
 *
 * WHY THIS EXISTS. `POST /agents` ran its four statements on the pool, so each
 * committed on its own. A failure after the first answered 500 with the agent
 * row already saved: the caller was told the create failed while the agent was
 * in the list, and a retry then hit the unique constraint and answered 409, so
 * the same user was told the create had both failed and already happened.
 *
 * WHAT IT DOES NOT COVER, stated here because a transaction is exactly the kind
 * of guarantee that gets trusted further than it extends: only the statements
 * run on the client passed to `fn`. Work outside the database — containers,
 * files, tokens — is not part of it, and a caller that mixes them is atomic
 * over the database half alone. The agent CREATE path is database-only, which
 * is why it can be made genuinely atomic; the START path is not, and must not
 * be wrapped in this and called safe.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The original error is the one the caller needs; a failed rollback is a
      // second fault and must not replace it. Postgres discards the transaction
      // when the connection is released anyway.
      console.error('[db] ROLLBACK failed after an error in a transaction:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
