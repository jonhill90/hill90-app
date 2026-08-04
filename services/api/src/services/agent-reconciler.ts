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
 * The `model_router_exp` each agent was last escalated for.
 *
 * Once per expiry, not once per pass: a refresh that succeeds writes a NEW
 * `model_router_exp`, so the next expiry is a different value and escalates
 * again, while sixty passes over the same stranded token stay quiet.
 *
 * In memory, like `agent-status-verification.ts`, and with the same honest
 * limit: an API restart forgets, so a still-stranded agent is escalated once
 * more after a restart. That is a duplicate notification at most, and the
 * alternative — a column and a migration — is more machinery than the signal
 * is worth. Asserted in `unrenewed-token-escalation.test.ts`.
 */
const escalatedTokenExpiry = new Map<string, number>();

/** Test seam only: module state is process-global by design. */
export function resetTokenExpiryEscalation(): void {
  escalatedTokenExpiry.clear();
}

/**
 * An agent still recorded as running whose model-router token nobody renewed.
 *
 * #255: a failed refresh leaves no API-side trace, but it does leave a
 * signature — `model_router_exp` stops moving while the row stays `running`.
 * That signature had no reader. It gets one here rather than in a watcher of
 * its own: this pass already runs every 60s over every agent row and already
 * knows how to escalate exactly once per transition, so a second watcher would
 * be a second definition of the same thing.
 *
 * NOT the same event as a vanished container, and deliberately a separate
 * message: the container is fine, the credential is not.
 */
function escalateUnrenewedTokens(
  rows: Array<{ id: string; agent_id: string; status: string; created_by: string; model_router_exp: number | null }>,
  skip: (agentUuid: string, agentSlug: string) => boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    if (row.status !== 'running') continue;
    if (row.model_router_exp === null || row.model_router_exp > now) continue;
    if (skip(row.id, row.agent_id)) continue;
    if (escalatedTokenExpiry.get(row.id) === row.model_router_exp) continue;

    escalatedTokenExpiry.set(row.id, row.model_router_exp);
    console.warn(
      `[reconcile] Agent ${row.agent_id} is running on a model-router token that expired at ` +
      `${new Date(row.model_router_exp * 1000).toISOString()} and was never renewed`
    );
    notify(
      row.created_by,
      `Agent "${row.agent_id}" is running but its model-router token expired and was not renewed — its model calls will fail until it is restarted.`,
      'agent_error',
      { agent_id: row.id, agent_slug: row.agent_id, model_router_exp: row.model_router_exp },
    );
  }
}

/**
 * One pass. Never throws: a failure is a result ("nothing is verified"), not an
 * exception for a caller to swallow.
 */
export async function runReconcilePass(): Promise<ReconcileResult | null> {
  // Captured from the SELECT below so the token-expiry check reads the same
  // rows this pass already fetched, rather than querying twice.
  let rows: any[] = [];
  const patched = new Set<string>();

  try {
    const result = await reconcileAgentStatuses(
      async () => {
        // EVERY agent, not only the rows marked `running` (#239). The set this
        // examined used to be the set it could correct, which is why a `stopped`
        // row with a live container had no code path that would ever look at it.
        // Unbounded by design: it is the whole table or it is not reconciliation,
        // and there is no caller-controlled multiplier here.
        const res = await getPool().query(
          'SELECT id, agent_id, status, container_id, container_state, created_by, model_router_exp FROM agents'
        );
        rows = res.rows;
        return rows;
      },
      async (patch) => {
        patched.add(patch.id);
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

    // Only for agents this pass left alone and could verify. An agent it just
    // demoted has a louder problem, and one it could not inspect is the case
    // #250 exists to refuse to make claims about.
    const unverified = new Set(result.unverified);
    escalateUnrenewedTokens(rows, (id, slug) => patched.has(id) || unverified.has(slug));
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
