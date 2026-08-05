/**
 * Workflow cron scheduler.
 *
 * Runs on a 60-second interval. Evaluates enabled workflows whose
 * next_run_at has passed, dispatches them via the chat infrastructure,
 * and computes the next run time.
 *
 * Uses pg advisory lock to prevent duplicate execution across API instances.
 */

import { getPool } from '../db/pool';
import { CronExpressionParser } from 'cron-parser';
import { dispatchChatWork } from './chat-dispatch';

const CHECK_INTERVAL_MS = 60_000;
const ADVISORY_LOCK_ID = 900_001; // arbitrary unique ID for workflow scheduler

let running = false;

/**
 * Start the workflow scheduler loop.
 * Called once from app startup. Runs forever in background.
 */
export function startWorkflowScheduler(): void {
  console.log('[workflow-scheduler] Starting (interval=%dms)', CHECK_INTERVAL_MS);

  // Compute next_run_at for any workflows that don't have one
  // SAFE ONLY BECAUSE OF THE CALLEE. `void` attaches no rejection handler, so this
  // line's safety is entirely `initializeNextRuns`'s: its body is one try/catch that
  // logs and returns. Remove or narrow that try and this becomes #133 exactly — an
  // unhandled rejection, and Node 20 exits the process on one because this service
  // registers no handler (boot/fatal.ts installs a backstop that logs it, nothing more).
  void initializeNextRuns();

  setInterval(() => {
    if (running) return; // Skip if previous tick still processing
    // Same dependency as initializeNextRuns above: `tick`'s whole body is a
    // try/catch that logs. This line adds no protection of its own.
    void tick();
  }, CHECK_INTERVAL_MS);
}

