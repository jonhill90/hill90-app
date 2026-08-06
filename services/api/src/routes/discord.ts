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
import { inspectContainerPresence } from '../services/docker';

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
  'The Discord bot has no container on the host — running or stopped — and ' +
  'the deploy pipeline does not build or start one. A binding aimed at it ' +
  'can never take effect.';

const BOT_STOPPED_MESSAGE =
  'The Discord bot container exists but is not currently running. This ' +
  'binding will take effect once it starts.';

/**
 * Three real states, not two, and the distinction is the fix (app#508's
 * second half). A bot that is merely STOPPED — down for maintenance, mid
 * redeploy, crashed once — is a normal, legitimate binding target; refusing
 * it would break a legitimate workflow to fix what is, for that caller, a
 * cosmetic warning. A bot with no container object anywhere — the
 * production reality verified 2026-08-06 — can never act on a binding no
 * matter how long the caller waits, and that is the one case worth refusing
 * outright rather than warning about after the fact.
 *
 * `unknown` (the check itself failed — docker proxy unreachable, unexpected
 * error) is treated as its own state, not folded into `absent`: an
 * infrastructure hiccup is not the same fact as "this was never deployed,"
 * and must not silently gate a write on unrelated flakiness. Both routes
 * below treat `unknown` the way they treat `stopped` — warn, do not refuse
 * — because refusing on a check nobody could actually complete is exactly
 * the over-strict failure mode that would cost a legitimate caller their
 * binding to fix a display problem.
 */
type BotState = 'running' | 'stopped' | 'absent' | 'unknown';

async function checkBotState(): Promise<BotState> {
  try {
    const { exists, running } = await inspectContainerPresence(DISCORD_BOT_CONTAINER_NAME);
    if (!exists) return 'absent';
    return running ? 'running' : 'stopped';
  } catch (err) {
    console.error('[discord] Could not verify bot container status:', err);
    return 'unknown';
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

    // app#508. Checked BEFORE the write, not after: a binding aimed at a
    // bot with no container object anywhere can never take effect, and
    // refusing it must leave nothing behind — no row, no upsert, nothing
    // for the caller to have to notice and clean up later. `stopped` and
    // `unknown` are NOT refused here — see checkBotState's own comment for
    // why treating either as a hard failure would break a legitimate
    // workflow (a bot that is merely down, or a check that could not
    // complete) to fix what is, for that caller, a cosmetic warning.
    const state = await checkBotState();
    if (state === 'absent') {
      res.status(409).json({ error: BOT_NOT_DEPLOYED_MESSAGE });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO discord_channel_bindings (channel_id, guild_id, agent_id, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_id) DO UPDATE SET agent_id = $3
       RETURNING *`,
      [channel_id, guild_id, agent_id, user.sub],
    );

    // The row is real and the write genuinely succeeded — 201 is still the
    // honest status for both remaining states. `stopped` and `unknown` are
    // not failures, just imperfect information the caller is owed at the
    // moment they most need it, in case the bindings-page banner (driven by
    // GET /status) was missed or never fetched at all.
    const result: Record<string, unknown> = { ...rows[0] };
    if (state === 'stopped') {
      result.warning = BOT_STOPPED_MESSAGE;
    } else if (state === 'unknown') {
      result.warning = 'Could not verify whether the Discord bot is running — check the Bot Status panel before relying on this binding.';
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
  // (verified 2026-08-06). `state` is the fact that actually determines
  // whether a binding does anything: a live container check, not a config
  // flag.
  //
  // `deployed` stays a boolean for backward compatibility with existing
  // callers of this response, but its MEANING changed with the fix: it now
  // answers "does a container object exist for this bot at all" (running OR
  // stopped), not "is it running right now" — because that is the question
  // that actually decides whether a binding can ever take effect. `status`
  // carries the finer distinction a caller needs to know whether to expect
  // action immediately or only once the bot starts.
  const state = await checkBotState();

  if (state === 'running') {
    res.json({
      configured,
      deployed: true,
      status: 'ready',
      message: 'Discord bot is running.',
    });
    return;
  }

  if (state === 'stopped') {
    res.json({
      configured,
      deployed: true,
      status: 'stopped',
      message: BOT_STOPPED_MESSAGE,
    });
    return;
  }

  if (state === 'unknown') {
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
