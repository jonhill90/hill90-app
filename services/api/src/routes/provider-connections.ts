import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { encryptProviderKey } from '../services/provider-key-crypto';
import axios from 'axios';
import { rolesFrom } from '../middleware/keycloak-config';

const router = Router();

function getEncryptionKey(): string {
  const key = process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  if (!key) throw new Error('PROVIDER_KEY_ENCRYPTION_KEY not configured');
  return key;
}

// All routes require at least 'user' role
router.use(requireRole('user'));

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  const roles: string[] = rolesFrom(user);
  return roles.includes('admin');
}

/**
 * Fetch a connection by id the way `DELETE /:id` already does — an admin
 * reaches ANY connection, including a platform one (`created_by IS NULL`);
 * everyone else only their own. `created_by = $1` alone can never match a
 * NULL owner, so without the admin branch a platform connection is a 404
 * dead end no matter who asks — the same coupling GET / had before #359,
 * on a single row instead of a list (#361).
 *
 * `DELETE /:id` is not routed through this — it already had the correct
 * branch and is left as it was, working, rather than folded into a helper
 * it doesn't need touched.
 */
async function fetchOwnedConnection(
  pool: ReturnType<typeof getPool>,
  req: Request,
  id: string,
  columns: string,
): Promise<{ rows: any[] }> {
  if (isAdmin(req)) {
    return pool.query(`SELECT ${columns} FROM provider_connections WHERE id = $1`, [id]);
  }
  const user = (req as any).user;
  return pool.query(
    `SELECT ${columns} FROM provider_connections WHERE id = $1 AND created_by = $2`,
    [id, user.sub],
  );
}

// GET /provider-connections — list own connections, plus platform-wide ones
//
// `created_by = $1` alone can never match a platform connection: SQL NULL
// compared to any bound parameter is never true, never false, always
// unknown, which a WHERE clause treats as excluded. The POST handler above
// has computed `is_platform: row.created_by === null` on create since this
// route existed, on the clear assumption a platform connection would be
// visible somewhere — but nothing ever read that assumption back. A
// platform connection could be created and never again appear in this list
// for any user, admin included, with no error anywhere to say so.
router.get('/', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const result = await pool.query(
    `SELECT id, name, provider, api_base_url, is_valid,
            last_validated_at, last_validation_error, validation_latency_ms,
            created_by, created_at, updated_at
     FROM provider_connections
     WHERE created_by = $1 OR created_by IS NULL
     ORDER BY created_at DESC`,
    [user.sub]
  );
  const rows = result.rows.map((row: any) => ({
    ...row,
    is_platform: row.created_by === null,
  }));
  res.json(rows);
});

