/**
 * The single place a probe result becomes a health status.
 *
 * WHY THIS IS A MODULE AND NOT A CONVENTION. Rendering a permission error as an
 * infrastructure outage has now happened three times:
 *
 *   #138  storage 403 shown as "storage unhealthy" on /harness/monitoring
 *   #149  vault   403 shown as "vault unhealthy" on the same page
 *   ...and both were written by copying the panel next to them.
 *
 * #149 added `statusFromFailedProbe`, which was correct and insufficient: each
 * panel still hand-rolled `try { fetch; if (res.ok) … else … } catch {…}`, so
 * the helper was something a new panel had to REMEMBER to call. Three
 * near-identical blocks is a template, and the next one gets copied from
 * whichever neighbour is nearest. Making the right behaviour available did not
 * make it the default.
 *
 * So the probe and the mapping live together here. A panel supplies a name and
 * a URL and cannot express the wrong mapping, because it never sees the
 * Response.
 *
 * THE DISTINCTION BEING PRESERVED. These probes are ordinary authenticated
 * fetches made with the VIEWER'S session, so `401`/`403` mean "you may not look
 * at this", not "this is broken". A monitoring page that cannot see a component
 * has to say it cannot see it. A red dot meaning "not allowed" sends someone to
 * investigate an outage that is not happening, and teaches them that red on this
 * page means nothing — which is how a real outage gets ignored later.
 *
 * NOT IN SCOPE, deliberately: the SERVER-side probes in
 * app/api/services/health and app/api/admin/services/health. Those fetch
 * internal liveness endpoints with NO credentials at all, so a 401 from one of
 * them is a probe misconfiguration rather than a statement about any viewer.
 * Same status codes, different meaning; folding them in here would conflate two
 * things that only look alike.
 */

export interface HealthStatus {
  service: string
  /** `unknown` is a third answer: reachable, but not visible to this viewer. */
  status: 'healthy' | 'unhealthy' | 'unknown'
  error?: string
}

/**
 * Map a non-OK response to a status.
 *
 * 401 and 403 are the ONLY codes treated as "cannot see". Everything else —
 * 500, 502, 404 — stays `unhealthy`, because a service answering 500 is broken
 * no matter who is asking. That second half is what makes this a distinction
 * rather than a mute button.
 */
export function statusFromFailedProbe(service: string, code: number): HealthStatus {
  if (code === 401 || code === 403) {
    return { service, status: 'unknown', error: 'Not visible to your account' }
  }
  return { service, status: 'unhealthy', error: `HTTP ${code}` }
}

/**
 * Probe one service and return its status. The only correct way for a panel on
 * the monitoring page to ask "is this up?".
 *
 * `onOk` exists for the one panel that needs the response body (the API panel
 * reads `service` out of it). It runs only on a 2xx, so it cannot be used to
 * reintroduce a hand-rolled failure mapping.
 */
export async function probeService(
  service: string,
  url: string,
  onOk?: (res: Response) => Promise<HealthStatus> | HealthStatus,
): Promise<HealthStatus> {
  try {
    const res = await fetch(url)
    if (!res.ok) return statusFromFailedProbe(service, res.status)
    return onOk ? await onOk(res) : { service, status: 'healthy' }
  } catch {
    // A thrown fetch is a genuine transport failure — no response, no status
    // code, nothing to interpret. That is unhealthy, and it is the one case
    // where there is no permission question to get wrong.
    return { service, status: 'unhealthy', error: 'Connection failed' }
  }
}
