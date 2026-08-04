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
 */

import { getPool } from '../db/pool';
import { reconcileAgentStatuses, ReconcileResult } from './docker';
import { recordReconcilePass, recordReconcileFailure, UNKNOWN_STATUS } from './agent-status-verification';

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
        const { rows } = await getPool().query(
          "SELECT id, agent_id FROM agents WHERE status = 'running'"
        );
        return rows;
      },
      async (id, status, containerId, error) => {
        await getPool().query(
          'UPDATE agents SET status = $1, container_id = $2, error_message = $3, updated_at = NOW() WHERE id = $4',
          [status, containerId, error, id]
        );
      }
    );
    recordReconcilePass(result.unverified);
    if (result.unverified.length > 0) {
      console.warn(
        `[reconcile] Pass complete: ${result.checked} checked, ${result.reconciled} corrected, ` +
        `${result.unverified.length} UNVERIFIED (reported as '${UNKNOWN_STATUS}'): ${result.unverified.join(', ')}`
      );
    } else {
      console.log(`[reconcile] Pass complete: ${result.checked} checked, ${result.reconciled} corrected`);
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
