/**
 * `withTransaction` must commit on return and roll back on throw (#212).
 *
 * WHY THIS FILE IS SEPARATE FROM THE ROUTE TEST. Two claims, two tests.
 * `agent-create-atomicity.test.ts` proves the ROUTE property — nothing survives
 * a reported failure — given a helper that behaves like a transaction, and it
 * has to mirror the helper in its mock because the real one resolves `getPool()`
 * through its own module scope. So the helper's actual behaviour is unproven
 * there, and is proven here instead, against a stubbed `pg`.
 *
 * That split is not tidiness. The first version of the route test omitted
 * `withTransaction` from its mock entirely and every control passed — the route
 * threw before the INSERT, so nothing was committed for a reason unrelated to
 * the fix. A helper assumed rather than asserted is exactly how that happens.
 */
const client = {
  query: jest.fn(async (_text: string, _params?: unknown[]) => ({ rows: [] as any[] })),
  release: jest.fn(),
};
const connect = jest.fn(async () => client);

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ connect, query: jest.fn(), end: jest.fn() })),
}));

import { withTransaction } from '../db/pool';

const sql = () => client.query.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  client.query.mockClear();
  client.query.mockImplementation(async (_text: string) => ({ rows: [] as any[] }));
  client.release.mockClear();
  connect.mockClear();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

describe('withTransaction', () => {
  it('POSITIVE CONTROL: a callback that throws is rolled back, not committed', async () => {
    await expect(
      withTransaction(async (tx) => {
        await tx.query('INSERT INTO agents (x) VALUES (1)');
        throw new Error('mid-sequence failure');
      }),
    ).rejects.toThrow('mid-sequence failure');

    expect(sql()).toEqual(['BEGIN', 'INSERT INTO agents (x) VALUES (1)', 'ROLLBACK']);
    expect(sql()).not.toContain('COMMIT');
  });

  it('TWIN: a callback that returns is committed', async () => {
    const out = await withTransaction(async (tx) => {
      await tx.query('INSERT INTO agents (x) VALUES (1)');
      return 'done';
    });

    expect(out).toBe('done');
    expect(sql()).toEqual(['BEGIN', 'INSERT INTO agents (x) VALUES (1)', 'COMMIT']);
  });

  it('BEGIN comes before the callback runs, or the first statement escapes it', async () => {
    let sqlAtCallbackTime: string[] = [];
    await withTransaction(async () => {
      sqlAtCallbackTime = sql();
    });

    expect(sqlAtCallbackTime).toEqual(['BEGIN']);
  });

  it('the connection is released on success AND on failure', async () => {
    await withTransaction(async () => undefined);
    expect(client.release).toHaveBeenCalledTimes(1);

    await expect(withTransaction(async () => { throw new Error('x') })).rejects.toThrow('x');
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it('a failing ROLLBACK does not replace the error the caller needs', async () => {
    // Two faults, and the second must not hide the first. Postgres discards the
    // transaction when the connection is released anyway, so the rollback
    // failure is the less useful of the two.
    client.query.mockImplementation(async (text: string) => {
      if (String(text) === 'ROLLBACK') throw new Error('connection already gone');
      return { rows: [] as any[] };
    });

    await expect(
      withTransaction(async () => { throw new Error('the real cause') }),
    ).rejects.toThrow('the real cause');

    expect(client.release).toHaveBeenCalled();
  });
});