async function initializeNextRuns(): Promise<void> {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, schedule_cron FROM workflows WHERE enabled = true AND next_run_at IS NULL`
    );

    for (const row of rows) {
      const next = computeNextRun(row.schedule_cron);
      if (next) {
        await pool.query(
          `UPDATE workflows SET next_run_at = $1 WHERE id = $2`,
          [next, row.id]
        );
      }
    }

    if (rows.length > 0) {
      console.log('[workflow-scheduler] Initialized next_run_at for %d workflows', rows.length);
    }
  } catch (err) {
    console.error('[workflow-scheduler] Init error:', err);
  }
}

async function tick(): Promise<void> {
  running = true;
  try {
    const pool = getPool();

    // Acquire advisory lock — only one API instance processes at a time
    const { rows: lockRows } = await pool.query(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [ADVISORY_LOCK_ID]
    );
    if (!lockRows[0]?.acquired) {
      return; // Another instance has the lock
    }

    try {
      // Find due workflows
      const { rows: dueWorkflows } = await pool.query(
        `SELECT w.id, w.name, w.agent_id, w.schedule_cron, w.prompt, w.output_type, w.output_config, w.created_by,
                a.agent_id AS agent_slug, a.status AS agent_status, a.work_token,
                mp.allowed_models
         FROM workflows w
         JOIN agents a ON w.agent_id = a.id
         LEFT JOIN model_policies mp ON a.model_policy_id = mp.id
         WHERE w.enabled = true AND w.next_run_at <= NOW()`
      );

      for (const wf of dueWorkflows) {
        await executeWorkflow(pool, wf);
      }
    } finally {
      // Release advisory lock
      await pool.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
    }
  } catch (err) {
    console.error('[workflow-scheduler] Tick error:', err);
  } finally {
    running = false;
  }
}

// Exported so a test can call it. The reason this path shipped with a column
// that does not exist is that nothing ever called it — the scheduler's unit of
// work was reachable only through a timer, so no test could name it (#292).
export async function executeWorkflow(pool: any, wf: any): Promise<void> {
  const workflowId = wf.id;

  // Skip if agent not running
  if (wf.agent_status !== 'running') {
    console.warn('[workflow-scheduler] Skipping %s — agent %s is %s', wf.name, wf.agent_slug, wf.agent_status);
    // Still update next_run_at so we don't re-check every tick
    const next = computeNextRun(wf.schedule_cron);
    if (next) {
      await pool.query(`UPDATE workflows SET next_run_at = $1, updated_at = NOW() WHERE id = $2`, [next, workflowId]);
    }
    return;
  }

  console.log('[workflow-scheduler] Executing workflow "%s" (agent: %s)', wf.name, wf.agent_slug);

  // Create run record
  const { rows: runRows } = await pool.query(
    `INSERT INTO workflow_runs (workflow_id, status) VALUES ($1, 'running') RETURNING id`,
    [workflowId]
  );
  const runId = runRows[0].id;

  try {
    // Create chat thread
    const { rows: threadRows } = await pool.query(
      `INSERT INTO chat_threads (title, created_by) VALUES ($1, $2) RETURNING id`,
      [`Workflow: ${wf.name}`, 'system']
    );
    const threadId = threadRows[0].id;

    // Add agent as participant
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type) VALUES ($1, $2, 'agent')`,
      [threadId, wf.agent_id]
    );

    // Add creator as participant
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type) VALUES ($1, $2, 'human')`,
      [threadId, wf.created_by]
    );

    // Insert message
    const { rows: msgRows } = await pool.query(
      // The twin of routes/workflows.ts:309 and :568, and it was missed when
      // those were fixed (#292/#301): the columns are author_id/author_type.
      // A scheduled run therefore failed on this statement every time, and the
      // gate that would have caught it scanned routes/ only — the hole and the
      // defect were the same oversight, one in the code and one in the check.
      `INSERT INTO chat_messages (thread_id, author_id, author_type, content, status)
       VALUES ($1, $2, 'human', $3, 'delivered') RETURNING id`,
      [threadId, wf.created_by, wf.prompt]
    );

    const model = wf.allowed_models?.[0] || 'default';
    const callbackUrl = 'http://api:3000/internal/chat/callback';

    // Dispatch to agent
    const result = await dispatchChatWork({
      agentId: wf.agent_slug,
      workToken: wf.work_token,
      threadId,
      messageId: msgRows[0].id,
      messages: [{ role: 'user', content: wf.prompt }],
      model,
      callbackUrl,
    });

    // Update run with thread
    await pool.query(
      `UPDATE workflow_runs SET thread_id = $1 WHERE id = $2`,
      [threadId, runId]
    );

    if (!result.accepted) {
      throw new Error(result.error || 'Agent rejected work');
    }

    console.log('[workflow-scheduler] Dispatched "%s" → thread %s', wf.name, threadId);
  } catch (err: any) {
    console.error('[workflow-scheduler] Workflow "%s" failed:', wf.name, err);
    // This write only runs because dispatch already failed — plausibly the
    // same class of DB blip it's about to retry against. Guarded rather than
    // left to propagate: an unguarded failure here used to skip the
    // next_run_at advance below entirely, leaving the workflow "due" again
    // on the very next tick — re-running the whole non-idempotent dispatch
    // (new thread, new participants, new message, new agent dispatch) for
    // as long as the blip lasted.
    try {
      await pool.query(
        `UPDATE workflow_runs SET status = 'error', error = $1, completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000
         WHERE id = $2`,
        [err.message || 'Unknown error', runId]
      );
    } catch (recordErr) {
      console.error(
        '[workflow-scheduler] Failed to record failure for "%s" (run %s):',
        wf.name, runId, recordErr
      );
    }
  }

  // Update last_run_at and compute next_run_at
  const next = computeNextRun(wf.schedule_cron);
  await pool.query(
    `UPDATE workflows SET last_run_at = NOW(), next_run_at = $1, updated_at = NOW() WHERE id = $2`,
    [next, workflowId]
  );
}

function computeNextRun(cronExpr: string): Date | null {
  try {
    const interval = CronExpressionParser.parse(cronExpr);
    return interval.next().toDate();
  } catch {
    return null;
  }
}
