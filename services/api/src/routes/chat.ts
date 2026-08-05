/**
 * Chat Lane Phase 1B — Group threads + multi-agent dispatch.
 *
 * Endpoints:
 *   GET    /chat/threads                  — list threads (participant-scoped)
 *   POST   /chat/threads                  — create thread + send first message
 *   GET    /chat/threads/:id              — thread detail with messages
 *   PUT    /chat/threads/:id              — update title
 *   DELETE /chat/threads/:id              — delete thread (owner/admin)
 *   PUT    /chat/threads/:id/participants — add/remove agent participants
 *   POST   /chat/threads/:id/messages     — send message (multi-agent dispatch)
 *   POST   /chat/threads/:id/cancel       — cancel all pending messages
 *   GET    /chat/threads/:id/stream       — SSE stream with cursor
 *   GET    /chat/threads/:id/events       — thread-scoped agent event stream (SSE)
 *
 * Internal:
 *   POST   /internal/chat/callback        — agentbox delivers response
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../db/pool';
import { armCredentialDeadline, endStreamForExpiredCredential } from '../helpers/stream-deadline';
import {
  createBoundedSseWriter,
  SSE_DEFAULTS,
  createPollFailureSignal,
  failureThresholdFor,
  sseErrorFrame,
} from '../services/sse-writer';
import { stillAuthorised, endStreamForRevokedAccess } from '../helpers/participation-watch';
import { collectBounded, ReadTooLargeError, MAX_READ_BYTES } from '../helpers/bounded-read';
import { MAX_EVENT_TAIL } from '../helpers/event-log-limits';
import { requireRole } from '../middleware/role';
import { parsePageParams, DEFAULT_PAGE } from '../helpers/page-params';
import {
  SSE_BACKFILL_LIMIT, BACKFILL_TAIL_SQL, POLL_SQL, THREAD_MESSAGE_COUNT_SQL,
  backfillNotice, backfillFrame,
} from '../helpers/chat-backfill';
import { isAdmin, getAgentElevatedScope } from '../helpers/elevated-scope';
import { auditLog } from '../helpers/audit';
import { dispatchChatWork } from '../services/chat-dispatch';
import { execInContainer } from '../services/docker';
import { appendJournal } from '../services/akm-proxy';
import { recordJournalFailure, recordJournalSuccess } from '../services/journal-gaps';
import { reportedStatus, isStatusVerified } from '../services/agent-status-verification';

const router = Router();

// ───────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────

const MESSAGE_HISTORY_LIMIT = 50;
const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
// A claim about what was OBSERVED (no callback arrived in the window), not a
// claim about WHY. agentbox's _deliver_callback is fire-and-forget with no
// retry — the agent may have produced a real answer and lost it in delivery
// just as easily as it may genuinely still be working. "Response timed out"
// asserted the former cause specifically, which the code that writes this
// message has no way to know is what actually happened.
const NO_RESPONSE_MESSAGE = 'No response received within 2 minutes';
const MAX_AGENTS_PER_GROUP = 8;
const MAX_CHAIN_HOPS = parseInt(process.env.MAX_CHAIN_HOPS || '5', 10);
const MAX_CHAIN_DURATION_MS = parseInt(process.env.MAX_CHAIN_DURATION_MS || '60000', 10);
const DEFAULT_CHAT_MODEL = process.env.DEFAULT_CHAT_MODEL || 'claude-sonnet-4-20250514';

// Cadence of the incremental correlation-set refresh on /threads/:id/events
// (#216). Read per call, same pattern as inferencePollMs() in routes/agents.ts —
// tests set it small; production leaves it unset and gets 5000.
function chatEventsRefreshMs(): number {
  const raw = parseInt(process.env.CHAT_EVENTS_REFRESH_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

/**
 * What this route is entitled to say about a participant agent's status.
 *
 * #250 added the third state — a `running` row reconciliation could not check
 * against a real container reports `unknown` rather than the last value the
 * database happens to hold — but applied it in `routes/agents.ts` only. Every
 * chat surface in the UI reads its agent status from *these* routes, so the
 * distinction was gathered, recorded, and then dropped on the path that four of
 * the five rendering surfaces actually use. That is #141/#153 again: the fix
 * landed on one route and not its twin.
 *
 * Serialization only, deliberately. The dispatch gates at `POST /threads`
 * (`agent.status !== 'running'`) and `POST /threads/:id/messages` read the
 * recorded row and are left exactly as they are — see #251. An agent we could
 * not verify must not be refused a message: unverifiable is not absent, and
 * turning a reporting fix into a functional restriction would be a worse defect
 * than the one being fixed. Do not tidy these into consistency.
 */
function participantAgentStatus(agentId: string | null, recordedStatus: string | null) {
  // A human participant, or an agent row the LEFT JOIN did not match.
  if (!agentId || recordedStatus == null) {
    return { status: recordedStatus, status_verified: undefined as boolean | undefined };
  }
  return {
    status: reportedStatus(agentId, recordedStatus),
    status_verified: isStatusVerified(agentId),
  };
}

/** Check if user is a participant in a thread (or admin). */
async function isParticipant(threadId: string, userId: string, admin: boolean): Promise<boolean> {
  if (admin) return true;
  const { rows } = await getPool().query(
    `SELECT 1 FROM chat_participants
     WHERE thread_id = $1 AND participant_id = $2 AND participant_type = 'human'
       AND left_at IS NULL
     LIMIT 1`,
    [threadId, userId]
  );
  return rows.length > 0;
}

/** Check if user is the thread owner (or admin). */
async function isThreadOwner(threadId: string, userId: string, admin: boolean): Promise<boolean> {
  if (admin) return true;
  const { rows } = await getPool().query(
    `SELECT 1 FROM chat_participants
     WHERE thread_id = $1 AND participant_id = $2
       AND participant_type = 'human' AND role = 'owner'
     LIMIT 1`,
    [threadId, userId]
  );
  return rows.length > 0;
}

