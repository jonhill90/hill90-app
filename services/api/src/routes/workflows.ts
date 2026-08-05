/**
 * Workflow CRUD and execution routes.
 *
 *   GET    /workflows              — list workflows
 *   POST   /workflows              — create workflow
 *   GET    /workflows/:id          — get workflow
 *   PUT    /workflows/:id          — update workflow
 *   DELETE /workflows/:id          — delete workflow
 *   POST   /workflows/:id/run      — manually trigger a workflow
 *   GET    /workflows/:id/runs     — get run history
 *   POST   /workflows/webhook/:token — inbound webhook trigger (public, no auth)
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin } from '../helpers/elevated-scope';
import { reportedStatus, isStatusVerified } from '../services/agent-status-verification';

const router = Router();

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

    if (!name || !agent_id || !schedule_cron || !prompt) {
      res.status(400).json({ error: 'name, agent_id, schedule_cron, and prompt are required' });
      return;
    }

    // Validate cron expression (basic check)
    const cronParts = schedule_cron.trim().split(/\s+/);
    if (cronParts.length < 5 || cronParts.length > 6) {
      res.status(400).json({ error: 'Invalid cron expression — must have 5 or 6 fields' });
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

    const { rows } = await getPool().query(
      `INSERT INTO workflows (name, description, agent_id, schedule_cron, prompt, output_type, output_config, enabled, created_by, trigger_type, webhook_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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

    if (schedule_cron) {
      const cronParts = schedule_cron.trim().split(/\s+/);
      if (cronParts.length < 5 || cronParts.length > 6) {
        res.status(400).json({ error: 'Invalid cron expression' });
        return;
      }
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
        updated_at = NOW()
       WHERE id = $9 ${admin ? '' : 'AND created_by = $10'}
       RETURNING ${PUBLIC_COLUMNS}`,
      admin
        ? [name, description, agent_id, schedule_cron, prompt, output_type, output_config ? JSON.stringify(output_config) : null, enabled, req.params.id]
        : [name, description, agent_id, schedule_cron, prompt, output_type, output_config ? JSON.stringify(output_config) : null, enabled, req.params.id, user.sub]
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

    // Update run with thread reference
    await pool.query(
      `UPDATE workflow_runs SET thread_id = $1 WHERE id = $2`,
      [threadId, run.id]
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

// ── Inbound webhook trigger (PUBLIC — no auth, uses token) ──────────
router.post('/webhook/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    // Looked up by digest, never by the plaintext value — same reasoning as
    // migration 068: constant-time-in-spirit via a direct equality on a
    // SHA-256 hash, never a plaintext comparison.
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const { rows: wfRows } = await getPool().query(
      `SELECT w.*, a.agent_id AS agent_slug, a.status AS agent_status, a.work_token,
              mp.allowed_models
       FROM workflows w
       JOIN agents a ON w.agent_id = a.id
       LEFT JOIN model_policies mp ON a.model_policy_id = mp.id
       WHERE w.webhook_token_hash = $1 AND w.enabled = true`,
      [tokenHash]
    );

    if (wfRows.length === 0) {
      res.status(404).json({ error: 'Webhook not found or workflow disabled' });
      return;
    }

    const wf = wfRows[0];

    if (wf.agent_status !== 'running') {
      res.status(409).json({ error: `Agent ${wf.agent_slug} is not running` });
      return;
    }

    // Merge webhook payload into prompt if provided
    const webhookData = req.body || {};
    let prompt = wf.prompt;
    if (Object.keys(webhookData).length > 0) {
      prompt += `\n\nWebhook payload:\n\`\`\`json\n${JSON.stringify(webhookData, null, 2)}\n\`\`\``;
    }

    // Create run
    const pool = getPool();
    const { rows: runRows } = await pool.query(
      `INSERT INTO workflow_runs (workflow_id, status) VALUES ($1, 'running') RETURNING id`,
      [wf.id]
    );

    // Create thread
    const { rows: threadRows } = await pool.query(
      `INSERT INTO chat_threads (title, created_by) VALUES ($1, $2) RETURNING id`,
      [`Webhook: ${wf.name}`, 'webhook']
    );
    const threadId = threadRows[0].id;

    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type) VALUES ($1, $2, 'agent')`,
      [threadId, wf.agent_id]
    );
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type) VALUES ($1, $2, 'human')`,
      [threadId, wf.created_by]
    );

    const { rows: msgRows } = await pool.query(
      // #292: was `sender_id, sender_type`, columns chat_messages does not have
      // — the table uses author_id/author_type. Both workflow write paths would
      // have failed on every run. Found by check_sql_identifiers.sh, never by a
      // test, because the pool is mocked and a mocked query reaches no parser.
      `INSERT INTO chat_messages (thread_id, author_id, author_type, content, status)
       VALUES ($1, $2, 'human', $3, 'delivered') RETURNING id`,
      [threadId, wf.created_by, prompt]
    );

    const model = wf.allowed_models?.[0] || 'default';
    const { dispatchChatWork } = await import('../services/chat-dispatch');
    void dispatchChatWork({
      agentId: wf.agent_slug,
      workToken: wf.work_token,
      threadId,
      messageId: msgRows[0].id,
      messages: [{ role: 'user', content: prompt }],
      model,
      callbackUrl: 'http://api:3000/internal/chat/callback',
    }).catch((err: any) => {
      console.error(`[workflows] Webhook dispatch failed for workflow ${wf.id}:`, err);
      // Own handler, for the same reason as the `/:id/run` site above: nothing
      // awaits this chain, so an unhandled rejection here would take the process
      // down on Node 20.
      pool.query(
        `UPDATE workflow_runs SET status = 'error', error = $1, completed_at = NOW() WHERE id = $2`,
        [err.message, runRows[0].id]
      ).catch((updateErr: any) => {
        console.error(`[workflows] Failed to record dispatch failure for run ${runRows[0].id}:`, updateErr);
      });
    });

    await pool.query(`UPDATE workflow_runs SET thread_id = $1 WHERE id = $2`, [threadId, runRows[0].id]);
    await pool.query(`UPDATE workflows SET last_run_at = NOW(), updated_at = NOW() WHERE id = $1`, [wf.id]);

    res.json({ triggered: true, workflow: wf.name, run_id: runRows[0].id, thread_id: threadId });
  } catch (err: any) {
    console.error('[workflows] Webhook error:', err);
    res.status(500).json({ error: 'Webhook trigger failed' });
  }
});

export default router;
