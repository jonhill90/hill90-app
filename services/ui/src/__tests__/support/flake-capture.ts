/**
 * Capture what a flake looked like, at the moment it failed — and say whether
 * the data was LATE or ABSENT, which is the question #117 has never been able
 * to answer.
 *
 * issue #117: `DashboardClient` fails in CI only and has never reproduced
 * locally in ~40 runs. Four CI failures have produced nothing but a message and
 * a DOM dump Testing Library truncates at 7000 characters, so each failure has
 * told us exactly what the previous one did.
 *
 * The right move on a CI-only flake is to WAIT for the next failure and READ it,
 * not to re-run until one happens — a re-run that passes establishes only that
 * it is flaky, which #117 already records. That makes the evidence at the moment
 * of failure the entire asset.
 *
 * WHY THIS IS NOT AN `onTestFailed` HOOK, measured rather than assumed. The first
 * version of this file re-read the DOM inside `onTestFailed` after a 500ms wait.
 * Its positive control failed: an arm where the data arrived late reported
 * `NEVER ARRIVED`, identically to an arm where it never came. `onTestFailed` runs
 * once teardown is under way, so `cleanup()` had already emptied the DOM it read.
 * A detector that reports the same verdict for both states is worse than none.
 *
 * So the check happens INSIDE the assertion, before anything is torn down and
 * before the failure propagates. The test still fails — that is deliberate.
 * Pairing the query with `findByText` instead would make a late render PASS,
 * suppressing the very failure we are waiting to read.
 */
import { screen } from '@testing-library/react'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Where CI collects these. Relative to services/ui. */
export const ARTEFACT_DIR = 'test-artifacts'

/** How long to keep looking after the synchronous query came up empty. */
const LATE_WINDOW_MS = 1500

export interface CaptureContext {
  /** Anything worth knowing — fetch calls, mock state, counts. */
  context?: () => Record<string, unknown>
}

function writeArtefact(label: string, report: unknown): void {
  try {
    mkdirSync(ARTEFACT_DIR, { recursive: true })
    const safe = label.replace(/[^a-z0-9-]+/gi, '-')
    writeFileSync(join(ARTEFACT_DIR, `${safe}.json`), JSON.stringify(report, null, 2))
    writeFileSync(
      join(ARTEFACT_DIR, `${safe}.html`),
      typeof document !== 'undefined' ? document.body.innerHTML : '',
    )
    // Also to stdout, so the CI log alone is useful if nobody downloads it.
    // eslint-disable-next-line no-console
    console.log(`[flake-capture] ${label}\n${JSON.stringify(report, null, 2)}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[flake-capture] could not write artefact for ${label}: ${String(err)}`)
  }
}

/**
 * Assert `needle` is in the document NOW, exactly as `getByText` would.
 *
 * On success: identical to the plain assertion, and nothing is written.
 * On failure: waits up to LATE_WINDOW_MS to see whether it arrives, writes the
 * artefact with a verdict, and then fails — with the verdict in the message, so
 * the CI log carries the answer even on its own.
 */
export async function expectTextPresentNow(
  needle: string,
  label: string,
  opts: CaptureContext = {},
): Promise<void> {
  if (screen.queryByText(needle)) return // the ordinary case: present, no artefact

  const domAtFailure = typeof document !== 'undefined' ? document.body.innerHTML : ''

  let arrivedLate = false
  try {
    await screen.findByText(needle, {}, { timeout: LATE_WINDOW_MS })
    arrivedLate = true
  } catch {
    arrivedLate = false
  }

  const verdict = arrivedLate
    ? 'ARRIVED LATE — the synchronous query raced the render; the query style is the cause'
    : 'NEVER ARRIVED — the data is genuinely absent; the query style is innocent'

  writeArtefact(label, {
    label,
    needle,
    capturedAt: new Date().toISOString(),
    verdict,
    arrivedWithinMs: arrivedLate ? LATE_WINDOW_MS : null,
    domLengthAtFailure: domAtFailure.length,
    context: opts.context ? opts.context() : {},
  })

  throw new Error(
    `[#117] Expected to find "${needle}" when queried, and did not.\n` +
      `VERDICT: ${verdict}\n` +
      `Artefact: ${ARTEFACT_DIR}/${label.replace(/[^a-z0-9-]+/gi, '-')}.{json,html}`,
  )
}
