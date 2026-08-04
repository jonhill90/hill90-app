import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { rolesFrom } from '../middleware/keycloak-config';

const router = Router();

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);
router.use(requireRole('user'));

/**
 * How much of this window is known to be MISSING (#261).
 *
 * `log_usage` failures in `services/ai` are logged and swallowed — right for the
 * request, wrong for the total, because `COUNT(*)`/`SUM(...)` over the rows that
 * landed cannot tell a request that was never recorded from one that cost
 * nothing. Nobody notices absent rows; they notice wrong totals, and an
 * understated total looks exactly like a quiet period.
 *
 * So every figure this route returns is now accompanied by what is known to be
 * absent from it. Zero is a real answer here and means "no failed writes are on
 * record for this window" — not "the total is right", because a process that
 * died holding a pending gap never got to record it.
 */
async function completenessFor(from: string, to?: string): Promise<Record<string, unknown>> {
  const upper = to ? `${to}T00:00:00+00:00` : null;
  try {
    return await queryCompleteness(from, upper);
  } catch (err) {
    // Three states, not two. A qualification that cannot be read is not the
    // same as a window with no gaps, and it must not take the totals down with
    // it: before migration 063 lands, this table does not exist, and the
    // figures are still the best available.
    console.error('[usage] Completeness query failed:', err);
    return { known_missing_rows: null, first_missing_at: null, last_missing_at: null, unavailable: true };
  }
}

async function queryCompleteness(from: string, upper: string | null): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(missed_count), 0)::int AS known_missing_rows,
            MIN(first_failed_at) AS first_missing_at,
            MAX(last_failed_at)  AS last_missing_at
     FROM usage_write_gaps
     WHERE last_failed_at >= $1::timestamptz
       AND ($2::timestamptz IS NULL OR first_failed_at < $2::timestamptz + interval '1 day')`,
    [from, upper]
  );
  const row = rows[0];
  if (!row) throw new Error('completeness query returned no row');
  return {
    known_missing_rows: row.known_missing_rows || 0,
    first_missing_at: row.first_missing_at || null,
    last_missing_at: row.last_missing_at || null,
  };
}

// Query usage with optional filtering and aggregation
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const roles: string[] = rolesFrom(user);
    const admin = roles.includes('admin');

    const { agent_id, model_name, request_type, status, delegation_id, from, to, group_by } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Non-admin users can only see their own usage (via durable owner column)
    if (!admin) {
      conditions.push(`owner = $${paramIdx++}`);
      params.push(user.sub);
    }

    if (agent_id) {
      conditions.push(`agent_id = $${paramIdx++}`);
      params.push(agent_id);
    }
    if (model_name) {
      conditions.push(`model_name = $${paramIdx++}`);
      params.push(model_name);
    }
    if (request_type) {
      conditions.push(`request_type = $${paramIdx++}`);
      params.push(request_type);
    }
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    if (delegation_id) {
      conditions.push(`delegation_id = $${paramIdx++}::uuid`);
      params.push(delegation_id);
    }

    // Date range defaults to today — explicit UTC offset so the cast is
    // unambiguous regardless of the DB session timezone setting.
    const fromDate = (from as string) || new Date().toISOString().slice(0, 10);
    conditions.push(`created_at >= $${paramIdx++}::timestamptz`);
    params.push(`${fromDate}T00:00:00+00:00`);

    if (to) {
      conditions.push(`created_at < $${paramIdx++}::timestamptz + interval '1 day'`);
      params.push(`${to as string}T00:00:00+00:00`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    if (group_by === 'agent' || group_by === 'model' || group_by === 'day' || group_by === 'request_type' || group_by === 'delegation') {
      const groupCol = group_by === 'agent' ? 'agent_id'
        : group_by === 'model' ? 'model_name'
        : group_by === 'request_type' ? 'request_type'
        : group_by === 'delegation' ? 'delegation_id'
        : "date_trunc('day', created_at)::date";
      const selectAlias = group_by === 'day' ? `${groupCol} AS day` : groupCol;

      const { rows } = await getPool().query(
        `SELECT ${selectAlias},
                COUNT(*) AS total_requests,
                COUNT(*) FILTER (WHERE status = 'success') AS successful_requests,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                COALESCE(SUM(cost_usd), 0)::numeric(10,6) AS total_cost_usd
         FROM model_usage ${whereClause}
         GROUP BY ${groupCol}
         ORDER BY ${groupCol}`,
        params
      );
      res.json({ data: rows, group_by, completeness: await completenessFor(`${fromDate}T00:00:00+00:00`, to as string | undefined) });
    } else {
      // Summary (no grouping)
      const { rows } = await getPool().query(
        `SELECT
           COUNT(*) AS total_requests,
           COUNT(*) FILTER (WHERE status = 'success') AS successful_requests,
           COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
           COALESCE(SUM(cost_usd), 0)::numeric(10,6) AS total_cost_usd
         FROM model_usage ${whereClause}`,
        params
      );
      res.json({ ...rows[0], completeness: await completenessFor(`${fromDate}T00:00:00+00:00`, to as string | undefined) });
    }
  } catch (err) {
    console.error('[usage] Query error:', err);
    res.status(500).json({ error: 'Failed to query usage' });
  }
});

export default router;