/** Get agent info needed for dispatch. */
async function getAgentForDispatch(agentUuid: string): Promise<{
  id: string;
  agent_id: string;
  name: string;
  status: string;
  work_token: string | null;
  models: string[];
} | null> {
  const { rows } = await getPool().query(
    `SELECT a.id, a.agent_id, a.name, a.status, a.work_token,
            COALESCE(mp.allowed_models, '[]'::jsonb) AS models
     FROM agents a
     LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
     WHERE a.id = $1`,
    [agentUuid]
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Find the agent participant UUID for a direct thread. */
async function getThreadAgent(threadId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT participant_id FROM chat_participants
     WHERE thread_id = $1 AND participant_type = 'agent' AND left_at IS NULL
     LIMIT 1`,
    [threadId]
  );
  return rows.length > 0 ? rows[0].participant_id : null;
}

/** Get all active agent participant UUIDs for a thread. */
async function getThreadAgents(threadId: string): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT participant_id FROM chat_participants
     WHERE thread_id = $1 AND participant_type = 'agent' AND left_at IS NULL`,
    [threadId]
  );
  return rows.map((r: any) => r.participant_id);
}

/** Get thread type and lead_agent_id. */
async function getThreadType(threadId: string): Promise<{ type: string; lead_agent_id: string | null } | null> {
  const { rows } = await getPool().query(
    `SELECT type, lead_agent_id FROM chat_threads WHERE id = $1`,
    [threadId]
  );
  return rows.length > 0 ? { type: rows[0].type, lead_agent_id: rows[0].lead_agent_id } : null;
}

/**
 * Parse @-mentions from message content.
 * Returns { slugs: string[], cleanContent: string }.
 * Slugs are extracted from ^@slug or \s@slug patterns.
 */
function parseMentions(content: string): { slugs: string[]; cleanContent: string } {
  const mentionPattern = /(?:^|\s)@([a-z0-9][a-z0-9-]*)/g;
  const slugs: string[] = [];
  let match;
  while ((match = mentionPattern.exec(content)) !== null) {
    slugs.push(match[1]);
  }
  // Strip @-mentions from content sent to agents
  const cleanContent = content.replace(/(?:^|\s)@([a-z0-9][a-z0-9-]*)/g, '').trim();
  return { slugs: [...new Set(slugs)], cleanContent: cleanContent || content.trim() };
}

/**
 * Resolve agent slugs to participant UUIDs in a thread.
 * Returns Map<slug, uuid> or throws with unknown slug.
 */
async function resolveAgentSlugs(threadId: string, slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();

  const { rows } = await getPool().query(
    `SELECT a.agent_id AS slug, cp.participant_id
     FROM chat_participants cp
     JOIN agents a ON a.id = cp.participant_id::uuid
     WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND cp.left_at IS NULL
       AND a.agent_id = ANY($2)`,
    [threadId, slugs]
  );

  const resolved = new Map<string, string>();
  for (const row of rows) {
    resolved.set(row.slug, row.participant_id);
  }
  return resolved;
}

/**
 * Dispatch chat work to a set of agents. Shared by human-send and agent-to-agent orchestration.
 * Creates assistant placeholder messages (sequential), then fires dispatch calls (parallel).
 */
const DISPATCH_REASON_MAX_LEN = 500;

// Dispatch failure reasons come from network errors and agentbox response
// bodies — neither is expected to carry a secret, but the work token is sent
// as a Bearer header and could theoretically be echoed back by an error page
// or a Node fetch error message. Strip any literal secret and any Bearer-style
// token before a reason is persisted to a column a user can read, and bound
// its length since it's an unbounded upstream string.
function sanitizeDispatchReason(reason: string, secrets: (string | null | undefined)[]): string {
  let sanitized = reason;
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  sanitized = sanitized.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return sanitized.length > DISPATCH_REASON_MAX_LEN
    ? `${sanitized.slice(0, DISPATCH_REASON_MAX_LEN)}…`
    : sanitized;
}

async function dispatchToAgents(opts: {
  threadId: string;
  agents: NonNullable<Awaited<ReturnType<typeof getAgentForDispatch>>>[];
  replyTo: string;
  historyMessages: { role: string; content: string }[];
  chainId?: string | null;
  chainHop?: number | null;
  triggeredBy?: string | null;
  threadType?: string;
  participants?: { agent_id: string; name: string }[];
  leadAgentId?: string | null;
}): Promise<{
  dispatched: { agent_id: string; message_id: string }[];
  failed: { agent_id: string; message_id: string; reason: string }[];
}> {
  const pool = getPool();
  const callbackUrl = 'http://api:3000/internal/chat/callback';
  const dispatched: { agent_id: string; message_id: string }[] = [];
  const failed: { agent_id: string; message_id: string; reason: string }[] = [];

  // Phase 1: Create all placeholders sequentially (DB inserts are fast, seq ordering matters)
  const placeholders: { agent: typeof opts.agents[0]; placeholderId: string; model: string }[] = [];
  for (const agent of opts.agents) {
    const models: string[] = Array.isArray(agent.models) ? agent.models : [];
    const model = models[0] || DEFAULT_CHAT_MODEL;

    const chainCols = opts.chainId ? ', chain_id, chain_hop, triggered_by' : '';
    const chainPlaceholders = opts.chainId ? ', $4, $5, $6' : '';
    const chainParams = opts.chainId
      ? [opts.chainId, opts.chainHop ?? null, opts.triggeredBy ?? null]
      : [];

    const { rows: [placeholder] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, reply_to${chainCols})
       VALUES ($1, $2, 'agent', 'assistant', '', 'pending', $3${chainPlaceholders})
       RETURNING id`,
      [opts.threadId, agent.id, opts.replyTo, ...chainParams]
    );

    placeholders.push({ agent, placeholderId: placeholder.id, model });
  }

  // Fail fast if CHAT_CALLBACK_TOKEN is absent: agentbox's handle_chat() checks
  // the same env var and, if unset, emits a local work_failed event and returns
  // WITHOUT ever calling back — the dispatch below would hang until the stale
  // sweeper marks it "No response received" 2+ minutes later, saying only what
  // was observed rather than pointing away from the real cause. Report the
  // actual cause immediately instead.
  if (!process.env.CHAT_CALLBACK_TOKEN) {
    console.error('[chat] CHAT_CALLBACK_TOKEN not configured — refusing to dispatch');
    for (const { agent, placeholderId } of placeholders) {
      try {
        await pool.query(
          `UPDATE chat_messages SET status = 'error',
           error_message = 'Chat is not configured on this server (CHAT_CALLBACK_TOKEN missing)',
           seq = nextval('chat_messages_seq')
           WHERE id = $1 AND status = 'pending'`,
          [placeholderId]
        );
      } catch (updateErr) {
        console.error(`[chat] Failed to mark callback-not-configured error:`, updateErr);
      }
      failed.push({ agent_id: agent.id, message_id: placeholderId, reason: 'callback_not_configured' });
    }
    return { dispatched, failed };
  }

  // Phase 2: Dispatch all work items in parallel
  // In collaborative mode (leadAgentId set), the lead agent gets collaborator
  // context so it knows which agents are available for consultation.
  const collaboratorList = opts.leadAgentId
    ? opts.agents
        .filter(a => a.id !== opts.leadAgentId)
        .map(a => ({ agent_id: a.agent_id, name: a.name || a.agent_id }))
    : undefined;

  const results = await Promise.allSettled(
    placeholders.map(({ agent, placeholderId, model }) =>
      dispatchChatWork({
        agentId: agent.agent_id,
        workToken: agent.work_token!,
        threadId: opts.threadId,
        messageId: placeholderId,
        messages: opts.historyMessages,
        model,
        callbackUrl,
        threadType: opts.threadType,
        participants: opts.participants,
        isLead: opts.leadAgentId ? agent.id === opts.leadAgentId : undefined,
        collaborators: opts.leadAgentId && agent.id === opts.leadAgentId ? collaboratorList : undefined,
      })
    )
  );

  // Phase 3: Map settled results to dispatched/failed
  for (let i = 0; i < results.length; i++) {
    const { agent, placeholderId } = placeholders[i];
    const result = results[i];

    if (result.status === 'fulfilled' && result.value.accepted) {
      dispatched.push({ agent_id: agent.id, message_id: placeholderId });
    } else {
      const reason = result.status === 'rejected'
        ? String(result.reason)
        : (result.value.error || 'not accepted');
      // Sanitize before this reaches ANY output — console.error included.
      // Container stdout/stderr is shipped to Loki and retained there, so an
      // unredacted token logged "just for diagnostics" ends up in a queryable
      // log store, which is a worse leak surface than the DB column this was
      // written to protect in the first place.
      const safeReason = sanitizeDispatchReason(reason, [agent.work_token]);
      console.error(`[chat] Dispatch failed for agent=${agent.agent_id}: ${safeReason}`);
      try {
        await pool.query(
          `UPDATE chat_messages SET status = 'error', error_message = $2,
           seq = nextval('chat_messages_seq')
           WHERE id = $1 AND status = 'pending'`,
          [placeholderId, `Dispatch failed: ${safeReason}`]
        );
      } catch (updateErr) {
        console.error(`[chat] Failed to mark dispatch error:`, updateErr);
      }
      failed.push({ agent_id: agent.id, message_id: placeholderId, reason: 'dispatch_failed' });
    }
  }

  return { dispatched, failed };
}

// ───────────────────────────────────────────────────────────────────
// GET /chat/stats — figures that CANNOT be derived from a page
// ───────────────────────────────────────────────────────────────────

/**
 * Today's message count, for the dashboard (issue #197).
 *
 * WHY THIS IS A NEW ENDPOINT RATHER THAN TWO MORE COLUMNS ON /threads.
 * The dashboard wanted `message_count` and `last_message_at` per thread so it
 * could sum them. Adding those columns would have worked and would have been the
 * smaller diff — and it would have made the figure a total assembled from a PAGE,
 * which is precisely the defect #180, #184 and #188 were each about. `/threads`
 * is bounded at DEFAULT_PAGE (500), so the sum would silently stop counting at
 * the page edge. A count that is wrong only for the busiest accounts is worse
 * than one that is wrong always, because nothing looks unusual.
 *
 * So the count is done here, once, with its own COUNT(*) over the whole scope.
 *
 * "TODAY" IS UTC, deliberately and explicitly. The client used to compute a UTC
 * midnight boundary itself; keeping that meaning avoids a figure whose value
 * depends on the reader's timezone. `created_at` is TIMESTAMPTZ, so the boundary
 * is converted back to an instant rather than compared against a bare timestamp.
 *
 * The boundary is NOT accepted from the caller. A client-supplied range on a
 * count is a client that can ask "how many messages have there ever been" and be
 * answered.
 */
router.get('/stats', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    // Same scoping as GET /threads: an admin counts everything, a user counts
    // only threads they are still a participant in. A count over a wider scope
    // would report other people's activity as the caller's own.
    const TODAY_UTC = `date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

    const sql = admin
      ? `SELECT COUNT(*) AS messages_today
         FROM chat_messages m
         WHERE m.created_at >= ${TODAY_UTC}`
      : `SELECT COUNT(*) AS messages_today
         FROM chat_messages m
         JOIN chat_participants cp ON cp.thread_id = m.thread_id
         WHERE cp.participant_id = $1
           AND cp.participant_type = 'human'
           AND cp.left_at IS NULL
           AND m.created_at >= ${TODAY_UTC}`;

    const { rows } = await getPool().query(sql, admin ? [] : [user.sub]);
    res.json({ messages_today: Number(rows[0].messages_today) });
  } catch (err) {
    console.error('[chat] Failed to compute stats:', err);
    res.status(500).json({ error: 'Failed to compute chat stats' });
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads — list threads for current user
// ───────────────────────────────────────────────────────────────────

router.get('/threads', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    let query: string;
    let params: any[];

    const page = parsePageParams(req);
    if ('error' in page) {
      res.status(400).json({ error: page.error });
      return;
    }
    const limit = page.limit ?? DEFAULT_PAGE;
    const offset = page.offset ?? 0;

    // The SELECT list is identical in both branches; only the scope differs.
    // Kept as one string so the two cannot drift into returning different
    // columns to an admin than to a user.
    const COLS = `t.id, t.type, t.title, t.created_by, t.lead_agent_id, t.created_at, t.updated_at,
                      (SELECT content FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_message,
                      (SELECT author_type FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_author_type`;

    // ORDER BY carries an id tiebreak: updated_at is not unique, and paging
    // over a non-unique sort key hands one thread to two pages and no page to
    // another — the same silent wrong answer as truncation, arriving through
    // pagination instead.
    let countQuery: string;
    let countParams: any[];

    if (admin) {
      // No WHERE, deliberately: an admin sees every thread. That matches
      // scopeToOwner (admin -> no filter) and isParticipant (admin bypass), so
      // this is a VOLUME bound, not an authorization change. Nothing that was
      // visible before is hidden now; it simply arrives one page at a time.
      query = `SELECT ${COLS}
               FROM chat_threads t
               ORDER BY t.updated_at DESC, t.id DESC
               LIMIT $1 OFFSET $2`;
      params = [limit, offset];
      countQuery = `SELECT COUNT(*) AS total FROM chat_threads t`;
      countParams = [];
    } else {
      query = `SELECT ${COLS}
               FROM chat_threads t
               JOIN chat_participants cp ON cp.thread_id = t.id
               WHERE cp.participant_id = $1 AND cp.participant_type = 'human' AND cp.left_at IS NULL
               ORDER BY t.updated_at DESC, t.id DESC
               LIMIT $2 OFFSET $3`;
      params = [user.sub, limit, offset];
      // Same JOIN and same WHERE as the page. A count over a different scope
      // would report someone else's thread count to this user.
      countQuery = `SELECT COUNT(*) AS total
                    FROM chat_threads t
                    JOIN chat_participants cp ON cp.thread_id = t.id
                    WHERE cp.participant_id = $1 AND cp.participant_type = 'human' AND cp.left_at IS NULL`;
      countParams = [user.sub];
    }

    const [{ rows }, { rows: countRows }] = await Promise.all([
      getPool().query(query, params),
      getPool().query(countQuery, countParams),
    ]);

    // COUNT(*) over the same scope, never rows.length: a total derived from
    // the page agrees with itself and reports truncation as completeness.
    res.setHeader('X-Total-Count', String(Number(countRows[0].total)));

    // Enrich with participant info
    const threadIds = rows.map((r: any) => r.id);
    let participantMap = new Map<string, any[]>();
    if (threadIds.length > 0) {
      const { rows: participants } = await getPool().query(
        `SELECT cp.thread_id, cp.participant_id, cp.participant_type, cp.role, cp.left_at,
                a.agent_id, a.name AS agent_name, a.status AS agent_status
         FROM chat_participants cp
         LEFT JOIN agents a ON cp.participant_type = 'agent' AND a.id = cp.participant_id::uuid
         WHERE cp.thread_id = ANY($1) AND cp.participant_type = 'agent' AND cp.left_at IS NULL`,
        [threadIds]
      );
      for (const p of participants) {
        const list = participantMap.get(p.thread_id) || [];
        list.push(p);
        participantMap.set(p.thread_id, list);
      }
    }

    const threads = rows.map((r: any) => {
      const agents = participantMap.get(r.id) || [];
      return {
        ...r,
        last_message: r.last_message
          ? r.last_message.length > 100 ? r.last_message.slice(0, 100) + '...' : r.last_message
          : null,
        agent_count: agents.length,
        agents: agents.map((a: any) => ({
          id: a.participant_id,
          agent_id: a.agent_id,
          name: a.agent_name,
          ...participantAgentStatus(a.agent_id, a.agent_status),
        })),
        // Backward compat: single agent field for direct threads
        agent: agents.length === 1 ? {
          id: agents[0].participant_id,
          agent_id: agents[0].agent_id,
          name: agents[0].agent_name,
          ...participantAgentStatus(agents[0].agent_id, agents[0].agent_status),
        } : undefined,
      };
    });

    res.json(threads);
  } catch (err) {
    console.error('[chat] List threads error:', err);
    res.status(500).json({ error: 'Failed to list threads' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads — create thread + first message + dispatch
// Supports both direct (single agent_id) and group (agent_ids[]) creation
// ───────────────────────────────────────────────────────────────────

router.post('/threads', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { agent_id, agent_ids, message, title, idempotency_key, lead_agent_id } = req.body;

    // Resolve agent UUIDs: support both single agent_id and array agent_ids
    let agentUuids: string[];
    if (agent_ids && Array.isArray(agent_ids) && agent_ids.length > 0) {
      agentUuids = agent_ids;
    } else if (agent_id) {
      agentUuids = [agent_id];
    } else {
      res.status(400).json({ error: 'agent_id or agent_ids is required' });
      return;
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }

    // Determine thread type
    const threadType = agentUuids.length === 1 ? 'direct' : 'group';

    // Validate agent count for groups
    if (threadType === 'group' && agentUuids.length > MAX_AGENTS_PER_GROUP) {
      res.status(400).json({ error: `Maximum ${MAX_AGENTS_PER_GROUP} agents per group thread` });
      return;
    }

    // Validate lead_agent_id for collaborative mode
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (lead_agent_id) {
      if (typeof lead_agent_id !== 'string' || !UUID_RE.test(lead_agent_id)) {
        res.status(400).json({ error: 'lead_agent_id must be a valid UUID' });
        return;
      }
      if (threadType !== 'group') {
        res.status(400).json({ error: 'lead_agent_id is only valid for group threads (requires agent_ids with 2+ agents)' });
        return;
      }
      if (!agentUuids.includes(lead_agent_id)) {
        res.status(400).json({ error: 'lead_agent_id must be one of the agent_ids' });
        return;
      }
    }

    // Look up all agents
    const agents: Awaited<ReturnType<typeof getAgentForDispatch>>[] = [];
    for (const uuid of agentUuids) {
      const agent = await getAgentForDispatch(uuid);
      if (!agent) {
        res.status(404).json({ error: `Agent not found: ${uuid}` });
        return;
      }
      agents.push(agent);
    }

    // Pre-flight: elevated scope strict deny (D1a)
    for (const agent of agents) {
      const elevatedScope = await getAgentElevatedScope(agent!.id);
      if (elevatedScope && !admin) {
        auditLog('chat_elevated_denied', agent!.agent_id, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'POST /chat/threads' });
        res.status(403).json({
          error: `Elevated agent ${agent!.name || agent!.agent_id} (${elevatedScope}) requires admin privileges`,
        });
        return;
      }
    }

    // Classify agents for dispatch (before DB writes to avoid orphans)
    const dispatchableAgents: NonNullable<Awaited<ReturnType<typeof getAgentForDispatch>>>[] = [];
    const skipped: { agent_id: string; reason: string }[] = [];

    for (const agent of agents) {
      if (agent!.status !== 'running' || !agent!.work_token) {
        skipped.push({ agent_id: agent!.id, reason: 'not_running' });
      } else {
        dispatchableAgents.push(agent!);
      }
    }

    // Pre-flight: at least one agent must be running
    if (dispatchableAgents.length === 0) {
      res.status(400).json({ error: 'No available agents — all selected agents are not running' });
      return;
    }

    // In collaborative mode, only dispatch to the lead agent (others are collaborators)
    const agentsToDispatch = lead_agent_id
      ? dispatchableAgents.filter(a => a.id === lead_agent_id)
      : dispatchableAgents;

    if (lead_agent_id && agentsToDispatch.length === 0) {
      // Lead agent isn't running — reject before creating thread
      res.status(409).json({ error: 'Lead agent is not running' });
      return;
    }

    /*
     * THE THREE INSERTS BELOW ARE ONE WRITE, so they run in one transaction.
     *
     * They were three independent statements. If the participants insert or the
     * message insert threw, the outer catch answered 500 while the THREAD row
     * survived — a thread with no participants, which `isParticipant` then hides
     * from every non-admin including the person who created it, while the admin
     * thread count still counts it.
     *
     * That is the middle rung of the ranking set out in workflows.ts: DETECTABLE
     * but not self-identifying. Zero human participants cannot occur legitimately,
     * so a query could find these — but nobody was ever going to write it. A
     * transaction removes the need for the detector, which beats adding one.
     *
     * The shape is provider-connections.ts:296 verbatim — connect, BEGIN, work,
     * COMMIT, ROLLBACK in the catch, release in a finally. An in-repo precedent
     * beats a new abstraction even where a helper would read more prettily. This
     * is the second user of the shape; a helper can be extracted at the third.
     *
     * The DISPATCH stays OUTSIDE the transaction on purpose: it calls other
     * services, so holding a pooled connection across it would tie that
     * connection to a network round-trip — and its failures are already reported
     * honestly in the `failed` array rather than being errors at all.
     */
    const pool = getPool();
    const client = await pool.connect();
    let thread: any;
    let userMsg: any;
    try {
      await client.query('BEGIN');

      // Create thread
      ({ rows: [thread] } = await client.query(
        `INSERT INTO chat_threads (type, title, created_by, lead_agent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, type, title, created_by, lead_agent_id, created_at, updated_at`,
        [threadType, title || null, user.sub, lead_agent_id || null]
      ));

      // Add participants: human owner + all agents
      const participantValues: string[] = [];
      const participantParams: any[] = [thread.id, user.sub];
      participantValues.push(`($1, $2, 'human', 'owner')`);
      let paramIdx = 3;
      for (const agent of agents) {
        participantValues.push(`($1, $${paramIdx}, 'agent', 'member')`);
        participantParams.push(agent!.id);
        paramIdx++;
      }
      await client.query(
        `INSERT INTO chat_participants (thread_id, participant_id, participant_type, role)
         VALUES ${participantValues.join(', ')}`,
        participantParams
      );

      // Create user message
      ({ rows: [userMsg] } = await client.query(
        `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, idempotency_key)
         VALUES ($1, $2, 'human', 'user', $3, 'complete', $4)
         RETURNING id, seq`,
        [thread.id, user.sub, message.trim(), idempotency_key || null]
      ));

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => { /* the connection may already be gone */ });
      throw txErr;
    } finally {
      client.release();
    }

    // Build participant list for group context (all agents, not just dispatch targets)
    const participantList = threadType === 'group'
      ? agents.map(a => ({ agent_id: a!.agent_id, name: a!.name || a!.agent_id }))
      : undefined;

    // Dispatch via shared helper (parallel dispatch, §7a placeholder-then-dispatch pattern)
    const historyMessages = [{ role: 'user', content: message.trim() }];
    const { dispatched, failed } = await dispatchToAgents({
      threadId: thread.id,
      agents: agentsToDispatch,
      replyTo: userMsg.id,
      historyMessages,
      threadType: threadType || undefined,
      participants: participantList,
      leadAgentId: lead_agent_id || null,
    });

    // Direct thread backward compat response
    if (threadType === 'direct') {
      res.status(201).json({
        thread: {
          ...thread,
          agent: { id: agents[0]!.id, agent_id: agents[0]!.agent_id },
        },
        message_id: dispatched[0]?.message_id || failed[0]?.message_id || null,
      });
      return;
    }

    // Group thread response with three-array contract
    res.status(201).json({
      thread,
      user_message: { id: userMsg.id, seq: userMsg.seq },
      dispatched,
      skipped,
      failed,
    });
  } catch (err: any) {
    if (err.code === '23505' && err.constraint === 'idx_chat_messages_idempotency') {
      res.status(409).json({ error: 'Duplicate message (idempotency key already used)' });
      return;
    }
    console.error('[chat] Create thread error:', err);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id — thread detail with messages
// ───────────────────────────────────────────────────────────────────

router.get('/threads/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    if (!(await isParticipant(req.params.id, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const page = parsePageParams(req);
    if ('error' in page) {
      res.status(400).json({ error: page.error });
      return;
    }
    const limit = page.limit ?? DEFAULT_PAGE;

    // Cursor for older messages. Rejected rather than ignored: a caller that
    // sends before_seq=abc and silently receives the newest page has been
    // handed an answer to a different question.
    let beforeSeq: number | undefined;
    if (req.query.before_seq !== undefined) {
      const n = Number(req.query.before_seq);
      if (!Number.isInteger(n) || n < 0) {
        res.status(400).json({ error: 'before_seq must be an integer >= 0' });
        return;
      }
      beforeSeq = n;
    }

    const pool = getPool();

    // Get thread
    const { rows: threadRows } = await pool.query(
      `SELECT id, type, title, created_by, lead_agent_id, created_at, updated_at
       FROM chat_threads WHERE id = $1`,
      [req.params.id]
    );
    if (threadRows.length === 0) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // Get participants with agent info
    const { rows: participants } = await pool.query(
      `SELECT cp.participant_id, cp.participant_type, cp.role, cp.joined_at, cp.left_at,
              a.agent_id, a.name AS agent_name, a.status AS agent_status
       FROM chat_participants cp
       LEFT JOIN agents a ON cp.participant_type = 'agent' AND a.id = cp.participant_id::uuid
       WHERE cp.thread_id = $1`,
      [req.params.id]
    );
    for (const p of participants) {
      const { status, status_verified } = participantAgentStatus(p.agent_id, p.agent_status);
      p.agent_status = status;
      p.agent_status_verified = status_verified;
    }

    // Get messages — the NEWEST page, not the oldest (#203).
    //
    // The read used to be unbounded. A naive LIMIT on the previous
    // `ORDER BY seq ASC` would have returned the OLDEST rows, so a user
    // opening a long thread would see the start of the conversation and not
    // the message just sent. Select newest-first and reverse — the shape this
    // file already uses when building the agent context window.
    //
    // before_seq, not OFFSET: the stale reconcile below does
    // `seq = nextval(...)`, deliberately, so the head of this table reorders.
    // An offset over that hands one message to two pages and another to none.
    // Fetch one MORE than asked for. Whether older messages exist cannot be
    // derived from `messages.length < message_total` once `before_seq` is in
    // play — the total counts the whole thread, not what remains below this
    // page — and that comparison would claim "older messages exist" while
    // sitting on the very first one. The probe row answers it exactly, with no
    // second query.
    const olderClause = beforeSeq === undefined ? '' : 'AND seq < $3';
    const pageParams: any[] = [req.params.id, limit + 1];
    if (beforeSeq !== undefined) pageParams.push(beforeSeq);

    const [{ rows: pageRows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT id, seq, author_id, author_type, role, content, status,
                reply_to, target_agents,
                chain_id, chain_hop, triggered_by,
                model, input_tokens, output_tokens, duration_ms,
                error_message, created_at
         FROM chat_messages WHERE thread_id = $1 ${olderClause}
         ORDER BY seq DESC
         LIMIT $2`,
        pageParams
      ),
      // COUNT(*) over the same thread, never messages.length: a total derived
      // from the page agrees with itself and calls a truncated thread whole.
      pool.query(
        `SELECT COUNT(*) AS total FROM chat_messages WHERE thread_id = $1`,
        [req.params.id]
      ),
    ]);

    const hasOlder = pageRows.length > limit;
    // Reversed for display: the response stays oldest-first, exactly the order
    // every existing consumer already reads.
    const messages = pageRows.slice(0, limit).reverse();
    const messageTotal = Number(countRows[0].total);

    // Reconcile stale pending messages (cleanup path 3: thread load)
    const now = Date.now();
    const staleIds = messages
      .filter((m: any) => m.status === 'pending' && (now - new Date(m.created_at).getTime()) > STALE_TIMEOUT_MS)
      .map((m: any) => m.id);

    if (staleIds.length > 0) {
      await pool.query(
        `UPDATE chat_messages
         SET status = 'error', error_message = $2,
             seq = nextval('chat_messages_seq')
         WHERE id = ANY($1) AND status = 'pending'`,
        [staleIds, NO_RESPONSE_MESSAGE]
      );
      for (const msg of messages) {
        if (staleIds.includes(msg.id)) {
          msg.status = 'error';
          msg.error_message = NO_RESPONSE_MESSAGE;
        }
      }
    }

    // The total goes in the BODY here, not a header. /entries needed a header
    // because its body was a bare JSON array and an object would have broken
    // `Array.isArray` consumers (#180); this body is already an object, so a
    // new key breaks nobody. Same rule, different mechanism: add the truth
    // through a channel an un-updated consumer already tolerates.
    res.json({
      ...threadRows[0],
      participants,
      messages,
      message_total: messageTotal,
      has_older: hasOlder,
    });
  } catch (err) {
    console.error('[chat] Get thread error:', err);
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// PUT /chat/threads/:id — update title
// ───────────────────────────────────────────────────────────────────

router.put('/threads/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    if (!(await isThreadOwner(req.params.id, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { title, lead_agent_id } = req.body;
    if (title !== undefined && title !== null && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' });
      return;
    }

    // Validate lead_agent_id if provided
    if (lead_agent_id !== undefined && lead_agent_id !== null) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (typeof lead_agent_id !== 'string' || !UUID_RE.test(lead_agent_id)) {
        res.status(400).json({ error: 'lead_agent_id must be a valid UUID or null' });
        return;
      }
      // Verify it's an active agent participant in this thread
      const agentUuids = await getThreadAgents(req.params.id);
      if (!agentUuids.includes(lead_agent_id)) {
        res.status(400).json({ error: 'lead_agent_id must be an active agent participant in the thread' });
        return;
      }
    }

    // Build dynamic SET clause
    const setClauses = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;

    if (title !== undefined) {
      setClauses.push(`title = $${idx}`);
      params.push(title ?? null);
      idx++;
    }
    if (lead_agent_id !== undefined) {
      setClauses.push(`lead_agent_id = $${idx}`);
      params.push(lead_agent_id ?? null);
      idx++;
    }

    params.push(req.params.id);
    const { rows } = await getPool().query(
      `UPDATE chat_threads SET ${setClauses.join(', ')}
       WHERE id = $${idx}
       RETURNING id, type, title, created_by, lead_agent_id, created_at, updated_at`,
      params
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[chat] Update thread error:', err);
    res.status(500).json({ error: 'Failed to update thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// DELETE /chat/threads/:id — delete thread (owner/admin)
// ───────────────────────────────────────────────────────────────────

router.delete('/threads/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    if (!(await isThreadOwner(req.params.id, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { rowCount } = await getPool().query(
      `DELETE FROM chat_threads WHERE id = $1`,
      [req.params.id]
    );

    if (!rowCount) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    auditLog('chat_thread_delete', req.params.id, user.sub, 'human', {
      thread_id: req.params.id,
      admin_override: admin && !(await isThreadOwner(req.params.id, user.sub, false)),
    });

    res.json({ deleted: true });
  } catch (err) {
    console.error('[chat] Delete thread error:', err);
    res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// PUT /chat/threads/:id/participants — add/remove agent participants
// ───────────────────────────────────────────────────────────────────

router.put('/threads/:id/participants', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isThreadOwner(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { add, remove } = req.body;
    const pool = getPool();

    // Validate add list
    if (add && Array.isArray(add)) {
      // Check agent count would not exceed limit
      const currentAgents = await getThreadAgents(threadId);
      const newCount = currentAgents.length + add.filter((id: string) => !currentAgents.includes(id)).length;
      if (newCount > MAX_AGENTS_PER_GROUP) {
        res.status(400).json({ error: `Maximum ${MAX_AGENTS_PER_GROUP} agents per group thread` });
        return;
      }

      // Elevated scope check for added agents
      for (const agentUuid of add) {
        const elevatedScope = await getAgentElevatedScope(agentUuid);
        if (elevatedScope && !admin) {
          auditLog('chat_elevated_denied', agentUuid, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'PUT /chat/threads/:id/participants' });
          res.status(403).json({
            error: `Elevated agent ${agentUuid} (${elevatedScope}) requires admin privileges`,
          });
          return;
        }
      }

      for (const agentUuid of add) {
        // Upsert: if already a participant, clear left_at. Otherwise, insert.
        await pool.query(
          `INSERT INTO chat_participants (thread_id, participant_id, participant_type, role)
           VALUES ($1, $2, 'agent', 'member')
           ON CONFLICT (thread_id, participant_id, participant_type)
           DO UPDATE SET left_at = NULL`,
          [threadId, agentUuid]
        );
      }

      // Auto-promote direct → group when more than 1 agent
      const postAddAgents = await getThreadAgents(threadId);
      if (postAddAgents.length > 1) {
        await pool.query(
          `UPDATE chat_threads SET type = 'group' WHERE id = $1 AND type = 'direct'`,
          [threadId]
        );
      }
    }

    // Process removals
    if (remove && Array.isArray(remove)) {
      for (const agentUuid of remove) {
        // Mark pending messages from this agent as error
        await pool.query(
          `UPDATE chat_messages
           SET status = 'error', error_message = 'Agent removed from thread',
               seq = nextval('chat_messages_seq')
           WHERE thread_id = $1 AND author_id = $2 AND author_type = 'agent' AND status = 'pending'`,
          [threadId, agentUuid]
        );

        // Set left_at
        await pool.query(
          `UPDATE chat_participants SET left_at = NOW()
           WHERE thread_id = $1 AND participant_id = $2 AND participant_type = 'agent'`,
          [threadId, agentUuid]
        );
      }
    }

    // Return updated participant list
    const { rows: participants } = await pool.query(
      `SELECT cp.participant_id, cp.participant_type, cp.role, cp.joined_at, cp.left_at,
              a.agent_id, a.name AS agent_name, a.status AS agent_status
       FROM chat_participants cp
       LEFT JOIN agents a ON cp.participant_type = 'agent' AND a.id = cp.participant_id::uuid
       WHERE cp.thread_id = $1`,
      [threadId]
    );
    for (const p of participants) {
      const { status, status_verified } = participantAgentStatus(p.agent_id, p.agent_status);
      p.agent_status = status;
      p.agent_status_verified = status_verified;
    }

    res.json({ participants });
  } catch (err) {
    console.error('[chat] Update participants error:', err);
    res.status(500).json({ error: 'Failed to update participants' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads/:id/messages — send message (multi-agent dispatch)
// ───────────────────────────────────────────────────────────────────

router.post('/threads/:id/messages', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { message, idempotency_key } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }

    const threadInfo = await getThreadType(threadId);
    if (!threadInfo) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    const threadType = threadInfo.type;
    const leadAgentId = threadInfo.lead_agent_id;

    // Parse @-mentions
    const { slugs, cleanContent } = parseMentions(message.trim());

    // Get all active agent participants
    const allAgentUuids = await getThreadAgents(threadId);
    if (allAgentUuids.length === 0) {
      res.status(400).json({ error: 'No agent participant found in thread' });
      return;
    }

    // Resolve target agents
    let targetAgentUuids: string[];
    let targetAgentsJson: string[] | null = null;

    if (slugs.length > 0) {
      // @-mention routing
      const resolved = await resolveAgentSlugs(threadId, slugs);
      const unknown = slugs.filter(s => !resolved.has(s));
      if (unknown.length > 0) {
        res.status(400).json({ error: `Unknown agent: @${unknown[0]}` });
        return;
      }
      targetAgentUuids = [...resolved.values()];
      targetAgentsJson = targetAgentUuids;
    } else {
      // Dispatch to all active agents
      targetAgentUuids = allAgentUuids;
    }

    // Load agent info for all targets
    const targetAgents: NonNullable<Awaited<ReturnType<typeof getAgentForDispatch>>>[] = [];
    for (const uuid of targetAgentUuids) {
      const agent = await getAgentForDispatch(uuid);
      if (agent) targetAgents.push(agent);
    }

    if (targetAgents.length === 0) {
      res.status(400).json({ error: 'No available agents' });
      return;
    }

    // Pre-flight: elevated scope strict deny (D1a)
    for (const agent of targetAgents) {
      const elevatedScope = await getAgentElevatedScope(agent.id);
      if (elevatedScope && !admin) {
        auditLog('chat_elevated_denied', agent.agent_id, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'POST /chat/threads/:id/messages' });
        res.status(403).json({
          error: `Elevated agent ${agent.name || agent.agent_id} (${elevatedScope}) requires admin privileges`,
        });
        return;
      }
    }

    // Classify agents
    const pool = getPool();
    const dispatchable: typeof targetAgents = [];
    const skipped: { agent_id: string; reason: string }[] = [];

    for (const agent of targetAgents) {
      if (agent.status !== 'running' || !agent.work_token) {
        skipped.push({ agent_id: agent.id, reason: 'not_running' });
        continue;
      }

      // Per-agent concurrency guard
      const { rows: pendingRows } = await pool.query(
        `SELECT 1 FROM chat_messages
         WHERE thread_id = $1 AND author_id = $2 AND author_type = 'agent' AND status = 'pending'
         LIMIT 1`,
        [threadId, agent.id]
      );
      if (pendingRows.length > 0) {
        skipped.push({ agent_id: agent.id, reason: 'has_pending' });
        continue;
      }

      dispatchable.push(agent);
    }

    // For direct threads: all-unavailable = error
    if (threadType === 'direct' && dispatchable.length === 0) {
      const reason = skipped[0]?.reason;
      if (reason === 'has_pending') {
        res.status(409).json({ error: 'Agent is still responding to a previous message' });
      } else {
        res.status(409).json({ error: 'Agent is not running' });
      }
      return;
    }

    // For group threads: at least one agent must be dispatchable
    if (threadType === 'group' && dispatchable.length === 0) {
      res.status(409).json({ error: 'No agents available for dispatch (all pending or not running)' });
      return;
    }

    // Create user message
    const { rows: [userMsg] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, idempotency_key, target_agents)
       VALUES ($1, $2, 'human', 'user', $3, 'complete', $4, $5)
       RETURNING id, seq`,
      [threadId, user.sub, message.trim(), idempotency_key || null, targetAgentsJson ? JSON.stringify(targetAgentsJson) : null]
    );

    // Update thread timestamp
    await pool.query(
      `UPDATE chat_threads SET updated_at = NOW() WHERE id = $1`,
      [threadId]
    );

    // Load message history for dispatch
    const { rows: history } = await pool.query(
      `SELECT role, content FROM chat_messages
       WHERE thread_id = $1 AND status = 'complete'
       ORDER BY seq DESC LIMIT $2`,
      [threadId, MESSAGE_HISTORY_LIMIT]
    );
    const historyMessages = history.reverse();

    // Build participant list for group context (all thread agents, not just targets)
    let participantList: { agent_id: string; name: string }[] | undefined;
    if (threadType === 'group') {
      const allAgentInfos = await Promise.all(allAgentUuids.map(getAgentForDispatch));
      participantList = allAgentInfos
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map(a => ({ agent_id: a.agent_id, name: a.name || a.agent_id }));
    }

    // In collaborative mode, only dispatch to the lead agent
    const agentsToDispatch = leadAgentId
      ? dispatchable.filter(a => a.id === leadAgentId)
      : dispatchable;

    if (leadAgentId && agentsToDispatch.length === 0) {
      res.status(409).json({ error: 'Lead agent is not running or has a pending response' });
      return;
    }

    // Dispatch to each dispatchable agent via shared helper
    const { dispatched, failed: failedArr } = await dispatchToAgents({
      threadId,
      agents: agentsToDispatch,
      replyTo: userMsg.id,
      historyMessages,
      threadType: threadType || undefined,
      participants: participantList,
      leadAgentId,
    });

    // Direct thread backward compat response
    if (threadType === 'direct') {
      res.status(201).json({ message_id: dispatched[0]?.message_id || failedArr[0]?.message_id || null });
      return;
    }

    // Group thread three-array response
    res.status(201).json({
      user_message: { id: userMsg.id, seq: userMsg.seq },
      dispatched,
      skipped,
      failed: failedArr,
    });
  } catch (err: any) {
    if (err.code === '23505' && err.constraint === 'idx_chat_messages_idempotency') {
      res.status(409).json({ error: 'Duplicate message (idempotency key already used)' });
      return;
    }
    console.error('[chat] Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads/:id/cancel — cancel all pending messages
// ───────────────────────────────────────────────────────────────────

router.post('/threads/:id/cancel', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { rowCount } = await getPool().query(
      `UPDATE chat_messages
       SET status = 'error', error_message = 'Cancelled by user',
           seq = nextval('chat_messages_seq')
       WHERE thread_id = $1 AND status = 'pending'`,
      [threadId]
    );

    res.json({ cancelled: rowCount || 0 });
  } catch (err) {
    console.error('[chat] Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel messages' });
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id/stream — SSE with DB-backed cursor
// ───────────────────────────────────────────────────────────────────

router.get('/threads/:id/stream', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // This stream must not outlive the credential that authorised it. It is
    // authenticated once, here, and then held open indefinitely by the poll and
    // heartbeat below — so without a deadline it keeps delivering after the token
    // expires, after sign-out, and after roles are revoked. Same defect as the
    // terminal proxy (app#145), different transport.
    const clearDeadline = armCredentialDeadline(
      res as never,
      (req as any).user?.exp,
      () => endStreamForExpiredCredential(res as never, 'chat-stream'),
    );
    req.on('close', () => clearDeadline?.());
    res.flushHeaders();

    // Parse cursor from Last-Event-ID (default: 0)
    let cursor = 0;
    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
      const parsed = parseInt(lastEventId as string, 10);
      if (!isNaN(parsed)) cursor = parsed;
    }

    // The FIRST poll is a backfill of the entire thread: with no
    // Last-Event-ID the cursor is 0, so `seq > 0` matches every message ever
    // sent. Every poll after it is bounded by arrival rate. So the bound
    // belongs on the backfill specifically, not on the steady state (#203).
    let isBackfill = true;

    // Every SSE frame here went through a raw res.write(): the return value
    // discarded, no 'drain' listener, no writableLength check (#204). Node
    // buffers past a full socket without limit, so a client that stops
    // reading — a throttled tab, a slept laptop — had nothing bounding what
    // accumulated in this process for it. sse-writer.ts exists for exactly
    // this and agents.ts already adopted it; this route had not.
    //
    // The producer here is not a pausable stream, it is this poll's own
    // 1-second timer, so `source` pauses the NEXT tick rather than an
    // in-flight read. That is sufficient: a tick that finds itself paused
    // returns before querying, so no row is fetched only to be dropped.
    let pollPaused = false;
    const source = {
      pause() { pollPaused = true; },
      resume() { pollPaused = false; },
    };
    const sse = createBoundedSseWriter(res as never, {
      hardCapBytes: SSE_DEFAULTS.hardCapBytes,
      onOverflow: (queued) => {
        console.error(
          `[chat] SSE stream aborted: ${queued} bytes queued for a client that is not reading`,
        );
        cleanup();
        res.write(
          `event: error\ndata: ${JSON.stringify({
            error: 'Client not reading',
            detail: 'The event stream was stopped because its buffer limit was exceeded.',
          })}\n\n`,
        );
        res.end();
      },
    });
    sse.setSource(source);

    // app#443: a persistent DB error here used to leave the client seeing
    // only heartbeats forever, indistinguishable from a quiet thread. Signal
    // after enough consecutive failures to cover pollFailureSignalMs at this
    // poll's own 1s cadence — see failureThresholdFor's docstring for why the
    // threshold is derived rather than a shared round number.
    const CHAT_STREAM_POLL_MS = 1000;
    const pollFailureSignal = createPollFailureSignal(
      failureThresholdFor(CHAT_STREAM_POLL_MS),
      () => {
        if (res.writableEnded || res.destroyed) return;
        sse.write(sseErrorFrame(
          'Updates may be delayed',
          'This stream has been unable to reach the message store for a while. ' +
          'It is still connected and will resume automatically once the problem clears.',
        ));
      },
    );

    const poll = async () => {
      if (res.writableEnded || res.destroyed || pollPaused) return;

      try {
        // Newest-first WITH A LIMIT on the backfill, then reversed — a plain
        // `ORDER BY seq ASC LIMIT n` would replay the OLDEST n and a reader
        // reconnecting to a long thread would be shown the start of the
        // conversation instead of what just arrived.
        const { rows } = isBackfill
          ? await getPool().query(BACKFILL_TAIL_SQL, [threadId, cursor, SSE_BACKFILL_LIMIT])
          : await getPool().query(POLL_SQL, [threadId, cursor]);

        if (isBackfill) {
          isBackfill = false;

          const { rows: countRows } = await getPool().query(
            THREAD_MESSAGE_COUNT_SQL, [threadId]
          );
          const notice = backfillNotice(rows, Number(countRows[0].total));
          // Announced BEFORE the messages, so a client knows what follows is a
          // tail rather than a history.
          if (!res.writableEnded && !res.destroyed) {
            sse.write(backfillFrame(notice));
          }
        }

        for (const row of rows) {
          if (res.writableEnded || res.destroyed) return;
          sse.write(`id: ${row.seq}\nevent: message\ndata: ${JSON.stringify(row)}\n\n`);
          cursor = row.seq;
        }
        pollFailureSignal.recordSuccess();
      } catch (err) {
        console.error('[chat] SSE poll error:', err);
        pollFailureSignal.recordFailure();
      }
    };

    // Cleanup is registered BEFORE the await below, and that ordering IS the fix —
    // do not move it back down.
    //
    // It used to be registered last, after `await poll()`. A client that goes away
    // during that backfill query — an ordinary page navigation — makes Node emit
    // 'close' on the request with NO LISTENER ATTACHED. Events are not replayed, so the
    // listener registered a moment later never fired, and both intervals then ran for
    // the lifetime of the process. `req.on('close')` is the only cleanup path this
    // handler has; unlike the agent event stream there is no stream 'end' to catch it.
    //
    // Registering early is necessary but not sufficient: if 'close' arrives while the
    // intervals do not yet exist, cleanup has nothing to clear. Hence `closed`, which
    // makes the handler decline to create timers for a response nobody is reading.
    //
    // NOT a `finally` on the handler. This function returns while the stream is still
    // open, so clearing in a `finally` would kill the poll loop and the heartbeat the
    // instant setup finished — a broken feature rather than a fixed leak.
    let closed = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      closed = true;
      if (interval) { clearInterval(interval); interval = null; }
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    };
    req.on('close', cleanup);

    // Initial backfill
    await poll();

    if (closed || res.writableEnded || res.destroyed) return;

    // Poll loop
    interval = setInterval(poll, CHAT_STREAM_POLL_MS);

    // Keep-alive heartbeat (every 30s)
    // The participation re-check rides THIS tick rather than arming a second timer
    // (issue #196). Access was checked once before the stream opened, so removing a
    // participant left their events flowing until the token expired. Admins are
    // exempt exactly as they are at the initial check.
    heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      sse.write(': heartbeat\n\n');

      if (admin) return;
      void (async () => {
        const allowed = await stillAuthorised(
          () => isParticipant(threadId, user.sub, admin),
          'chat-stream',
        );
        if (allowed || res.writableEnded || res.destroyed) return;
        endStreamForRevokedAccess(res, 'chat-stream');
        cleanup();
      })();
    }, 30000);

    // A close that landed between the guard above and here still gets cleaned up.
    if (closed) cleanup();

  } catch (err) {
    console.error('[chat] SSE stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start stream' });
    }
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id/events — thread-scoped agent event stream (SSE)
// Server-side validated, correlation-filtered. No unfiltered bypass.
// ───────────────────────────────────────────────────────────────────

router.get('/threads/:id/events', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // Resolve active agents in thread
    const pool = getPool();
    const { rows: agentParticipants } = await pool.query(
      `SELECT cp.participant_id, a.agent_id, a.status
       FROM chat_participants cp
       JOIN agents a ON a.id = cp.participant_id::uuid
       WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND cp.left_at IS NULL`,
      [threadId]
    );

    const runningAgents = agentParticipants.filter((a: any) => a.status === 'running');
    if (runningAgents.length === 0) {
      res.status(409).json({ error: 'No running agents in thread' });
      return;
    }

    // Get message IDs in this thread for correlation filtering
    // The correlation filter needs every message id in the thread, and it
    // needs them EXACTLY: a missing id silently drops a real event, which is
    // the failure family this codebase has spent the day removing. So this
    // initial load stays complete, and #216 keeps the remaining memory term.
    // What changes is the refresh below, which used to redo this every five
    // seconds for the life of the connection.
    const { rows: messageRows } = await pool.query(
      `SELECT id, seq FROM chat_messages WHERE thread_id = $1`,
      [threadId]
    );
    const threadMessageIds = new Set<string>(messageRows.map((r: any) => r.id));
    // High-water mark for the incremental refresh below. seq is monotonic
    // (nextval), so "everything above this" is exactly the new work.
    let lastSeenSeq: number = messageRows.reduce(
      (max: number, r: any) => (Number(r.seq) > max ? Number(r.seq) : max), 0,
    );

    const follow = req.query.follow === 'true';
    const parsedTail = parseInt(req.query.tail as string);
    // Ceiling as well as floor, and it matters more here than on the agents
    // route: this reads once PER RUNNING AGENT in the thread, up to
    // MAX_AGENTS_PER_GROUP of them, in a single request.
    const tail = Number.isNaN(parsedTail) ? 20 : Math.max(0, Math.min(parsedTail, MAX_EVENT_TAIL));

    if (!follow) {
      // One-shot: collect events from all running agents, filter, return JSON
      const allEvents: any[] = [];
      // Same reasoning as agents.ts's identical one-shot merge failure: falling
      // through to res.json(allEvents) after a non-size read failure would hand
      // back a 200 array that looks like the thread's complete event history
      // and silently omits every event from the agent whose read failed.
      const failedAgents: string[] = [];

      for (const agent of runningAgents) {
        try {
          const stream = await execInContainer(agent.agent_id, [
            'tail', '-n', String(tail), '/var/log/agentbox/events.jsonl',
          ]);

          // Bounded as it arrives, per agent. `tail -n` limits the number of
          // lines asked for; nothing limits how long one line is, and the agent
          // writes this file.
          const raw = (await collectBounded(stream)).toString('utf-8');
          const events = raw.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter((e: any) => e !== null);

          // Correlation filter: match on top-level correlation_id or metadata.message_id
          for (const event of events) {
            const cid = event.correlation_id || event.metadata?.message_id;
            if (cid && threadMessageIds.has(cid)) {
              allEvents.push(event);
            }
          }
        } catch (err) {
          if (err instanceof ReadTooLargeError) {
            // Refuse the request rather than continuing round the loop. Carrying
            // on would read the next agent's log too — the multiplier is exactly
            // what makes this route worse than its sibling — and would return a
            // 200 whose events are silently missing one agent's worth.
            res.status(413).json({
              error: 'Event log too large',
              detail: `An agent's event log exceeds the ${MAX_READ_BYTES}-byte read limit. Lower ?tail=.`,
            });
            return;
          }
          console.error(`[chat-events] Failed to read events from ${agent.agent_id}:`, err);
          failedAgents.push(agent.agent_id);
        }
      }

      if (failedAgents.length > 0) {
        res.status(502).json({
          error: 'Failed to read events from one or more agents',
          detail: `Could not read events from: ${failedAgents.join(', ')}. Retry.`,
        });
        return;
      }

      // Sort by timestamp
      allEvents.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      res.json(allEvents);
      return;
    }

    // SSE mode: stream events from all running agents, correlation-filtered
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // This stream must not outlive the credential that authorised it. It is
    // authenticated once, here, and then held open indefinitely by the poll and
    // heartbeat below — so without a deadline it keeps delivering after the token
    // expires, after sign-out, and after roles are revoked. Same defect as the
    // terminal proxy (app#145), different transport.
    const clearDeadline = armCredentialDeadline(
      res as never,
      (req as any).user?.exp,
      () => endStreamForExpiredCredential(res as never, 'chat-events'),
    );
    req.on('close', () => clearDeadline?.());
    res.flushHeaders();

    const streams: NodeJS.ReadableStream[] = [];
    const buffers = new Map<string, string>();

    /*
     * HERE THE HOLE MULTIPLIES BY THE NUMBER OF AGENTS IN THE THREAD.
     *
     * The loop below awaits `execInContainer` once per running agent —
     * MAX_AGENTS_PER_GROUP is 8. `cleanup`, which destroys them, used to be
     * registered AFTER the whole loop, so a client that went away at agent 3 of 8
     * emitted 'close' with no destroying listener attached. 'close' is not
     * replayed, so the listener registered afterwards never fired and every stream
     * the loop had opened — and every one it went on to open — ran `tail -f` for
     * the life of the process.
     *
     * TWO CONDITIONS, AND THE SECOND MATTERS MORE HERE THAN ON THE AGENT ROUTES.
     * Registering cleanup first (below) bounds the damage to streams already
     * created. Checking `closed` at the TOP OF EACH ITERATION is what stops the
     * loop opening seven more for a client that has gone: destroying eight streams
     * that should never have been opened is a leak fixed and the work still wasted.
     *
     * The comment that used to sit below this loop already named the hazard —
     * "the container-stream setup above contains awaits during which 'close' can
     * arrive unobserved" — and then registered the listener after them anyway.
     * `closed` guarded the timers; nothing guarded the streams.
     */
    let closed = false;
    let messageRefreshInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      closed = true;
      if (messageRefreshInterval) { clearInterval(messageRefreshInterval); messageRefreshInterval = null; }
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      for (const stream of streams) {
        (stream as any).destroy?.();
      }
      streams.length = 0;
    };
    req.on('close', cleanup);

    // Same defect as the DB-backed thread stream (#204): every frame here went
    // through a raw res.write(), discarding the return value, with no
    // 'drain' listener or writableLength check. Unlike that route, the
    // producers here ARE pausable streams — one `tail -f` per running agent —
    // so backpressure pauses all of them as a group rather than a poll timer.
    // A write failing because one agent is chattier than another still means
    // the CLIENT is behind on everything already queued for it.
    const sse = createBoundedSseWriter(res as never, {
      hardCapBytes: SSE_DEFAULTS.hardCapBytes,
      onOverflow: (queued) => {
        console.error(
          `[chat-events] SSE aborted: ${queued} bytes queued for a client that is not reading`,
        );
        cleanup();
        res.write(
          `event: error\ndata: ${JSON.stringify({
            error: 'Client not reading',
            detail: 'The event stream was stopped because its buffer limit was exceeded.',
          })}\n\n`,
        );
        res.end();
      },
    });
    sse.setSource({
      pause() { for (const s of streams) (s as any).pause?.(); },
      resume() { for (const s of streams) (s as any).resume?.(); },
    });

    for (const agent of runningAgents) {
      // The client is already gone: stop, rather than opening the rest of the
      // thread's streams so that cleanup can immediately destroy them.
      if (closed) break;
      try {
        const stream = await execInContainer(agent.agent_id, [
          'tail', '-f', '-n', String(tail), '/var/log/agentbox/events.jsonl',
        ]);
        streams.push(stream);
        buffers.set(agent.agent_id, '');
        // 'close' arrived during THIS exec, so cleanup ran before this stream was
        // pushed and did not see it.
        if (closed) { (stream as any).destroy?.(); break; }

        stream.on('data', (chunk: Buffer) => {
          if (res.writableEnded || res.destroyed) return;
          let buffer = (buffers.get(agent.agent_id) || '') + chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffers.set(agent.agent_id, lines.pop() || '');

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let event: any;
            try { event = JSON.parse(trimmed); } catch { continue; }
            // Correlation filter: match on top-level correlation_id or metadata.message_id
            const cid = event.correlation_id || event.metadata?.message_id;
            if (cid && threadMessageIds.has(cid)) {
              sse.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          }
        });

        stream.on('end', () => {
          // Flush remaining buffer
          const remaining = buffers.get(agent.agent_id)?.trim();
          if (remaining) {
            try {
              const event = JSON.parse(remaining);
              const cid = event.correlation_id || event.metadata?.message_id;
              if (cid && threadMessageIds.has(cid)) {
                sse.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            } catch { /* skip */ }
          }
        });

        stream.on('error', (err: Error) => {
          console.error(`[chat-events] Stream error for ${agent.agent_id}:`, err);
          // app#443: this used to be silent — if this was the thread's only
          // running agent, the client saw heartbeats and nothing else once its
          // log-tail died, with no way to tell that apart from the agent
          // legitimately going quiet. Threshold 1, not derived from
          // failureThresholdFor: unlike the interval-based polls below, a
          // `tail -f` stream's 'error' is a one-time terminal event for THAT
          // agent, not a recurring tick with a next chance to self-heal — there
          // is no cadence to wait out, so waiting would only delay a signal
          // that is already final. Does not end the overall connection: other
          // agents in the thread may still be streaming fine.
          if (res.writableEnded || res.destroyed) return;
          sse.write(sseErrorFrame(
            'An agent stream stopped',
            `The event log for agent ${agent.agent_id} could not be read further. ` +
            'Other agents in this thread, if any, are unaffected.',
          ));
        });
      } catch (err) {
        console.error(`[chat-events] Failed to open stream for ${agent.agent_id}:`, err);
      }
    }

    // Cleanup and the `closed` flag are declared ABOVE the stream loop — see the
    // comment there. Timers are still only created for a client that is still here.

    if (closed || res.writableEnded || res.destroyed) return;

    // Pick up messages that arrive mid-conversation — INCREMENTALLY (#216).
    //
    // This used to re-read every id in the thread every five seconds, per
    // connected client, for the life of the connection: a repeated scan whose
    // cost grew with the thread while the interval stayed fixed. Nothing was
    // truncated and no answer was wrong, so there is no "showing N of M" to
    // add here — the defect was cost, not correctness, which is why this is a
    // different family from the truncation work and got its own issue.
    //
    // `seq > lastSeenSeq` makes each refresh proportional to what actually
    // arrived. Never `clear()`: the set is only ever added to, and clearing
    // before a failed query would drop ids the filter still needs.
    //
    // A stale-message reconcile reassigns seq via nextval, so a bumped message
    // can reappear above the watermark. Re-adding it is a no-op on a Set, and
    // nothing is ever missed because nextval only moves forward.
    // app#443: this catch used to be silent, and it is worse than the other
    // three sites this issue names — a persistent failure here does not just
    // stall the client's view, it actively DROPS data. threadMessageIds stops
    // learning about new message ids, so events a still-healthy agent
    // legitimately emits fail the correlation check below and are filtered
    // out as "uncorrelated", never delivered, with the connection looking
    // exactly as healthy as ever.
    const refreshMs = chatEventsRefreshMs();
    const refreshFailureSignal = createPollFailureSignal(
      failureThresholdFor(refreshMs),
      () => {
        if (res.writableEnded || res.destroyed) return;
        sse.write(sseErrorFrame(
          'New messages may not be detected',
          'This stream has been unable to check for new messages in the thread for a while. ' +
          'Events from agents replying to a message sent after this problem started may not ' +
          'appear until it clears.',
        ));
      },
    );
    messageRefreshInterval = setInterval(async () => {
      if (res.writableEnded || res.destroyed) return;
      try {
        const { rows } = await pool.query(
          `SELECT id, seq FROM chat_messages WHERE thread_id = $1 AND seq > $2`,
          [threadId, lastSeenSeq]
        );
        for (const r of rows) {
          threadMessageIds.add(r.id);
          const seq = Number(r.seq);
          if (seq > lastSeenSeq) lastSeenSeq = seq;
        }
        refreshFailureSignal.recordSuccess();
      } catch {
        refreshFailureSignal.recordFailure();
      }
    }, refreshMs);

    // Keep-alive heartbeat
    // The participation re-check rides THIS tick rather than arming a second timer
    // (issue #196). Access was checked once before the stream opened, so removing a
    // participant left their events flowing until the token expired. Admins are
    // exempt exactly as they are at the initial check.
    heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      sse.write(': heartbeat\n\n');

      if (admin) return;
      void (async () => {
        const allowed = await stillAuthorised(
          () => isParticipant(threadId, user.sub, admin),
          'chat-events',
        );
        if (allowed || res.writableEnded || res.destroyed) return;
        endStreamForRevokedAccess(res, 'chat-events');
        cleanup();
      })();
    }, 30000);

    // A close that landed between the guard above and here still gets cleaned up.
    if (closed) cleanup();

  } catch (err) {
    console.error('[chat] Thread events error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get thread events' });
    }
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id/screenshot — live browser screenshot from agentbox
// ───────────────────────────────────────────────────────────────────