// GET /provider-connections/health — aggregate health stats for own
// connections, plus platform-wide ones. Same reasoning as GET / above: a
// platform connection's validation state is part of "is anything broken"
// just as much as an owned one's, and excluding it from this count would
// make a genuinely untested platform connection invisible to the stats
// card that exists specifically to surface an untested connection.
router.get('/health', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;

  const overall = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE is_valid = true)::int AS valid,
       COUNT(*) FILTER (WHERE is_valid = false)::int AS invalid,
       COUNT(*) FILTER (WHERE is_valid IS NULL)::int AS untested,
       ROUND(AVG(validation_latency_ms) FILTER (WHERE validation_latency_ms IS NOT NULL))::int AS avg_latency_ms
     FROM provider_connections
     WHERE created_by = $1 OR created_by IS NULL`,
    [user.sub]
  );

  const byProvider = await pool.query(
    `SELECT
       provider,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE is_valid = true)::int AS valid,
       COUNT(*) FILTER (WHERE is_valid = false)::int AS invalid,
       COUNT(*) FILTER (WHERE is_valid IS NULL)::int AS untested,
       ROUND(AVG(validation_latency_ms) FILTER (WHERE validation_latency_ms IS NOT NULL))::int AS avg_latency_ms
     FROM provider_connections
     WHERE created_by = $1 OR created_by IS NULL
     GROUP BY provider
     ORDER BY provider`,
    [user.sub]
  );

  res.json({
    ...overall.rows[0],
    by_provider: byProvider.rows,
  });
});

// POST /provider-connections — create connection with encrypted key
router.post('/', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { name, provider, api_key, api_base_url, platform } = req.body;

  if (!name || !provider || !api_key) {
    res.status(400).json({ error: 'name, provider, and api_key are required' });
    return;
  }

  // Platform connections require admin role
  if (platform && !isAdmin(req)) {
    res.status(403).json({ error: 'Only admins can create platform connections' });
    return;
  }

  const createdBy = platform && isAdmin(req) ? null : user.sub;

  try {
    const { encrypted, nonce } = encryptProviderKey(api_key, getEncryptionKey());

    const result = await pool.query(
      `INSERT INTO provider_connections (name, provider, api_key_encrypted, api_key_nonce, api_base_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, provider, api_base_url, is_valid, created_by, created_at, updated_at`,
      [name, provider, encrypted, nonce, api_base_url || null, createdBy]
    );
    const row = result.rows[0];
    res.status(201).json({ ...row, is_platform: row.created_by === null });
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: `Connection named '${name}' already exists` });
      return;
    }
    throw err;
  }
});

// POST /provider-connections/validate-all — bulk validate all own connections
router.post('/validate-all', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const aiServiceUrl = process.env.AI_SERVICE_URL || process.env.MODEL_ROUTER_URL || 'http://ai:8000';
  const serviceToken = process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;

  if (!serviceToken) {
    res.status(503).json({ error: 'Internal service token not configured' });
    return;
  }

  const conns = await pool.query(
    `SELECT id, name, provider, api_key_encrypted, api_key_nonce, api_base_url
     FROM provider_connections
     WHERE created_by = $1
     ORDER BY created_at DESC`,
    [user.sub]
  );

  const results: any[] = [];

  for (const row of conns.rows) {
    const startTime = Date.now();
    try {
      const response = await axios.post(
        `${aiServiceUrl}/internal/validate-provider`,
        {
          provider: row.provider,
          api_key_encrypted: Buffer.from(row.api_key_encrypted).toString('hex'),
          api_key_nonce: Buffer.from(row.api_key_nonce).toString('hex'),
          api_base_url: row.api_base_url,
        },
        {
          headers: {
            Authorization: `Bearer ${serviceToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const latencyMs = Date.now() - startTime;
      const isValid = response.data?.valid === true;
      const validationError = isValid ? null : (response.data?.error || '').slice(0, 500) || null;
      await pool.query(
        `UPDATE provider_connections
         SET is_valid = $1, last_validated_at = NOW(), validation_latency_ms = $2,
             last_validation_error = $3, updated_at = NOW()
         WHERE id = $4`,
        [isValid, latencyMs, validationError, row.id]
      );
      const result: any = { id: row.id, name: row.name, is_valid: isValid, validation_latency_ms: latencyMs };
      if (validationError) result.error = validationError;
      results.push(result);
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const errorMsg = (err.response?.data?.error || err.message || '').slice(0, 500);
      await pool.query(
        `UPDATE provider_connections
         SET is_valid = false, last_validated_at = NOW(), validation_latency_ms = $1,
             last_validation_error = $2, updated_at = NOW()
         WHERE id = $3`,
        [latencyMs, errorMsg, row.id]
      );
      results.push({ id: row.id, name: row.name, is_valid: false, validation_latency_ms: latencyMs, error: errorMsg });
    }
  }

  res.json({ results });
});

