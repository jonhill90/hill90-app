/**
 * Runs agent status reconciliation and records what it was able to verify.
 *
 * Two things this owns that the old inline startup block did not (#238):
 *
 *  - a failure is recorded, not just logged. `recordReconcileFailure()` makes
 *    every `running` row report `unknown` until a pass succeeds, so the API
 *    stops asserting statuses it has not checked.
 *  - it runs on a schedule, not once. A transient docker-proxy fault used to
 *    persist until the next restart, because there was exactly one call site
 *    and no timer.
 *
 * And one it owns since #239: the pass reads EVERY agent row rather than only
 * the ones marked `running`, because the set it examines is the set it can
 * correct.
 */

import { getPool } from '../db/pool';
import { reconcileAgentStatuses, ReconcileResult, CONTAINER_ABSENT } from './docker';
import { recordReconcilePass, recordReconcileFailure, UNKNOWN_STATUS } from './agent-status-verification';
import { notify } from './notifications';

const DEFAULT_INTERVAL_MS = 60_000;

let reconcileInterval: NodeJS.Timeout | null = null;

/**
 * One pass. Never throws: a failure is a result ("nothing is verified"), not an
 * exception for a caller to swallow.
 */
export async function runReconcilePass(): Promise<ReconcileResult | null> {
  try {
    const result = await reconcileAgentStatuses(
      async () => {
        // EVERY agent, not only the rows marked `running` (#239). The set this
        // examined used to be the set it could correct, which is why a `stopped`
        // row with a live container had no code path that would ever look at it.
        // Unbounded by design: it is the whole table or it is not reconciliation,
        // and there is no caller-controlled multiplier here.
        const { rows } = await getPool().query(
          'SELECT id, agent_id, status, container_id, container_state, created_by FROM agents'
        );
        return rows;
      },
      async (patch) => {
        const sets = ['status = $1', 'container_state = $2'];
        const params: unknown[] = [patch.status, patch.containerState];
        if (patch.containerId !== undefined) {
          params.push(patch.containerId);
          sets.push(`container_id = $${params.length}`);
        }
        if (patch.errorMessage !== undefined) {
          params.push(patch.errorMessage);
          sets.push(`error_message = $${params.length}`);
        }
        params.push(patch.id);
        await getPool().query(
          `UPDATE agents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
          params
        );

        if (patch.status === patch.previousStatus) return;
        // A promotion is the surprising event of the two, and until now no
        // record of it could exist. Best effort, like every other writer of
        // this table.
        try {
          await getPool().query(
            'INSERT INTO agent_status_history (agent_id, old_status, new_status, changed_by) VALUES ($1, $2, $3, $4)',
            [patch.id, patch.previousStatus, patch.status, 'reconciler']
          );
        } catch (err) {
          console.error(`[reconcile] Status history insert failed for ${patch.agentId}:`, err);
        }

        // An `exited` container is an agent that stopped. An `absent` one is a
        // container that someone or something DELETED out from under the API,
        // and only the second is a case a human should hear about. That is the
        // distinction, and it is why this is worth surfacing rather than merely
        // storing: #239 kept the difference in `container_state` instead of
        // flattening both into `stopped`, and a distinction that is computed
        // and then read by nobody is the same waste one layer up.
        //
        // Fires once per transition — the early return above means this line is
        // only reached when the status actually changed, and the next pass finds
        // the row agreeing and writes nothing. Asserted, not argued:
        // `vanished-container-escalation.test.ts` runs the second pass.
        if (patch.status === 'stopped' && patch.containerState === CONTAINER_ABSENT) {
          notify(
            patch.createdBy,
            `Agent "${patch.agentId}" is no longer running: its container was deleted, not stopped.`,
            'agent_error',
            { agent_id: patch.id, agent_slug: patch.agentId, container_state: CONTAINER_ABSENT },
          );
        }
      }
    );
    recordReconcilePass(result.unverified);
    const counts =
      `${result.checked} checked, ${result.promoted} promoted, ${result.demoted} demoted`;
    if (result.unverified.length > 0) {
      console.warn(
        `[reconcile] Pass complete: ${counts}, ` +
        `${result.unverified.length} UNVERIFIED (reported as '${UNKNOWN_STATUS}'): ${result.unverified.join(', ')}`
      );
    } else {
      console.log(`[reconcile] Pass complete: ${counts}`);
    }
    return result;
  } catch (err) {
    // The pass itself failed, so we do not know which agents it would have
    // covered. Every running row is now unverified — which is what the API
    // will report, instead of the last value the database happens to hold.
    recordReconcileFailure();
    console.error('[reconcile] Pass FAILED; all running agents now report as unknown:', err);
    return null;
  }
}

export function startAgentReconciler(intervalMs?: number): void {
  if (reconcileInterval) return;
  const fromEnv = parseInt(process.env.AGENT_RECONCILE_INTERVAL_MS || '', 10);
  const period = intervalMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_INTERVAL_MS);
  reconcileInterval = setInterval(() => {
    // runReconcilePass() handles its own failures; the catch is here so a future
    // edit that lets one escape cannot become a silent unhandled rejection.
    runReconcilePass().catch((err) => console.error('[reconcile] Scheduled pass threw:', err));
  }, period);
}

export function stopAgentReconciler(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
  }
}