const AGENTBOX_PORT = 8054;

router.get('/threads/:id/screenshot', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT a.agent_id
       FROM chat_participants cp
       JOIN agents a ON a.id = cp.participant_id::uuid
       WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND a.status = 'running'
       LIMIT 1`,
      [threadId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'No running agent in thread' });
      return;
    }

    const agentId = rows[0].agent_id;
    const url = `http://agentbox-${agentId}:${AGENTBOX_PORT}/screenshot`;

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
      res.status(504).json({ error: 'Agentbox screenshot timed out' });
      return;
    }
    console.error('[chat] Screenshot proxy error:', err);
    res.status(502).json({ error: 'Failed to get screenshot from agentbox' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads/:id/browser/* — proxy browser control to agentbox
// ───────────────────────────────────────────────────────────────────

async function proxyBrowserAction(
  req: Request,
  res: Response,
  action: 'click' | 'element' | 'navigate' | 'history' | 'scroll' | 'type' | 'keypress',
  body: any
): Promise<void> {
  const user = (req as any).user;
  const admin = isAdmin(req);
  const threadId = req.params.id;

  if (!(await isParticipant(threadId, user.sub, admin))) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT a.agent_id
     FROM chat_participants cp
     JOIN agents a ON a.id = cp.participant_id::uuid
     WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND a.status = 'running'
     LIMIT 1`,
    [threadId]
  );

  if (rows.length === 0) {
    res.status(404).json({ error: 'No running agent in thread' });
    return;
  }

  const agentId = rows[0].agent_id;
  const url = `http://agentbox-${agentId}:${AGENTBOX_PORT}/browser/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    if (err.name === 'TimeoutError') {
      res.status(504).json({ error: `Browser ${action} timed out` });
      return;
    }
    console.error(`[chat] Browser ${action} proxy error:`, err);
    res.status(502).json({ error: `Failed to forward ${action} to agentbox` });
  }
}

router.post('/threads/:id/browser-click', requireRole('user'), async (req: Request, res: Response) => {
  const { x_percent, y_percent } = req.body;
  if (typeof x_percent !== 'number' || typeof y_percent !== 'number') {
    res.status(400).json({ error: 'x_percent and y_percent required' });
    return;
  }
  await proxyBrowserAction(req, res, 'click', { x_percent, y_percent });
});

router.post('/threads/:id/browser-element', requireRole('user'), async (req: Request, res: Response) => {
  const { x_percent, y_percent } = req.body;
  if (typeof x_percent !== 'number' || typeof y_percent !== 'number') {
    res.status(400).json({ error: 'x_percent and y_percent required' });
    return;
  }
  await proxyBrowserAction(req, res, 'element', { x_percent, y_percent });
});

router.post('/threads/:id/browser-navigate', requireRole('user'), async (req: Request, res: Response) => {
  const { url } = req.body;
  if (typeof url !== 'string' || !url) {
    res.status(400).json({ error: 'url required' });
    return;
  }
  await proxyBrowserAction(req, res, 'navigate', { url });
});

router.post('/threads/:id/browser-history', requireRole('user'), async (req: Request, res: Response) => {
  const { action } = req.body;
  if (!['back', 'forward', 'reload'].includes(action)) {
    res.status(400).json({ error: 'action must be back|forward|reload' });
    return;
  }
  await proxyBrowserAction(req, res, 'history', { action });
});

router.post('/threads/:id/browser-scroll', requireRole('user'), async (req: Request, res: Response) => {
  const { delta_x, delta_y } = req.body;
  await proxyBrowserAction(req, res, 'scroll', { delta_x: delta_x || 0, delta_y: delta_y || 0 });
});

router.post('/threads/:id/browser-type', requireRole('user'), async (req: Request, res: Response) => {
  const { text } = req.body;
  if (typeof text !== 'string') {
    res.status(400).json({ error: 'text required' });
    return;
  }
  await proxyBrowserAction(req, res, 'type', { text });
});

router.post('/threads/:id/browser-keypress', requireRole('user'), async (req: Request, res: Response) => {
  const { key } = req.body;
  if (typeof key !== 'string' || !key) {
    res.status(400).json({ error: 'key required' });
    return;
  }
  await proxyBrowserAction(req, res, 'keypress', { key });
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id/search — full-text search messages
// ───────────────────────────────────────────────────────────────────

router.get('/threads/:id/search', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.status(400).json({ error: 'q query parameter is required' });
      return;
    }

    const pool = getPool();

    // Use plainto_tsquery for safe user input (no special syntax needed)
    const { rows } = await pool.query(
      `SELECT id, seq, author_id, author_type, role, content, status,
              reply_to, target_agents,
              chain_id, chain_hop, triggered_by,
              model, input_tokens, output_tokens, duration_ms,
              error_message, created_at,
              ts_headline('english', content, plainto_tsquery('english', $2),
                'StartSel=**,StopSel=**,MaxFragments=3,MaxWords=40,MinWords=20') AS headline
       FROM chat_messages
       WHERE thread_id = $1
         AND status IN ('complete', 'thinking')
         AND content != ''
         AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)
       ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $2)) DESC
       LIMIT 50`,
      [threadId, q]
    );

    /*
     * `total` was `rows.length` under the LIMIT 50 above — a field literally named
     * total, reporting the size of a page. Nothing renders it today, and that is
     * exactly why it is fixed here rather than left: an identical-shape defect
     * left alone because it is small is how it becomes someone's dashboard figure
     * later. We watched that happen once already (#197, via #180 and #188).
     *
     * Same predicate as the page, so the count cannot describe a different set.
     */
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) AS total
         FROM chat_messages
        WHERE thread_id = $1
          AND status IN ('complete', 'thinking')
          AND content != ''
          AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)`,
      [threadId, q]
    );
    const total = Number(countRows[0].total);

    res.json({
      results: rows,
      query: q,
      // How many matched, not how many fit.
      total,
      truncated: total > rows.length,
    });
  } catch (err) {
    console.error('[chat] Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ───────────────────────────────────────────────────────────────────
// Internal callback handler (separate router, no Keycloak auth)
// ───────────────────────────────────────────────────────────────────

export async function chatCallbackHandler(req: Request, res: Response): Promise<void> {
  // Auth: CHAT_CALLBACK_TOKEN (timing-safe)
  const configuredToken = process.env.CHAT_CALLBACK_TOKEN;
  if (!configuredToken) {
    console.error('[chat-callback] CHAT_CALLBACK_TOKEN not configured');
    res.status(503).json({ error: 'callback_not_configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const expected = Buffer.from(configuredToken);
  const received = Buffer.from(token);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // Parse callback body
  const { message_id, content, model, input_tokens, output_tokens, duration_ms, status, error_message } = req.body;

  if (!message_id) {
    res.status(400).json({ error: 'message_id is required' });
    return;
  }

  // Reject non-null idempotency_key from agent-authored messages (§D18)
  if (req.body.idempotency_key !== undefined && req.body.idempotency_key !== null) {
    res.status(400).json({ error: 'idempotency_key is not allowed in callback' });
    return;
  }

  const pool = getPool();

  // Thinking callbacks are intermediate progress updates during tool loops.
  // They update content + advance seq (so SSE picks up) but stay non-terminal.
  if (status === 'thinking') {
    // updated_at is what lets the stale sweeper tell a message still
    // actively progressing through repeated thinking callbacks from one
    // that has genuinely stalled — created_at alone cannot distinguish
    // them, since it never changes after the row is inserted.
    const { rowCount } = await pool.query(
      `UPDATE chat_messages
       SET content = $2, status = 'thinking', model = $3,
           input_tokens = $4, output_tokens = $5, duration_ms = $6,
           seq = nextval('chat_messages_seq'), updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'thinking')`,
      [message_id, content || '', model || null,
       input_tokens || null, output_tokens || null, duration_ms || null]
    );

    if (rowCount === 0) {
      const { rows } = await pool.query(
        `SELECT status FROM chat_messages WHERE id = $1`,
        [message_id]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'unknown_message' });
        return;
      }
      // Already terminal — ignore thinking update
      res.json({ updated: false });
      return;
    }

    console.info(`[chat-callback] Thinking update for message ${message_id}`);
    // Update thread timestamp for thinking updates too
    await pool.query(
      `UPDATE chat_threads SET updated_at = NOW()
       WHERE id = (SELECT thread_id FROM chat_messages WHERE id = $1)`,
      [message_id]
    );
    res.json({ updated: true });
    return;
  }

  const finalStatus = status === 'error' ? 'error' : 'complete';

  // Guarded UPDATE: only non-terminal → terminal (§7.5 idempotency rules)
  // Advances seq so SSE cursor picks up the state transition
  const { rowCount } = await pool.query(
    `UPDATE chat_messages
     SET content = $2, status = $3, model = $4,
         input_tokens = $5, output_tokens = $6, duration_ms = $7,
         error_message = $8, seq = nextval('chat_messages_seq'), updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'thinking')`,
    [message_id, content || '', finalStatus, model || null,
     input_tokens || null, output_tokens || null, duration_ms || null,
     error_message || null]
  );

  if (rowCount === 0) {
    // Check if message exists at all
    const { rows } = await pool.query(
      `SELECT status FROM chat_messages WHERE id = $1`,
      [message_id]
    );

    if (rows.length === 0) {
      console.warn(`[chat-callback] Unknown message_id: ${message_id}`);
      res.status(404).json({ error: 'unknown_message' });
      return;
    }

    // Already terminal — no-op
    console.info(`[chat-callback] Callback no-op: message ${message_id} already terminal (${rows[0].status})`);
    res.json({ updated: false });
    return;
  }

  console.info(`[chat-callback] Updated message ${message_id}: status=${finalStatus}`);

  // Update thread timestamp + auto-name untitled threads from first user message
  await pool.query(
    `UPDATE chat_threads SET updated_at = NOW(),
       title = CASE
         WHEN title IS NULL THEN (
           SELECT LEFT(content, 50) FROM chat_messages
           WHERE thread_id = chat_threads.id AND author_type = 'human'
           ORDER BY created_at ASC LIMIT 1
         )
         ELSE title
       END
     WHERE id = (SELECT thread_id FROM chat_messages WHERE id = $1)`,
    [message_id]
  );

  // ── Auto-journal: persist interaction to agent memory (fire-and-forget) ──
  if (finalStatus === 'complete' && content && process.env.AKM_INTERNAL_SERVICE_TOKEN) {
    try {
      const { rows: journalRows } = await pool.query(
        // #292: a.id is uuid, m.author_id is varchar. Postgres refuses
        // `uuid = character varying`, so this statement had never executed —
        // and it sits in a fire-and-forget block, so the auto-journal silently
        // never worked. The comment lives here rather than inside the SQL: a
        // trailing `--` swallows the statement separator when the checker
        // batches these into one file.
        `SELECT m.author_id, a.agent_id AS agent_slug, a.created_by AS owner_sub
         FROM chat_messages m
         JOIN agents a ON a.id::text = m.author_id
         WHERE m.id = $1 AND m.author_type = 'agent'`,
        [message_id]
      );
      if (journalRows.length > 0) {
        const agentSlug = journalRows[0].agent_slug;
        const tokenCount = (input_tokens || 0) + (output_tokens || 0);
        const preview = (content || '').length > 300
          ? content.slice(0, 300) + '…'
          : content;
        const journalContent =
          `**Chat response** (${model || 'unknown'}, ${tokenCount} tokens, ${duration_ms || 0}ms)\n\n${preview}`;
        // #292: BOTH failure shapes, because only one of them was visible.
        //
        // A rejection was logged. A NON-2xx RESPONSE was not looked at at all —
        // `appendJournal` resolves with `{status}` for an upstream 503 or 500,
        // so "knowledge service not configured" landed in a promise nobody
        // inspected. Silent, and the more likely of the two.
        //
        // Still fire-and-forget, still non-blocking: journalling must not fail
        // a chat reply. What changes is that the failure is counted, so a blip
        // and a broken feature stop looking the same.
        appendJournal(agentSlug, journalContent)
          .then((resp) => {
            if (resp.status >= 200 && resp.status < 300) {
              recordJournalSuccess(agentSlug);
            } else {
              const detail = (resp.data as { error?: string } | null)?.error ?? `HTTP ${resp.status}`;
              recordJournalFailure(agentSlug, journalRows[0].owner_sub ?? null, detail);
            }
          })
          .catch((err: unknown) => {
            recordJournalFailure(
              agentSlug,
              journalRows[0].owner_sub ?? null,
              err instanceof Error ? err.message : String(err),
            );
          });
      }
    } catch (journalErr) {
      console.error('[chat-callback] Journal lookup failed (non-blocking):', journalErr);
    }
  }

  // ── Batch completion detection for group threads ──
  // Check if all sibling messages (same reply_to) are terminal
  try {
    const { rows: batchRows } = await pool.query(
      `SELECT m.reply_to, t.type AS thread_type
       FROM chat_messages m
       JOIN chat_threads t ON t.id = m.thread_id
       WHERE m.id = $1`,
      [message_id]
    );
    if (batchRows.length > 0 && batchRows[0].thread_type === 'group' && batchRows[0].reply_to) {
      const replyTo = batchRows[0].reply_to;
      const { rows: siblingRows } = await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('complete', 'error'))::int AS terminal
         FROM chat_messages
         WHERE reply_to = $1 AND author_type = 'agent'`,
        [replyTo]
      );
      if (siblingRows.length > 0 && siblingRows[0].total > 0 && siblingRows[0].terminal === siblingRows[0].total) {
        await pool.query(
          `UPDATE chat_messages SET batch_complete = true, seq = nextval('chat_messages_seq')
           WHERE id = $1`,
          [message_id]
        );
        console.info(`[chat-callback] Batch complete for reply_to=${replyTo} (${siblingRows[0].total} agents)`);
      }
    }
  } catch (batchErr) {
    console.error('[chat-callback] Batch completion check failed (non-blocking):', batchErr);
  }

  // Elevated-agent response tagging (D6): informational audit only
  try {
    const { rows: msgRows } = await pool.query(
      `SELECT author_id FROM chat_messages WHERE id = $1 AND author_type = 'agent'`,
      [message_id]
    );
    if (msgRows.length > 0) {
      const elevatedScope = await getAgentElevatedScope(msgRows[0].author_id);
      if (elevatedScope) {
        auditLog('elevated_agent_response', msgRows[0].author_id, 'service', 'service', { message_id, skill_scope: elevatedScope, status: finalStatus });
      }
    }
  } catch (tagErr) {
    console.error('[chat-callback] Elevated tagging failed (non-blocking):', tagErr);
  }

  // ── Agent-to-agent @mention orchestration (fire-and-forget) ──
  // Only on successful complete callbacks with non-empty content
  if (finalStatus === 'complete' && content && typeof content === 'string' && content.trim()) {
    try {
      const { slugs } = parseMentions(content);
      if (slugs.length > 0) {
        // Get triggering message metadata
        const { rows: trigRows } = await pool.query(
          `SELECT thread_id, author_id, chain_id, chain_hop FROM chat_messages WHERE id = $1`,
          [message_id]
        );
        if (trigRows.length > 0) {
          const trigMsg = trigRows[0];
          const threadId = trigMsg.thread_id;

          // Resolve mentioned slugs to participants in this thread (unknown silently ignored)
          const resolved = await resolveAgentSlugs(threadId, slugs);
          if (resolved.size > 0) {
            // Self-mention guard: remove the author from targets
            const targetUuids = [...resolved.values()].filter(uuid => uuid !== trigMsg.author_id);

            if (targetUuids.length > 0) {
              // Chain_id: reuse from triggering message, or generate new
              let chainId = trigMsg.chain_id;
              const currentHop = trigMsg.chain_hop ?? 0;

              if (!chainId) {
                chainId = crypto.randomUUID();
                // Backfill triggering message as hop 0
                await pool.query(
                  `UPDATE chat_messages SET chain_id = $1, chain_hop = 0 WHERE id = $2 AND chain_id IS NULL`,
                  [chainId, message_id]
                );
              }

              const newHop = currentHop + 1;

              // Hop budget guard
              if (newHop <= MAX_CHAIN_HOPS) {
                // Time budget guard
                const { rows: timeRows } = await pool.query(
                  `SELECT MIN(created_at) AS chain_start FROM chat_messages WHERE chain_id = $1`,
                  [chainId]
                );
                const chainStart = timeRows[0]?.chain_start ? new Date(timeRows[0].chain_start).getTime() : Date.now();
                const elapsed = Date.now() - chainStart;

                if (elapsed <= MAX_CHAIN_DURATION_MS) {
                  // Cycle detection: find agents already participating in this chain
                  const { rows: cycleRows } = await pool.query(
                    `SELECT DISTINCT author_id FROM chat_messages
                     WHERE chain_id = $1 AND author_type = 'agent' AND status IN ('complete', 'pending')`,
                    [chainId]
                  );
                  const chainParticipants = new Set(cycleRows.map((r: any) => r.author_id));

                  // Filter out agents already in the chain (cycle prevention)
                  const freshTargets = targetUuids.filter(uuid => !chainParticipants.has(uuid));

                  if (freshTargets.length > 0) {
                    // Load agent info, apply elevated scope gate + concurrency guard
                    const eligibleAgents: NonNullable<Awaited<ReturnType<typeof getAgentForDispatch>>>[] = [];

                    for (const uuid of freshTargets) {
                      // Elevated scope gate: agents cannot dispatch to elevated agents
                      const elevatedScope = await getAgentElevatedScope(uuid);
                      if (elevatedScope) {
                        auditLog('agent_to_agent_dispatch', uuid, trigMsg.author_id, 'agent', {
                          thread_id: threadId, chain_id: chainId, blocked: 'elevated_scope', scope: elevatedScope,
                        });
                        continue;
                      }

                      const agent = await getAgentForDispatch(uuid);
                      if (!agent || agent.status !== 'running' || !agent.work_token) continue;

                      // Per-agent concurrency guard
                      const { rows: pendingRows } = await pool.query(
                        `SELECT 1 FROM chat_messages
                         WHERE thread_id = $1 AND author_id = $2 AND author_type = 'agent' AND status = 'pending'
                         LIMIT 1`,
                        [threadId, agent.id]
                      );
                      if (pendingRows.length > 0) continue;

                      eligibleAgents.push(agent);
                    }

                    if (eligibleAgents.length > 0) {
                      // Load message history
                      const { rows: history } = await pool.query(
                        `SELECT role, content FROM chat_messages
                         WHERE thread_id = $1 AND status = 'complete'
                         ORDER BY seq DESC LIMIT $2`,
                        [threadId, MESSAGE_HISTORY_LIMIT]
                      );
                      const historyMessages = history.reverse();

                      // Build participant list for group context in chain dispatch
                      const { rows: threadInfoRows } = await pool.query(
                        `SELECT t.type FROM chat_threads t WHERE t.id = $1`, [threadId]
                      );
                      const chainThreadType = threadInfoRows[0]?.type;
                      let chainParticipantsList: { agent_id: string; name: string }[] | undefined;
                      if (chainThreadType === 'group') {
                        const { rows: pRows } = await pool.query(
                          `SELECT a.agent_id, a.name FROM chat_participants cp
                           JOIN agents a ON a.id = cp.participant_id::uuid
                           WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND cp.left_at IS NULL`,
                          [threadId]
                        );
                        chainParticipantsList = pRows.map((r: any) => ({ agent_id: r.agent_id, name: r.name || r.agent_id }));
                      }

                      const { dispatched: chainDispatched } = await dispatchToAgents({
                        threadId,
                        agents: eligibleAgents,
                        replyTo: message_id,
                        historyMessages,
                        chainId,
                        chainHop: newHop,
                        triggeredBy: message_id,
                        threadType: chainThreadType || undefined,
                        participants: chainParticipantsList,
                      });

                      for (const d of chainDispatched) {
                        auditLog('agent_to_agent_dispatch', d.agent_id, trigMsg.author_id, 'agent', {
                          thread_id: threadId, chain_id: chainId, chain_hop: newHop,
                          triggered_by: message_id, message_id: d.message_id,
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (orchErr) {
      console.error('[chat-callback] Agent-to-agent orchestration error (non-blocking):', orchErr);
    }
  }

  res.json({ updated: true });
}

// ───────────────────────────────────────────────────────────────────
// Stale message sweeper (§9, cleanup path 2)
// ───────────────────────────────────────────────────────────────────

let staleSweepInterval: ReturnType<typeof setInterval> | null = null;

export function startStaleSweeper(): void {
  if (staleSweepInterval) return;

  staleSweepInterval = setInterval(async () => {
    try {
      // chatCallbackHandler's own guarded UPDATE treats status IN ('pending',
      // 'thinking') as the equivalence class of "still open" — a message sits
      // at 'thinking' between an intermediate progress callback and the final
      // complete/error one. This sweeper is the only thing that can terminate
      // a message whose FINAL callback never arrives (agentbox's
      // _deliver_callback is fire-and-forget, no retry), and a message that
      // reached 'thinking' had strictly MORE done for it — the agent already
      // sent at least one update — than one still at 'pending', so it must
      // not have LESS of a safety net. Matching only 'pending' here left
      // exactly that message permanently stuck with no error and no recovery.
      // updated_at, not created_at: a 'thinking' message legitimately
      // receives repeated progress callbacks during a long tool-use loop,
      // each refreshing updated_at (see the callback handler above). Keying
      // this off created_at would sweep a message still actively making
      // progress the moment it turned 2 minutes old, which is a worse
      // defect than the one this sweeper exists to fix. For a 'pending'
      // message that never received any callback, updated_at still equals
      // its insert-time default, so this is not a behavior change for the
      // case the sweeper originally covered.
      const { rowCount } = await getPool().query(
        `UPDATE chat_messages
         SET status = 'error', error_message = $1,
             seq = nextval('chat_messages_seq'), updated_at = NOW()
         WHERE status IN ('pending', 'thinking') AND updated_at < NOW() - INTERVAL '2 minutes'`,
        [NO_RESPONSE_MESSAGE]
      );
      if (rowCount && rowCount > 0) {
        console.log(`[chat-sweeper] Marked ${rowCount} stale pending/thinking message(s) as error`);
      }
    } catch (err) {
      console.error('[chat-sweeper] Error:', err);
    }
  }, 60_000);
}

export function stopStaleSweeper(): void {
  if (staleSweepInterval) {
    clearInterval(staleSweepInterval);
    staleSweepInterval = null;
  }
}

// Export helpers for testing
export { parseMentions, resolveAgentSlugs, dispatchToAgents };

export default router;
