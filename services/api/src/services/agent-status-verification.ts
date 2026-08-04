/**
 * Whether the API is entitled to report an agent's recorded status as fact.
 *
 * Reconciliation is the only thing that checks a `running` row against a real
 * container. Before #238 it ran once, at startup, and a non-404 failure was
 * logged and swallowed: the process carried on serving, and every `running` row
 * went to the UI as though it had been verified. A reconciliation that never
 * happened was indistinguishable from one that ran and found everything in
 * order, because there were only two statuses to report and neither of them
 * means "I could not tell".
 *
 * So there is a third state, exactly as `scripts/checks/check_deploy_drift.sh`
 * distinguishes ACTIONABLE DRIFT (1) from CANNOT DETERMINE (2): an answer, and
 * an absence of evidence, are not the same result and must not be collapsed.
 *
 * Scope, deliberately: only a `running` row can be reported unknown. That is
 * the only claim the reconciler backs — it selects rows already marked
 * `running` and the only write it can make is to `stopped`. A `stopped` row is
 * unverified by construction rather than by failure, which is #239, a different
 * defect, and is not addressed here.
 */

export const UNKNOWN_STATUS = 'unknown';

/** The status the reconciler examines, and therefore the only one it vouches for. */
const VERIFIABLE_STATUS = 'running';

/**
 * Verified unless we know otherwise. The process does not serve before the
 * first reconciliation pass has *completed* — `index.ts` awaits it before
 * `app.listen` — so "has not run yet" cannot be observed by a client. What can
 * be observed is a pass that ran and failed, and that is what the two
 * `record*` calls below encode.
 */
let defaultVerified = true;

/** Per-agent overrides on top of `defaultVerified`. */
const explicit = new Map<string, boolean>();

/**
 * A pass completed. `unverifiedAgentIds` are the agents whose container could
 * not be inspected — their recorded status was left untouched and is now a
 * claim nothing stands behind.
 */
export function recordReconcilePass(unverifiedAgentIds: string[]): void {
  defaultVerified = true;
  explicit.clear();
  for (const agentId of unverifiedAgentIds) explicit.set(agentId, false);
}

/**
 * The pass itself failed, so we do not even know which agents it would have
 * checked. Nothing is verified — including agents the previous pass cleared,
 * because that clearance has since expired.
 */
export function recordReconcileFailure(): void {
  defaultVerified = false;
  explicit.clear();
}

/**
 * The API just performed the container operation itself, so it has first-hand
 * evidence for this agent regardless of what reconciliation last managed.
 */
export function markStatusVerified(agentId: string): void {
  explicit.set(agentId, true);
}

export function isStatusVerified(agentId: string): boolean {
  const override = explicit.get(agentId);
  return override === undefined ? defaultVerified : override;
}

/**
 * What the API is entitled to say about this agent. Returns `unknown` in place
 * of a `running` row that nothing has checked — never the last value the
 * database happens to hold.
 */
export function reportedStatus(agentId: string, recordedStatus: string): string {
  if (recordedStatus !== VERIFIABLE_STATUS) return recordedStatus;
  return isStatusVerified(agentId) ? recordedStatus : UNKNOWN_STATUS;
}

/** Test seam only: module state is process-global by design. */
export function resetStatusVerification(): void {
  defaultVerified = true;
  explicit.clear();
}
