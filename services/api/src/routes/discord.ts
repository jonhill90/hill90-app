/**
 * User-facing Discord management routes (Keycloak auth).
 *
 *   GET    /discord/bindings       — list channel-agent bindings
 *   POST   /discord/bindings       — create/update binding
 *   DELETE /discord/bindings/:id   — remove binding
 *   GET    /discord/user-links     — list user links
 *   POST   /discord/user-links     — link Discord user to Hill90 user
 *   DELETE /discord/user-links/:id — remove user link
 *   GET    /discord/status         — bot connection status
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin } from '../helpers/elevated-scope';
import { isContainerRunning } from '../services/docker';

const router = Router();

// app#508: a channel binding used to be entirely DB-backed — a real row,
// a 201, and no signal anywhere that the Discord bot has no deployed
// container to ever act on it. Matches the compose file's own
// `container_name: ${CONTAINER_PREFIX:-}app-discord-bot`: hardcoded
// rather than read from process.env.CONTAINER_PREFIX, same convention
// services/docker.ts's own CONTAINER_PREFIX already uses — that variable
// substitutes container_name: at compose time, it is not passed through
// as a runtime env var into this container. Verified against the live
// host (2026-08-06): every deployed container is named `app-<service>`
// with no prefix, matching the default this constant assumes.
const DISCORD_BOT_CONTAINER_NAME = 'app-discord-bot';

const BOT_NOT_DEPLOYED_MESSAGE =
  'The Discord bot has no running container on the host, and the deploy ' +
  'pipeline does not build or start one. Bindings created now will not ' +
  'take effect.';

/**
 * Whether the Discord bot container is actually running, distinguishing
 * "verified not running" from "could not check" — collapsing the two
 * would tell a caller confidently what nobody actually confirmed. Callers
 * decide separately what to do with `checked: false` (both routes below
 * treat "could not check" as reason enough to warn, same as "verified
 * absent" — an unverifiable bot is not one to promise works).
 */
async function checkBotDeployed(): Promise<{ deployed: boolean; checked: boolean }> {
  try {
    const deployed = await isContainerRunning(DISCORD_BOT_CONTAINER_NAME);
    return { deployed, checked: true };
  } catch (err) {
    console.error('[discord] Could not verify bot container status:', err);
    return { deployed: false, checked: false };
  }
}

// ── List bindings ────────────────────────────────────────────────────
router.get('/bindings', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT dcb.*, a.name AS agent_name, a.agent_id AS agent_slug
       FROM discord_channel_bindings dcb
       JOIN agents a ON dcb.agent_id = a.id
       ${admin ? '' : 'WHERE dcb.created_by = $1'}
       ORDER BY dcb.created_at DESC`,
      admin ? [] : [user.sub],
    );
    res.json(rows);
  } catch (err) {
    console.error('[discord] List bindings error:', err);
    res.status(500).json({ error: 'Failed to list bindings' });
  }
});

// ── Create binding ───────────────────────────────────────────────────
router.post('/bindings', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { channel_id, guild_id, agent_id } = req.body;

    if (!channel_id || !guild_id || !agent_id) {
      res.status(400).json({ error: 'channel_id, guild_id, and agent_id are required' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO discord_channel_bindings (channel_id, guild_id, agent_id, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_id) DO UPDATE SET agent_id = $3
       RETURNING *`,
      [channel_id, guild_id, agent_id, user.sub],
    );

    // app#508: the row is real and the write genuinely succeeded — 201 is
    // still the honest status. What was missing is any signal that the
    // row has nothing to consume it. The bindings-page banner (driven by
    // GET /status) says this before a binding is ever created; this
    // repeats it at the moment of creation itself, in case that banner
    // was missed or a caller never fetched /status at all.
    const result: Record<string, unknown> = { ...rows[0] };
    const { deployed, checked } = await checkBotDeployed();
    if (!deployed) {
      result.warning = checked
        ? BOT_NOT_DEPLOYED_MESSAGE
        : 'Could not verify whether the Discord bot is running — check the Bot Status panel before relying on this binding.';
    }

    res.status(201).json(result);
  } catch (err) {
    console.error('[discord] Create binding error:', err);
    res.status(500).json({ error: 'Failed to create binding' });
  }
});

// ── Delete binding ───────────────────────────────────────────────────
router.delete('/bindings/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rowCount } = await getPool().query(
      `DELETE FROM discord_channel_bindings WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub],
    );

    if (!rowCount) {
      res.status(404).json({ error: 'Binding not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[discord] Delete binding error:', err);
    res.status(500).json({ error: 'Failed to delete binding' });
  }
});

// ── List user links ──────────────────────────────────────────────────
router.get('/user-links', requireRole('admin'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM discord_user_links ORDER BY created_at DESC',
    );
    res.json(rows);
  } catch (err) {
    console.error('[discord] List user links error:', err);
    res.status(500).json({ error: 'Failed to list user links' });
  }
});

// ── Link Discord user ────────────────────────────────────────────────
router.post('/user-links', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { discord_user_id } = req.body;

    if (!discord_user_id) {
      res.status(400).json({ error: 'discord_user_id is required' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO discord_user_links (discord_user_id, hill90_user_id)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id) DO UPDATE SET hill90_user_id = $2
       RETURNING *`,
      [discord_user_id, user.sub],
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[discord] Link user error:', err);
    res.status(500).json({ error: 'Failed to link user' });
  }
});

// ── Delete user link ─────────────────────────────────────────────────
router.delete('/user-links/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rowCount } = await getPool().query(
      'DELETE FROM discord_user_links WHERE id = $1',
      [req.params.id],
    );
    if (!rowCount) {
      res.status(404).json({ error: 'User link not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[discord] Delete user link error:', err);
    res.status(500).json({ error: 'Failed to delete user link' });
  }
});

// ── Bot status ───────────────────────────────────────────────────────
router.get('/status', requireRole('user'), async (_req: Request, res: Response) => {
  const configured = !!process.env.DISCORD_BOT_SERVICE_TOKEN;

  // app#508: `configured` only ever checked whether a token exists — a
  // token can be sitting in vault with no bot container ever having
  // existed to use it, which is exactly production's actual state
  // (verified 2026-08-06). `deployed` is the fact that actually
  // determines whether a binding does anything: a live container check,
  // not a config flag.
  const { deployed, checked } = await checkBotDeployed();

  if (deployed) {
    res.json({
      configured,
      deployed: true,
      status: 'ready',
      message: 'Discord bot is running.',
    });
    return;
  }

  if (!checked) {
    res.json({
      configured,
      deployed: false,
      status: 'unknown',
      message: 'Could not verify whether the Discord bot is running.',
    });
    return;
  }

  res.json({
    configured,
    deployed: false,
    status: 'not_deployed',
    message: BOT_NOT_DEPLOYED_MESSAGE,
  });
});

export default router;
