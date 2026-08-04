/**
 * How the UI renders an agent status, including the one the API could not verify.
 *
 * #250 gave the API a third state: a `running` row that reconciliation could
 * not check against a real container is reported as `unknown`, with
 * `status_verified: false` alongside it. Five chat surfaces then tested
 * `status === 'running'` and rendered everything else as *stopped* (#251) —
 * so the boundary told the truth and the screen rounded it back into a false
 * claim.
 *
 * The regression is about confidence, not accuracy. Before #250 the UI showed
 * a stale `running` that was usually right; after it, for exactly the agents
 * the API has flagged as unverifiable, it rendered a definite **Stopped** for
 * an agent that may well be running. A stale value is a soft claim. A rendered
 * *Stopped* is a hard one, and it is wrong in the confident direction.
 *
 * So every surface classifies through here rather than open-coding
 * `=== 'running'`. The bound belongs in one place: #141 and #153 both existed
 * because a fix landed on one call site and not its twin.
 */

/** The status the API reports when it could not verify a `running` row. */
export const UNKNOWN_STATUS = 'unknown'

/**
 * Three renderings, not two branches of a boolean.
 *
 * - `running`  — verified running.
 * - `unknown`  — the API could not tell. Must look unlike both of the others.
 * - `inactive` — everything else: stopped, error, creating. These already had
 *   a shared rendering and keep it; this helper is not trying to split them.
 */
export type StatusTone = 'running' | 'unknown' | 'inactive'

export function statusTone(status: string | null | undefined): StatusTone {
  if (status === 'running') return 'running'
  if (status === UNKNOWN_STATUS) return 'unknown'
  return 'inactive'
}

export function isUnknownStatus(status: string | null | undefined): boolean {
  return statusTone(status) === 'unknown'
}

/**
 * Whether the UI may act as though the agent is available.
 *
 * Deliberately true for `unknown`. Refusing to let someone type because the
 * API could not reach docker-proxy would turn a reporting gap into an outage,
 * which is the same mistake in the opposite direction — and the API's own
 * dispatch gate still reads the recorded row, so a genuinely stopped agent is
 * refused there with an error the user can see and act on. An invisible,
 * unexplained disabled composer is worse than a visible rejection.
 */
export function mayBeAvailable(status: string | null | undefined): boolean {
  return statusTone(status) !== 'inactive'
}

/** Dot colour for the small status indicators. Yellow pulse marks the third state. */
export function statusDotClass(status: string | null | undefined): string {
  switch (statusTone(status)) {
    case 'running':
      return 'bg-brand-400'
    case 'unknown':
      return 'bg-yellow-400 animate-pulse'
    default:
      return 'bg-mountain-500'
  }
}

/**
 * The word shown next to the dot, lower case.
 *
 * `unverified` rather than `unknown`: the agent's state is not unknowable, it
 * is unverified by us. That distinction is the whole point of #238.
 */
export function statusLabel(status: string | null | undefined): string {
  switch (statusTone(status)) {
    case 'running':
      return 'running'
    case 'unknown':
      return 'unverified'
    default:
      return 'stopped'
  }
}

/** Why an agent reads as unverified, for a `title` tooltip. */
export const UNVERIFIED_HINT =
  'The API could not check this agent against its container, so its status is unverified — it may still be running.'
