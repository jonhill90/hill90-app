/**
 * Workflow CRUD and execution routes. Everything here is mounted behind
 * requireAuth (app.ts).
 *
 *   GET    /workflows              — list workflows
 *   POST   /workflows              — create workflow
 *   GET    /workflows/:id          — get workflow
 *   PUT    /workflows/:id          — update workflow
 *   DELETE /workflows/:id          — delete workflow
 *   POST   /workflows/:id/run      — manually trigger a workflow
 *   GET    /workflows/:id/runs     — get run history
 *
 * POST /workflows/webhook/:token — the inbound webhook trigger — lives in
 * routes/workflows-webhook.ts instead, genuinely public and mounted ahead
 * of requireAuth. It used to live here, behind the same requireAuth as
 * everything above, which made it unreachable by any external caller
 * despite this file's own former header claiming otherwise. See that
 * file's header for why the token alone is sufficient authentication.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin } from '../helpers/elevated-scope';
import { reportedStatus, isStatusVerified } from '../services/agent-status-verification';
import { isValidCronExpression, computeNextRun } from '../helpers/cron';
import { requiredNonEmptyError } from '../helpers/required-field';

const router = Router();

// app#599 (Type B — no validator existed in either route, not a PUT/POST
// parity gap). `output_type VARCHAR(32) NOT NULL DEFAULT 'none'` has no DB
// CHECK constraint, and neither route validated it — any string could be
// written from either POST or PUT. Deliberately choosing NEW behavior here,
// not matching an existing rule: 'none' is the ONLY value any code path in
// this repo has ever produced or consumed (workflow-scheduler.ts SELECTs
// the column but never branches on it; the UI's WorkflowsClient.tsx has no
// control to set it to anything else — checked both before choosing this,
// not assumed). If a second output_type is designed later, extend this
// list in the same commit that adds its handling, not before.
//
// Route-level validator only, deliberately NOT a DB CHECK constraint: a
// CHECK added by migration against `output_type NOT IN ('none')` would
// fail outright if any existing row already violates it, and there is no
// way to check live production data from here. The route guard closes the
// only thing this fix is actually about — new writes — without the added
// risk of a migration against data this session cannot see.
const VALID_OUTPUT_TYPES = ['none'];
function invalidOutputTypeError(outputType: unknown): string | null {
  if (outputType === undefined || outputType === null) return null;
  if (!VALID_OUTPUT_TYPES.includes(outputType as string)) {
    return `output_type must be one of: ${VALID_OUTPUT_TYPES.join(', ')}`;
  }
  return null;
}

// app#374: webhook_token_hash must never reach a response — it's a SHA-256
// digest of the real trigger secret (see migration 068), and while a hash
// can't be reversed into the token, there's no reason to return it either.
// Two variants: JOIN queries below alias the table `w` (workflows.id and
// agents.id would otherwise collide); INSERT/UPDATE ... RETURNING has no
// alias.
const PUBLIC_COLUMNS_JOINED = `w.id, w.name, w.description, w.agent_id, w.schedule_cron, w.prompt, w.output_type, w.output_config, w.enabled, w.last_run_at, w.next_run_at, w.created_by, w.created_at, w.updated_at, w.trigger_type`;
const PUBLIC_COLUMNS = `id, name, description, agent_id, schedule_cron, prompt, output_type, output_config, enabled, last_run_at, next_run_at, created_by, created_at, updated_at, trigger_type`;

/**
 * What this route is entitled to say about the agent a workflow belongs to.
 *
 * #250 added the third state and applied it in `routes/agents.ts`; #251 applied
 * it in `routes/chat.ts`. This route was found afterwards (#262), selecting
 * `a.status AS agent_status` and serializing it straight out of the join — so a
 * `running` row reconciliation could not check was reported here as fact after
 * two rounds of fixing exactly that.
 *
 * THE ENUMERATION THAT MISSED IT is the part worth carrying: #251 counted five
 * UI surfaces by reading the components it already had open, and never swept for
 * routes that SERVE a status. Rerun the method, not the number:
 *
 *   grep -rnE "a\\.status|agent_status" services/api/src/routes/
 *   grep -rn  "agent_status\\|\\.status === 'running'" services/ui/src
 */
