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
import { dispatchChatWork } from './chat-dispatch';
import { computeNextRun } from '../helpers/cron';

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
      let next: Date | null;
      try {
        next = computeNextRun(row.schedule_cron);
      } catch (err) {
        console.error('[workflow-scheduler] Invalid cron for workflow %s:', row.id, err);
        await recordCronFailure(pool, row.id, row.schedule_cron, err);
        continue;
      }
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

// Exported so a test can call it — same rationale as executeWorkflow below:
// the scheduler's unit of batch behavior was reachable only through a
// 60-second timer, so app#469's per-item isolation had no way to be tested
// against the actual loop until this was named.
export async function tick(): Promise<void> {
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

      // app#469. executeWorkflow can still throw from writes that sit
      // outside its own internal try/catch — the initial workflow_runs
      // insert, the agent-not-running skip's next_run_at update, and the
      // final next_run_at advance after a normal run. Almost always a DB
      // blip, not a defect in this workflow's own config or cron (every
      // computeNextRun call site already has its own local try/catch that
      // routes into recordCronFailure, so an invalid stored cron cannot
      // reach here — checked, not assumed). Before this, ANY such throw
      // aborted this entire loop: with dueWorkflows.length possibly 10,
      // one workflow's bad luck this tick silently cost every workflow
      // queued behind it, and the due-workflows query above has no ORDER
      // BY, so which workflows got skipped was not even consistent from
      // one tick to the next — this could read as sporadic flakiness
      // across many workflows rather than one broken one. Contained here
      // per item, and recorded against the workflow that actually failed,
      // so a human looking at ITS history sees why — not swallowed, and
      // not blamed on its neighbours.
      for (const wf of dueWorkflows) {
        try {
          await executeWorkflow(pool, wf);
        } catch (err) {
          console.error(
            '[workflow-scheduler] executeWorkflow threw for workflow "%s" (%s) — containing so the rest of this batch still runs:',
            wf.name, wf.id, err
          );
          await recordUnexpectedFailure(pool, wf.id, err);
        }
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
    let next: Date | null = null;
    try {
      next = computeNextRun(wf.schedule_cron);
    } catch (err) {
      console.error('[workflow-scheduler] Invalid cron for workflow %s:', workflowId, err);
      await recordCronFailure(pool, workflowId, wf.schedule_cron, err);
    }
    // Unconditional, not `if (next)`: on a cron failure `next` is null, and
    // this row was only reachable here because it was already due
    // (next_run_at <= NOW()). Leaving next_run_at at that past value would
    // make it due again on every tick forever — this same skip branch,
    // and a fresh failure row, every 60 seconds.
    await pool.query(`UPDATE workflows SET next_run_at = $1, updated_at = NOW() WHERE id = $2`, [next, workflowId]);
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
  let next: Date | null = null;
  try {
    next = computeNextRun(wf.schedule_cron);
  } catch (err) {
    console.error('[workflow-scheduler] Invalid cron for workflow %s after run %s:', workflowId, runId, err);
    await recordCronFailure(pool, workflowId, wf.schedule_cron, err);
  }
  await pool.query(
    `UPDATE workflows SET last_run_at = NOW(), next_run_at = $1, updated_at = NOW() WHERE id = $2`,
    [next, workflowId]
  );
}

// computeNextRun moved to helpers/cron.ts (app#488), so routes/workflows.ts's
// create path can compute the same next_run_at the scheduler would, instead
// of relying on the scheduler's one-time startup sweep to ever set it. Its
// three callers above are each still responsible for deciding what "the cron
// I was given can't be parsed" means for their own moment (skip a tick, abort
// initialization for this row, or note it after a run) — that throwing
// behavior (app#487) is unchanged by the move, only its location is.

// Makes an unparseable cron visible the same way a dispatch failure
// already is: a workflow_runs row with status='error' and a reason, so a
// human looking at the workflow's history sees why it stopped running
// instead of a workflow that just quietly never fires again.
async function recordCronFailure(pool: any, workflowId: string, cronExpr: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await pool.query(
      `INSERT INTO workflow_runs (workflow_id, status, error, completed_at, duration_ms)
       VALUES ($1, 'error', $2, NOW(), 0)`,
      [workflowId, `Cannot schedule next run: cron expression "${cronExpr}" is invalid — ${message}`]
    );
  } catch (recordErr) {
    console.error('[workflow-scheduler] Failed to record cron failure for workflow %s:', workflowId, recordErr);
  }
}

// app#469. The per-item catch in tick()'s loop routes here — self-contained
// the same way recordCronFailure is, so a failure while recording THIS
// failure can never re-escape and undo the very isolation it exists to
// provide. Deliberately does NOT also try to advance next_run_at: the
// exception that got us here already means at least one write for this
// workflow failed moments ago, so another write attempted from inside a
// catch block is more likely to fail the same way than to succeed. Leaving
// next_run_at untouched means this workflow stays "due" and is retried on
// the next tick — the same self-healing behavior every other unguarded
// throw in this file already had by accident; this just makes it
// deliberate and contained instead of accidental and batch-wide.
async function recordUnexpectedFailure(pool: any, workflowId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await pool.query(
      `INSERT INTO workflow_runs (workflow_id, status, error, completed_at, duration_ms)
       VALUES ($1, 'error', $2, NOW(), 0)`,
      [workflowId, `Scheduler tick failed for this workflow: ${message}`]
    );
  } catch (recordErr) {
    console.error('[workflow-scheduler] Failed to record unexpected failure for workflow %s:', workflowId, recordErr);
  }
}
