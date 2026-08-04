/**
 * Model-router token refresh handler.
 *
 * Called by agentbox containers to renew their model-router JWT before
 * the 1h expiry. Mirrors the AKM refresh pattern:
 * - Agent sends current (possibly expired) JWT + refresh secret
 * - API validates refresh secret hash against DB
 * - Issues new JWT + new refresh secret atomically
 * - Old secret is invalidated (hash replaced in DB)
 */

import * as crypto from 'crypto';
import { Request, Response } from 'express';
import { getPool } from '../db/pool';
import { generateAgentModelRouterToken, isModelRouterConfigured } from './model-router-token';

/**
 * POST /internal/model-router/refresh-token
 *
 * Body: { refresh_secret: string }
 * Auth: Bearer <current-model-router-JWT> (may be expired)
 *
 * Returns: { token, refresh_secret, expires_at }
 */
export async function modelRouterRefreshHandler(req: Request, res: Response): Promise<void> {
  if (!isModelRouterConfigured()) {
    res.status(503).json({ error: 'model-router not configured' });
    return;
  }

  const { refresh_secret } = req.body;
  if (!refresh_secret || typeof refresh_secret !== 'string') {
    res.status(400).json({ error: 'refresh_secret is required' });
    return;
  }

  // Extract agent identity from the Bearer token (may be expired — that's OK)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }

  const token = authHeader.slice(7);
  let sub: string;
  try {
    // Decode JWT payload without verification (token may be expired)
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed JWT: expected three segments');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    sub = payload.sub;
    if (!sub) throw new Error('no sub claim in the token payload');
  } catch (err) {
    // A REFUSAL SAYS WHY. This was `catch { … 'invalid token' }` with no binding and
    // no log, so three distinguishable faults — not a JWT, an unparseable payload, a
    // payload with no subject — produced one opaque 401 and no record of which.
    // That is the defect middleware/auth.ts fixed on 2026-08-03 (#114), surviving
    // here because the fix went to one file. The token is never logged; the message
    // carries the cause and no credential material.
    const detail = err instanceof Error ? err.message : 'unknown error';
    console.warn(`[model-router-refresh] token rejected — ${detail}`);
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  // Validate refresh secret against stored hash
  const secretHash = crypto.createHash('sha256').update(refresh_secret).digest('hex');
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT id, agent_id, model_router_jti, model_router_exp, created_by
     FROM agents
     WHERE (agent_id = $1 OR id::text = $1)
       AND model_router_refresh_hash = $2
       AND status = 'running'`,
    [sub, secretHash]
  );

  if (rows.length === 0) {
    // Name the agent and what did NOT happen to it. A failed refresh used to
    // leave nothing on this side at all — no row, no counter, no line — so a
    // failure was distinguishable from a success only by the absence of a log
    // entry that is never written (#255). The success case has logged since it
    // was written, below.
    //
    // The consequence is the part worth reading, not the status code: this
    // agent's model-router token was not renewed, it will expire on its own
    // schedule, and its model calls fail closed after that.
    //
    // `sub` comes from an unverified token BY DESIGN — the bearer may be
    // expired, which is what refresh is for — so this is the identity the
    // caller claimed, and it says so rather than presenting it as established.
    console.warn(
      `[model-router-refresh] Token NOT renewed for agent "${sub}": no running agent matches that ` +
      'identity and refresh secret. Its current token will expire and its model calls will then ' +
      'fail. (Identity claimed by the caller, not verified.)'
    );
    res.status(401).json({ error: 'invalid refresh secret' });
    return;
  }

  const agent = rows[0];

  // Generate new token
  const newToken = await generateAgentModelRouterToken({
    agentSlug: agent.agent_id,
    agentUuid: agent.id,
    owner: agent.created_by,
  });

  // Store new JTI + refresh hash atomically (invalidates old secret)
  const newHash = crypto.createHash('sha256').update(newToken.refreshSecret).digest('hex');
  await pool.query(
    `UPDATE agents SET
       model_router_jti = $1,
       model_router_exp = $2,
       model_router_refresh_hash = $3,
       updated_at = NOW()
     WHERE id = $4`,
    [newToken.jti, newToken.expiresAt, newHash, agent.id]
  );

  console.info(`[model-router-refresh] Refreshed token for agent ${agent.agent_id} (jti=${newToken.jti})`);

  res.json({
    token: newToken.token,
    refresh_secret: newToken.refreshSecret,
    expires_at: newToken.expiresAt,
  });
}