function withReportedAgentStatus<T extends { agent_slug?: string; agent_status?: string }>(row: T): T {
  if (!row.agent_slug || row.agent_status == null) return row;
  return {
    ...row,
    agent_status: reportedStatus(row.agent_slug, row.agent_status),
    agent_status_verified: isStatusVerified(row.agent_slug),
  };
}

// ── List workflows ──────────────────────────────────────────────────
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT ${PUBLIC_COLUMNS_JOINED}, a.name AS agent_name, a.agent_id AS agent_slug, a.status AS agent_status
       FROM workflows w
       JOIN agents a ON w.agent_id = a.id
       ${admin ? '' : 'WHERE w.created_by = $1'}
       ORDER BY w.created_at DESC`,
      admin ? [] : [user.sub]
    );

    res.json(rows.map(withReportedAgentStatus));
  } catch (err: any) {
    console.error('[workflows] List error:', err);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// ── Create workflow ─────────────────────────────────────────────────
router.post('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { name, description, agent_id, schedule_cron, prompt, output_type, output_config, enabled } = req.body;

    if (!agent_id || !schedule_cron) {
      res.status(400).json({ error: 'name, agent_id, schedule_cron, and prompt are required' });
      return;
    }
    // app#599: name/prompt's own "required" check moved into a helper
    // shared with PUT below (and with container-profiles.ts/mcp-servers.ts,
    // which have the identical shape on their own required fields) — see
    // helpers/required-field.ts for why. agent_id/schedule_cron stay a
    // plain check here: both get deeper validation a few lines down
    // (existence, cron parsing) that already fully covers "missing", and
    // neither has PUT's asymmetry this fix exists to close.
    const nameError = requiredNonEmptyError(name, 'name');
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }
    const promptError = requiredNonEmptyError(prompt, 'prompt');
    if (promptError) {
      res.status(400).json({ error: promptError });
      return;
    }
    const outputTypeError = invalidOutputTypeError(output_type);
    if (outputTypeError) {
      res.status(400).json({ error: outputTypeError });
      return;
    }

    // app#487: this used to be a field-count check only ("5 or 6
    // whitespace-separated fields"), which accepted out-of-range values
    // like "99 99 99 99 99" — the scheduler's own cron-parser call rejects
    // those, but by then the row was already written with next_run_at left
    // unset, so the workflow silently never ran. Parse with the same
    // library the scheduler uses so a value accepted here is guaranteed to
    // parse there too.
    if (typeof schedule_cron !== 'string' || !isValidCronExpression(schedule_cron)) {
      res.status(400).json({ error: 'Invalid cron expression' });
      return;
    }

    // Verify agent exists and user has access
    const { rows: agentRows } = await getPool().query(
      'SELECT id FROM agents WHERE id = $1',
      [agent_id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const triggerType = req.body.trigger_type || 'cron';
    const webhookToken = triggerType === 'webhook' ? crypto.randomBytes(32).toString('hex') : null;
    // app#374: only the hash is stored. webhookToken (the raw value) lives
    // only in this request's memory and the response below — never in the
    // database, never again after this response is sent.
    const webhookTokenHash = webhookToken
      ? crypto.createHash('sha256').update(webhookToken).digest('hex')
      : null;

    // app#488: the scheduler only ever computed next_run_at for a workflow
    // that didn't have one via a ONE-TIME sweep at process boot
    // (initializeNextRuns) — tick() itself only polls
    // `next_run_at <= NOW()`, it never looks for NULL. A workflow created
    // any time after boot (the overwhelmingly common case for a long-lived
    // process) was written with next_run_at = NULL and stayed that way,
    // indistinguishable from a legitimate webhook-triggered workflow, until
    // someone happened to restart the API. Computing it here — with the
    // exact function the scheduler itself uses, so "accepted at creation"
    // can never drift from "the value the scheduler would have computed" —
    // closes the gap at its source instead of teaching the scheduler to
    // poll for NULL rows on every tick. initializeNextRuns() stays as a
    // backstop for genuine stragglers (e.g. a row where this computation
    // failed transiently), not the only path for the common case.
    //
    // The cron was already validated by isValidCronExpression above, backed
    // by the same cron-parser call computeNextRun makes, so this is not
    // expected to throw here in practice — but it is not re-guarded with
    // its own try/catch, because a throw at this point means the two checks
    // have silently diverged, which is a bug worth surfacing as a 500, not
    // masking as a workflow silently created with no schedule.
    const nextRunAt = triggerType === 'webhook' ? null : computeNextRun(schedule_cron);

    const { rows } = await getPool().query(
      `INSERT INTO workflows (name, description, agent_id, schedule_cron, prompt, output_type, output_config, enabled, created_by, trigger_type, webhook_token_hash, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        name,
        description || null,
        agent_id,
        triggerType === 'webhook' ? null : schedule_cron,
        prompt,
        output_type || 'none',
        JSON.stringify(output_config || {}),
        enabled !== false,
        user.sub,
        triggerType,
        webhookTokenHash,
        nextRunAt,
      ]
    );

    const result = rows[0];
    if (webhookToken) {
      // SHOWN EXACTLY ONCE. webhook_token_hash cannot be reversed, so this
      // response is the only chance the caller will ever have to see or
      // copy the trigger URL — the UI must capture it here, not re-fetch it.
      result.webhook_url = `/workflows/webhook/${webhookToken}`;
    }

    res.status(201).json(result);
  } catch (err: any) {
    console.error('[workflows] Create error:', err);
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

// ── Get workflow ────────────────────────────────────────────────────
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT ${PUBLIC_COLUMNS_JOINED}, a.name AS agent_name, a.agent_id AS agent_slug, a.status AS agent_status
       FROM workflows w
       JOIN agents a ON w.agent_id = a.id
       WHERE w.id = $1 ${admin ? '' : 'AND w.created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    res.json(withReportedAgentStatus(rows[0]));
  } catch (err: any) {
    console.error('[workflows] Get error:', err);
    res.status(500).json({ error: 'Failed to get workflow' });
  }
});

