/**
 * Inbound workflow webhook trigger — genuinely public, genuinely no auth.
 *
 * Split out of routes/workflows.ts (which is mounted behind requireAuth in
 * app.ts) because that mount silently made this route unreachable by any
 * external sender despite its own header there claiming "PUBLIC — no auth,
 * uses token": app.ts:216 was `app.use('/workflows', requireAuth,
 * workflowsRouter)`, and requireAuth demands a valid Keycloak Bearer JWT
 * before Express ever reaches a route inside that router. A webhook caller
 * (GitHub, a monitoring system, anything outside this platform) has no such
 * token and never will — the feature could not work at all, not "worked
 * without hardening."
 *
 * This router is mounted in app.ts BEFORE the authenticated workflows
 * mount, at the same '/workflows' prefix, with no requireAuth in front of
 * it. Order matters: Express falls through to the next matching `app.use`
 * when a router has no route for the request, so a request to any other
 * /workflows/* path passes through this router untouched and reaches the
 * authenticated one exactly as before. Only POST /webhook/:token is ever
 * handled here.
 *
 * WHY THE TOKEN ALONE IS ENOUGH AUTHENTICATION, checked rather than assumed
 * before making this route reachable — a route with no requireAuth in
 * front of it means this token is the ONLY thing standing between the
 * internet and triggering a workflow run, so it had to be verified, not
 * inherited:
 *   - generated with crypto.randomBytes(32) in routes/workflows.ts — 256
 *     bits of CSPRNG output, not a user-chosen or short value.
 *   - the plaintext is shown exactly once, in the create response, and
 *     never stored — only its SHA-256 digest is (migration 068).
 *   - unsalted deliberately, not by oversight: migration 068's own comment
 *     reasons through why — a rainbow table only threatens a small or
 *     guessable input space, and 256 bits of CSPRNG output has none to
 *     precompute against.
 *   - looked up via `WHERE webhook_token_hash = $1` against a UNIQUE INDEX
 *     (migration 068), i.e. a single indexed equality check, not a
 *     hand-rolled loop comparison — there is no application-level
 *     byte-by-byte compare for a timing attack to measure.
 *   This is the same shape GitHub, Stripe, Slack and Discord use for
 *   inbound webhook authentication (a high-entropy bearer secret in the
 *   URL), and does not need a second factor to be real authentication.
 *   Nothing about moving this route outside requireAuth changes any of
 *   that reasoning — the token was always the actual authentication for
 *   this endpoint; requireAuth in front of it was never protecting
 *   anything the token didn't already cover, it was only preventing the
 *   route from being reachable by its intended caller.
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../db/pool';

const router = Router();

router.post('/webhook/:token', async (req: Request, res: Response) => {
  // Hoisted so the outer catch can mark the run it created — same fix and
  // same reasoning as routes/workflows.ts's POST /:id/run: without this, a
  // failure between the workflow_runs INSERT and the response left that
  // row at 'running' forever, indistinguishable from a run still in
  // progress except by age.
  let runId: string | null = null;
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
    runId = runRows[0].id;

    // Create thread
    const { rows: threadRows } = await pool.query(
      `INSERT INTO chat_threads (title, created_by) VALUES ($1, $2) RETURNING id`,
      [`Webhook: ${wf.name}`, 'webhook']
    );
    const threadId = threadRows[0].id;

    // app#542: set thread_id on the run as soon as it is known — see the
    // identical comment in routes/workflows.ts's POST /:id/run, this
    // route's authenticated twin. It used to be set last, after the
    // fire-and-forget dispatch and a trailing last_run_at update; if
    // either later statement threw, the run was correctly labelled
    // 'error' while thread_id stayed NULL forever, orphaning a real
    // thread and dispatch from the run record meant to find them.
    await pool.query(
      `UPDATE workflow_runs SET thread_id = $1 WHERE id = $2`,
      [threadId, runRows[0].id]
    );

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
      // Own handler, for the same reason as the `/:id/run` site: nothing
      // awaits this chain, so an unhandled rejection here would take the
      // process down on Node 20.
      // Twin of routes/workflows.ts's identical dispatch-failure .catch(),
      // which already falls back to a fixed string — err.message is
      // undefined on a non-Error rejection, and pool.query binds that as
      // NULL, recording "failed, no reason given" for a run that likely had
      // a real cause.
      pool.query(
        `UPDATE workflow_runs SET status = 'error', error = $1, completed_at = NOW() WHERE id = $2`,
        [err.message || 'Dispatch failed', runRows[0].id]
      ).catch((updateErr: any) => {
        console.error(`[workflows] Failed to record dispatch failure for run ${runRows[0].id}:`, updateErr);
      });
    });

    await pool.query(`UPDATE workflows SET last_run_at = NOW(), updated_at = NOW() WHERE id = $1`, [wf.id]);

    res.json({ triggered: true, workflow: wf.name, run_id: runRows[0].id, thread_id: threadId });
  } catch (err: any) {
    console.error('[workflows] Webhook error:', err);

    // Best-effort and separately guarded, same reasoning as POST /:id/run's
    // catch: the database failing is precisely the case that produces this
    // catch, so recording the failure must not be able to throw out of it.
    // `AND status = 'running'` avoids clobbering a run the dispatch .catch
    // above already marked.
    if (runId) {
      try {
        await getPool().query(
          `UPDATE workflow_runs SET status = 'error', error = $1, completed_at = NOW(),
           duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000
           WHERE id = $2 AND status = 'running'`,
          [err?.message || 'Webhook trigger failed', runId]
        );
      } catch (markErr) {
        console.error(`[workflows] Failed to mark run ${runId} as error:`, markErr);
      }
    }

    res.status(500).json({ error: 'Webhook trigger failed' });
  }
});

export default router;