// PUT /provider-connections/:id — update own connection
router.put('/:id', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const { id } = req.params;
  const { name, provider, api_key, api_base_url } = req.body;

  // Verify ownership — admin reaches a platform connection too (#361)
  const existing = await fetchOwnedConnection(pool, req, id, 'id');
  if (existing.rows.length === 0) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const setClauses: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (name !== undefined) {
    setClauses.push(`name = $${paramIdx++}`);
    params.push(name);
  }
  if (provider !== undefined) {
    setClauses.push(`provider = $${paramIdx++}`);
    params.push(provider);
  }
  if (api_key !== undefined) {
    const { encrypted, nonce } = encryptProviderKey(api_key, getEncryptionKey());
    setClauses.push(`api_key_encrypted = $${paramIdx++}`);
    params.push(encrypted);
    setClauses.push(`api_key_nonce = $${paramIdx++}`);
    params.push(nonce);
    // Reset validation status when key changes
    setClauses.push(`is_valid = NULL`);
  }
  if ('api_base_url' in req.body) {
    setClauses.push(`api_base_url = $${paramIdx++}`);
    params.push(api_base_url || null);
  }

  if (setClauses.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  setClauses.push(`updated_at = NOW()`);
  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE provider_connections SET ${setClauses.join(', ')}
       WHERE id = $${paramIdx}
       RETURNING id, name, provider, api_base_url, is_valid, created_at, updated_at`,
      params
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: `Connection named '${name}' already exists` });
      return;
    }
    throw err;
  }
});

// DELETE /provider-connections/:id — delete own connection
// Cascade: single models via FK ON DELETE CASCADE, router models via JSONB route cleanup
// Atomic: connection delete + JSONB cascade in single transaction — rolls back on any failure
router.delete('/:id', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Admin can delete platform connections (created_by IS NULL); users can only delete their own
    let deleteQuery: string;
    let deleteParams: any[];
    if (isAdmin(req)) {
      deleteQuery = 'DELETE FROM provider_connections WHERE id = $1 RETURNING id, created_by';
      deleteParams = [id];
    } else {
      deleteQuery = 'DELETE FROM provider_connections WHERE id = $1 AND created_by = $2 RETURNING id, created_by';
      deleteParams = [id, user.sub];
    }

    const result = await client.query(deleteQuery, deleteParams);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    const deletedOwner = result.rows[0].created_by;

    // JSONB-aware cascade: scrub deleted connection from router models' routing_config
    // Scope to the connection owner's router models (or all if platform)
    let cascadeQuery: string;
    let cascadeParams: any[];
    if (deletedOwner === null) {
      // Platform connection — no router models reference platform connections (platform models are single-type only)
      cascadeQuery = `SELECT id, routing_config FROM user_models WHERE false`;
      cascadeParams = [];
    } else {
      cascadeQuery = `SELECT id, routing_config FROM user_models
       WHERE model_type = 'router' AND created_by = $1
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(routing_config->'routes') AS r
           WHERE r->>'connection_id' = $2
         )`;
      cascadeParams = [deletedOwner, id];
    }

    const routerModels = await client.query(cascadeQuery, cascadeParams);

    for (const row of routerModels.rows) {
      const config = typeof row.routing_config === 'string'
        ? JSON.parse(row.routing_config)
        : row.routing_config;

      const filteredRoutes = config.routes.filter(
        (r: any) => r.connection_id !== id
      );

      if (filteredRoutes.length === 0) {
        await client.query('DELETE FROM user_models WHERE id = $1', [row.id]);
      } else {
        const defaultRouteRemoved = !filteredRoutes.some(
          (r: any) => r.key === config.default_route
        );
        const updatedConfig = {
          ...config,
          routes: filteredRoutes,
        };

        if (defaultRouteRemoved) {
          await client.query(
            `UPDATE user_models SET routing_config = $1, is_active = false, updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(updatedConfig), row.id]
          );
        } else {
          await client.query(
            `UPDATE user_models SET routing_config = $1, updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(updatedConfig), row.id]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) {
    // app#489: guarded, not rethrown. This route (unlike the
    // identical connect/BEGIN/work/COMMIT/ROLLBACK-in-catch shape in
    // chat.ts and discord-internal.ts) builds a specific response from
    // `err` right here rather than rethrowing to app.ts's generic terminal
    // handler — so if ROLLBACK itself throws (the connection already
    // dropped), that must not replace `err` before the two lines below run.
    // Postgres discards the transaction when the connection is released
    // regardless, same reasoning db/pool.ts's withTransaction relies on.
    await client.query('ROLLBACK').catch(() => { /* the connection may already be gone */ });
    console.error('[provider-connections] DELETE failed (rolled back):', err);
    res.status(500).json({ error: 'Failed to delete connection — cascade cleanup error' });
  } finally {
    client.release();
  }
});

// GET /provider-connections/:id/models — list available models from provider
router.get('/:id/models', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const { id } = req.params;

  // Fetch connection — admin reaches a platform connection too (#361)
  const conn = await fetchOwnedConnection(
    pool, req, id, 'id, provider, api_key_encrypted, api_key_nonce, api_base_url',
  );

  if (conn.rows.length === 0) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const row = conn.rows[0];
  const aiServiceUrl = process.env.AI_SERVICE_URL || process.env.MODEL_ROUTER_URL || 'http://ai:8000';
  const serviceToken = process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;

  if (!serviceToken) {
    res.status(503).json({ error: 'Internal service token not configured' });
    return;
  }

  try {
    const response = await axios.post(
      `${aiServiceUrl}/internal/list-provider-models`,
      {
        provider: row.provider,
        api_key_encrypted: Buffer.from(row.api_key_encrypted).toString('hex'),
        api_key_nonce: Buffer.from(row.api_key_nonce).toString('hex'),
        api_base_url: row.api_base_url,
      },
      {
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    // app#396: services/ai's /internal/list-provider-models returns 200 with
    // `{models: [], error: "..."}` on a decrypt failure — deliberately, so a
    // provider-listing problem doesn't read as an HTTP error to a caller that
    // only checks status. Axios does not throw on a 200, so that response
    // landed in THIS branch, and `response.data?.models || []` read the
    // models array while `response.data?.error` was never looked at — the
    // one piece of information the UI (ModelsClient.tsx) is specifically
    // built to show (`if (data.error) setProviderModelsError(data.error)`)
    // never reached it. A decrypt failure rendered as "this provider has no
    // models" instead of the real reason. Forwarded here the same way the
    // /validate route below already forwards its own 200-with-error shape.
    res.json({
      models: response.data?.models || [],
      ...(response.data?.error ? { error: response.data.error } : {}),
      provider: row.provider,
    });
  } catch (err: any) {
    // Same fallback as this file's own /validate route and bulk-validate
    // loop — a rejection with neither response.data.error nor .message
    // makes errorMsg undefined, and JSON.stringify drops an undefined
    // `error` key entirely, so a caller checking `if (data.error)` sees
    // neither a models list nor an explanation. The exact shape #396 fixed
    // one layer up in this same route's 200-with-error branch just above.
    const errorMsg = (err.response?.data?.error || err.message || '').slice(0, 500);
    res.json({
      models: [],
      error: errorMsg,
      provider: row.provider,
    });
  }
});

// POST /provider-connections/:id/validate — validate connection via AI service
router.post('/:id/validate', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const { id } = req.params;

  // Fetch encrypted key — admin reaches a platform connection too (#361)
  const conn = await fetchOwnedConnection(
    pool, req, id, 'id, provider, api_key_encrypted, api_key_nonce, api_base_url',
  );

  if (conn.rows.length === 0) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const row = conn.rows[0];
  const aiServiceUrl = process.env.AI_SERVICE_URL || process.env.MODEL_ROUTER_URL || 'http://ai:8000';
  const serviceToken = process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;

  if (!serviceToken) {
    res.status(503).json({ error: 'Internal service token not configured' });
    return;
  }

  const startTime = Date.now();
  try {
    const response = await axios.post(
      `${aiServiceUrl}/internal/validate-provider`,
      {
        provider: row.provider,
        api_key_encrypted: Buffer.from(row.api_key_encrypted).toString('hex'),
        api_key_nonce: Buffer.from(row.api_key_nonce).toString('hex'),
        api_base_url: row.api_base_url,
      },
      {
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const latencyMs = Date.now() - startTime;
    const isValid = response.data?.valid === true;
    const validationError = isValid ? null : (response.data?.error || '').slice(0, 500) || null;
    await pool.query(
      `UPDATE provider_connections
       SET is_valid = $1, last_validated_at = NOW(), validation_latency_ms = $2,
           last_validation_error = $3, updated_at = NOW()
       WHERE id = $4`,
      [isValid, latencyMs, validationError, id]
    );
    const result: any = { id, is_valid: isValid, validation_latency_ms: latencyMs };
    if (validationError) result.error = validationError;
    res.json(result);
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = (err.response?.data?.error || err.message || '').slice(0, 500);
    await pool.query(
      `UPDATE provider_connections
       SET is_valid = false, last_validated_at = NOW(), validation_latency_ms = $1,
           last_validation_error = $2, updated_at = NOW()
       WHERE id = $3`,
      [latencyMs, errorMsg, id]
    );
    res.json({ id, is_valid: false, validation_latency_ms: latencyMs, error: errorMsg });
  }
});

export default router;