// ── Update workflow ─────────────────────────────────────────────────
router.put('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { name, description, agent_id, schedule_cron, prompt, output_type, output_config, enabled } = req.body;

    // app#599: POST requires name/prompt non-empty; PUT had no validator
    // for either, and both are passed raw into COALESCE below (no `|| null`
    // conversion), so an explicit '' would have been WRITTEN — an unnamed,
    // promptless workflow, the exact input POST already refuses. Only
    // validated when actually provided, matching the "omitted means
    // unchanged" contract every other optional PUT field here already has.
    if (name !== undefined) {
      const nameError = requiredNonEmptyError(name, 'name');
      if (nameError) {
        res.status(400).json({ error: nameError });
        return;
      }
    }
    if (prompt !== undefined) {
      const promptError = requiredNonEmptyError(prompt, 'prompt');
      if (promptError) {
        res.status(400).json({ error: promptError });
        return;
      }
    }
    const outputTypeError = invalidOutputTypeError(output_type);
    if (outputTypeError) {
      res.status(400).json({ error: outputTypeError });
      return;
    }

    // app#580: was `if (schedule_cron && !isValidCronExpression(...))` — a
    // truthy check, which SKIPPED validation entirely for an empty string.
    // `COALESCE($4, schedule_cron)` only falls back to the existing value on
    // SQL NULL, and an empty string is not NULL, so `schedule_cron: ""`
    // would have written an unvalidated empty string straight into the
    // column. Changed to `!== undefined && !== null` so any PROVIDED value,
    // including '', now reaches isValidCronExpression — which itself was
    // just corrected (helpers/cron.ts) to reject '' explicitly, since
    // cron-parser alone does not throw on it. Without that second fix this
    // check alone would not have been enough: isValidCronExpression('')
    // used to return true.
    if (schedule_cron !== undefined && schedule_cron !== null && !isValidCronExpression(schedule_cron)) {
      res.status(400).json({ error: 'Invalid cron expression' });
      return;
    }

    // app#580: next_run_at was completely absent from the UPDATE below — not
    // even COALESCE'd, just never mentioned — so Postgres left it exactly as
    // it was. Read the row's CURRENT enabled/schedule_cron/trigger_type
    // first, both to detect the two transitions that make the stored value
    // wrong and to compute against the correct POST-UPDATE cron (mirrors
    // the UPDATE's own COALESCE logic) without a second write.
    const { rows: existingRows } = await getPool().query(
      `SELECT enabled, schedule_cron, trigger_type FROM workflows WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );
    if (existingRows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const existing = existingRows[0];

    const resultingSchedule = schedule_cron ?? existing.schedule_cron;
    const resultingEnabled = enabled ?? existing.enabled;
    const scheduleChanged = typeof schedule_cron === 'string' && schedule_cron !== existing.schedule_cron;
    const reEnabled = existing.enabled === false && resultingEnabled === true;

    // Recompute on the two transitions that can make the stored value
    // wrong. Independent of the resulting `enabled` state — matching
    // app#488's own POST /workflows, which computes next_run_at from the
    // cron alone and does not gate it on `enabled` either — so a cron edit
    // made WHILE a workflow is disabled does not leave a second, separate
    // stale value sitting there until the workflow happens to be
    // re-enabled later. tick() itself still filters `WHERE enabled = true`,
    // so this is inert for a disabled row either way; keeping the column
    // accurate regardless just means "what would next fire, per the
    // current cron" never lies while inspected (UI, API response) during
    // the time a workflow happens to be off.
    //
    //   - schedule_cron changing: the stored value was computed from the
    //     OLD cron and is now simply wrong for the new one.
    //   - false -> true (re-enable): the stored value may be stale from
    //     however long the workflow sat disabled — possibly far in the
    //     past — which would make it fire on the very next tick instead of
    //     at its real next occurrence. Recomputed fresh from NOW, the same
    //     never-catch-up-a-backlog behavior executeWorkflow already applies
    //     when it skips a run and still advances next_run_at forward rather
    //     than leaving a past due-time in place.
    //   - Disabling (true -> false) alone, with no cron change, is NOT one
    //     of these: nothing about the due-time itself became wrong, only
    //     whether it is currently consulted. Left untouched.
    let nextRunAt: Date | null = null; // null = do not touch (COALESCE keeps existing)
    if (existing.trigger_type !== 'webhook' && (scheduleChanged || reEnabled)) {
      nextRunAt = computeNextRun(resultingSchedule);
    }

    const { rows } = await getPool().query(
      `UPDATE workflows SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        agent_id = COALESCE($3, agent_id),
        schedule_cron = COALESCE($4, schedule_cron),
        prompt = COALESCE($5, prompt),
        output_type = COALESCE($6, output_type),
        output_config = COALESCE($7, output_config),
        enabled = COALESCE($8, enabled),
        next_run_at = COALESCE($9, next_run_at),
        updated_at = NOW()
       WHERE id = $10 ${admin ? '' : 'AND created_by = $11'}
       RETURNING ${PUBLIC_COLUMNS}`,
      admin
        ? [name, description, agent_id, schedule_cron, prompt, output_type, output_config ? JSON.stringify(output_config) : null, enabled, nextRunAt, req.params.id]
        : [name, description, agent_id, schedule_cron, prompt, output_type, output_config ? JSON.stringify(output_config) : null, enabled, nextRunAt, req.params.id, user.sub]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err: any) {
    console.error('[workflows] Update error:', err);
    res.status(500).json({ error: 'Failed to update workflow' });
  }
});

// ── Delete workflow ─────────────────────────────────────────────────
router.delete('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rowCount } = await getPool().query(
      `DELETE FROM workflows WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (rowCount === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    res.json({ deleted: true });
  } catch (err: any) {
    console.error('[workflows] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
});

// ── Manual trigger ──────────────────────────────────────────────────
router.post('/:id/run', requireRole('user'), async (req: Request, res: Response) => {
  // Hoisted so the outer catch can mark the run it created. See the note below.
  let runId: string | null = null;
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows: wfRows } = await getPool().query(
      `SELECT w.*, a.agent_id AS agent_slug, a.status AS agent_status, a.work_token
       FROM workflows w
       JOIN agents a ON w.agent_id = a.id
       WHERE w.id = $1 ${admin ? '' : 'AND w.created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (wfRows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const wf = wfRows[0];

    if (wf.agent_status !== 'running') {
      res.status(409).json({ error: `Agent ${wf.agent_slug} is not running (status: ${wf.agent_status})` });
      return;
    }

    /*
     * From here until the response, a `workflow_runs` row exists saying 'running'.
     * Everything after this line — four inserts, two updates — can throw, and the
     * outer catch used to answer 500 while leaving that row running FOREVER.
     * Nothing else ever touched it: the `status = 'error'` update further down
     * lives inside the DISPATCH .catch, so it never fired for a failure in the
     * insert sequence.
     *
     * WHY THAT WAS THE WORST SEAM IN THIS SERVICE, and the ranking to apply to the
     * rest of them:
     *
     *   SELF-IDENTIFYING beats DETECTABLE beats NEITHER.
     *
     * A half-write that labels itself needs no detector — you read its own status.
     * One that is merely detectable needs somebody to think of the query, and
     * nobody does. One that is neither is permanent. This row was the third case
     * dressed as the first: it carried a status, and the status was a lie, because
     * `status='running' AND thread_id IS NULL` is ALSO the legitimate in-flight
     * state between here and the update below — so no snapshot could tell a dead
     * run from a live one except by age.
     *
     * `runId` is hoisted so the outer catch can reach it. That is the whole fix.
     */
    const { rows: runRows } = await getPool().query(
      `INSERT INTO workflow_runs (workflow_id, status) VALUES ($1, 'running') RETURNING *`,
      [wf.id]
    );
    const run = runRows[0];
    runId = run.id;

    // Create a chat thread and send the prompt
    const pool = getPool();

    const { rows: threadRows } = await pool.query(
      `INSERT INTO chat_threads (title, created_by) VALUES ($1, $2) RETURNING id`,
      [`Workflow: ${wf.name}`, user.sub]
    );
    const threadId = threadRows[0].id;

    // app#542: set thread_id on the run THE MOMENT it is known, not after
    // dispatch and the trailing updates. It used to be set last, after the
    // fire-and-forget dispatchChatWork() call below — dispatch itself
    // cannot fail this write (it is fire-and-forget), but if EITHER of the
    // two statements that used to sit after it threw, the outer catch
    // labelled the run 'error' correctly while thread_id stayed NULL
    // forever: a real chat thread and a real dispatch already happened,
    // orphaned from the run record a human would use to find them. Not a
    // half-write masked by a different value — this write simply never
    // reached that column, because a later statement threw first. Setting
    // it here closes the window entirely rather than covering specific
    // failure branches, the same "self-identifying beats detectable" shape
    // as runId being hoisted above.
    await pool.query(
      `UPDATE workflow_runs SET thread_id = $1 WHERE id = $2`,
      [threadId, run.id]
    );

    // Add agent as participant
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type)
       VALUES ($1, $2, 'agent')`,
      [threadId, wf.agent_id]
    );

    // Add user as participant
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type)
       VALUES ($1, $2, 'human')`,
      [threadId, user.sub]
    );

    // Insert the message
    const { rows: msgRows } = await pool.query(
      // #292: was `sender_id, sender_type`, columns chat_messages does not have
      // — the table uses author_id/author_type. Both workflow write paths would
      // have failed on every run. Found by check_sql_identifiers.sh, never by a
      // test, because the pool is mocked and a mocked query reaches no parser.
      `INSERT INTO chat_messages (thread_id, author_id, author_type, content, status)
       VALUES ($1, $2, 'human', $3, 'delivered')
       RETURNING id`,
      [threadId, user.sub, wf.prompt]
    );

    // Fetch model for the agent
    const { rows: policyRows } = await pool.query(
      `SELECT mp.allowed_models FROM model_policies mp
       JOIN agents a ON a.model_policy_id = mp.id
       WHERE a.id = $1`,
      [wf.agent_id]
    );
    const model = policyRows[0]?.allowed_models?.[0] || 'default';

    // Build messages
    const messages = [{ role: 'user', content: wf.prompt }];

    // Callback URL
    const callbackUrl = `http://api:3000/internal/chat/callback`;

    // Dispatch to agent (fire-and-forget)
    const { dispatchChatWork } = await import('../services/chat-dispatch');
    void dispatchChatWork({
      agentId: wf.agent_slug,
      workToken: wf.work_token,
      threadId,
      messageId: msgRows[0].id,
      messages,
      model,
      callbackUrl,
    }).catch((err: any) => {
      console.error(`[workflows] Dispatch failed for workflow ${wf.id}:`, err);
      // This query needs its own handler. Nothing awaits this chain, so a
      // rejection here has nowhere to go: Node 20 exits the process on an
      // unhandled rejection and this service registers no handler for one. The
      // database failing is exactly the case that coincides with a dispatch
      // failure, so the recording of an outage must not be able to cause a worse
      // one. Losing the row update is bad; losing the API container is worse.
      pool.query(
        `UPDATE workflow_runs SET status = 'error', error = $1, completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000
         WHERE id = $2`,
        [err.message || 'Dispatch failed', run.id]
      ).catch((updateErr: any) => {
        console.error(`[workflows] Failed to record dispatch failure for run ${run.id}:`, updateErr);
      });
    });

    // Update workflow last_run_at
    await pool.query(
      `UPDATE workflows SET last_run_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [wf.id]
    );

    res.json({ ...run, thread_id: threadId, status: 'running' });
  } catch (err: any) {
    console.error('[workflows] Run error:', err);

    /*
     * Label the run before answering. Without this the caller was told 500 while
     * a row sat at 'running' permanently — a failure the system could not
     * afterwards distinguish from a run still in progress.
     *
     * Best-effort and separately guarded, for the same reason the dispatch
     * .catch above is: the database failing is precisely the case that produces
     * this catch, so recording the failure must not be able to throw out of it
     * and turn a 500 into an unhandled rejection.
     */
    if (runId) {
      try {
        await getPool().query(
          `UPDATE workflow_runs SET status = 'error', error = $1, completed_at = NOW(),
           duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000
           WHERE id = $2 AND status = 'running'`,
          [err?.message || 'Run setup failed', runId]
        );
      } catch (markErr) {
        console.error(`[workflows] Failed to mark run ${runId} as error:`, markErr);
      }
    }

    res.status(500).json({ error: 'Failed to run workflow' });
  }
});

// ── Run history ─────────────────────────────────────────────────────
router.get('/:id/runs', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    // Verify access
    const { rows: wfRows } = await getPool().query(
      `SELECT id FROM workflows WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );
    if (wfRows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const { rows } = await getPool().query(
      `SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [req.params.id]
    );

    res.json(rows);
  } catch (err: any) {
    console.error('[workflows] Runs error:', err);
    res.status(500).json({ error: 'Failed to get run history' });
  }
});

// ── Workflow steps (multi-agent chaining) ───────────────────────────
router.get('/:id/steps', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows: wfRows } = await getPool().query(
      `SELECT id FROM workflows WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );
    if (wfRows.length === 0) { res.status(404).json({ error: 'Workflow not found' }); return; }

    const { rows } = await getPool().query(
      `SELECT ws.*, a.name AS agent_name, a.agent_id AS agent_slug, a.status AS agent_status
       FROM workflow_steps ws
       JOIN agents a ON ws.agent_id = a.id
       WHERE ws.workflow_id = $1 ORDER BY ws.step_order`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err: any) {
    console.error('[workflows] Steps list error:', err);
    res.status(500).json({ error: 'Failed to list steps' });
  }
});

router.post('/:id/steps', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { agent_id, prompt, step_order } = req.body;

    if (!agent_id || !prompt) { res.status(400).json({ error: 'agent_id and prompt required' }); return; }

    const { rows: wfRows } = await getPool().query(
      `SELECT id FROM workflows WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );
    if (wfRows.length === 0) { res.status(404).json({ error: 'Workflow not found' }); return; }

    // Auto-assign step_order if not provided
    const order = step_order ?? (await getPool().query(
      `SELECT COALESCE(MAX(step_order), -1) + 1 AS next FROM workflow_steps WHERE workflow_id = $1`,
      [req.params.id]
    )).rows[0].next;

    const { rows } = await getPool().query(
      `INSERT INTO workflow_steps (workflow_id, agent_id, prompt, step_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, agent_id, prompt, order]
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    console.error('[workflows] Step create error:', err);
    res.status(500).json({ error: 'Failed to create step' });
  }
});

router.delete('/:id/steps/:stepId', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows: wfRows } = await getPool().query(
      `SELECT id FROM workflows WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );
    if (wfRows.length === 0) { res.status(404).json({ error: 'Workflow not found' }); return; }

    const { rowCount } = await getPool().query(
      `DELETE FROM workflow_steps WHERE id = $1 AND workflow_id = $2`,
      [req.params.stepId, req.params.id]
    );
    if (rowCount === 0) { res.status(404).json({ error: 'Step not found' }); return; }
    res.json({ deleted: true });
  } catch (err: any) {
    console.error('[workflows] Step delete error:', err);
    res.status(500).json({ error: 'Failed to delete step' });
  }
});

export default router;
