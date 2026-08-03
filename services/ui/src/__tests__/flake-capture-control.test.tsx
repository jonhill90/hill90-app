/**
 * POSITIVE CONTROL for the #117 evidence recorder.
 *
 * THE CHOICE THIS FILE REPRESENTS. Two options were on the table: provoke a
 * failure locally under CI-like conditions, or make sure the existing
 * instrumentation will capture the next one unattended. This is the second, and
 * the reasoning is that the first is guesswork:
 *
 *   - #117 is CI-ONLY and has not reproduced in ~40 local runs across four
 *     emulated CI conditions. Another lap of the same guessing — CPU count,
 *     parallelism, load — is the re-running the standing instruction forbids,
 *     dressed as an experiment.
 *   - Every hour spent provoking is an hour the recorder still has not been
 *     shown to work.
 *
 * WHAT HAD TO BE TRUE for unattended capture, and where the gap was:
 *
 *   1. the check runs inside the assertion, before teardown          — yes, #161
 *   2. the writer produces a file                                    — NEVER PROVEN
 *   3. CI uploads it: `if: always()`, `if-no-files-found: ignore`    — yes, ci.yml:88
 *   4. the artefact is enough to diagnose without being present      — NEVER PROVEN
 *
 * 1 and 3 were already in place. 2 and 4 were not, and could not be: a green run
 * writes nothing by design, so nobody has ever seen a file come out of this. An
 * evidence recorder nobody has watched record is the same object as a check that
 * cannot fire — today's family, sitting on the oldest open issue.
 *
 * So this drives the recorder directly, in both arms, and asserts the file lands
 * with the fields a reader would need. It provokes nothing and re-runs nothing.
 */
import React from 'react'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { observeTextTiming, ARTEFACT_DIR } from './support/flake-capture'

// The recorder writes relative to cwd, which for vitest is services/ui. Run each
// case in a scratch cwd so the control never leaves files where CI collects them
// — a control that plants evidence would make every future run look like a hit.
let scratch: string
let originalCwd: string

beforeEach(() => {
  originalCwd = process.cwd()
  scratch = mkdtempSync(join(tmpdir(), 'flake-ctl-'))
  process.chdir(scratch)
})

afterEach(() => {
  cleanup()
  process.chdir(originalCwd)
  rmSync(scratch, { recursive: true, force: true })
})

const artefact = (label: string) => join(scratch, ARTEFACT_DIR, `${label}.json`)

/** Renders `text` after `delayMs`, which is the race #117 is about. */
function LateText({ text, delayMs }: { text: string; delayMs: number }) {
  const [show, setShow] = React.useState(false)
  React.useEffect(() => {
    const t = setTimeout(() => setShow(true), delayMs)
    return () => clearTimeout(t)
  }, [delayMs])
  return <div>{show ? text : 'loading'}</div>
}

describe('the #117 recorder actually records', () => {
  it('writes NOTHING when the text is present immediately', async () => {
    // The design: a green run leaves no artefact. If this wrote a file, CI would
    // collect one on every passing run and the signal would be worthless.
    render(<div>Deploy discussion</div>)
    await observeTextTiming('Deploy discussion', 'control-present')
    expect(existsSync(artefact('control-present'))).toBe(false)
  })

  it('ARRIVED LATE: writes the artefact, and the test still passes', async () => {
    render(<LateText text="Deploy discussion" delayMs={120} />)

    // Must not throw — a late render is recorded and allowed.
    await observeTextTiming('Deploy discussion', 'control-late', {
      context: () => ({ fetchCalls: ['/api/chat'], note: 'control' }),
    })

    expect(existsSync(artefact('control-late'))).toBe(true)
    const r = JSON.parse(readFileSync(artefact('control-late'), 'utf8'))
    expect(r.verdict).toMatch(/ARRIVED LATE/)
    expect(r.outcome).toMatch(/allowed to pass/)
    expect(r.arrivedAfterMs).toBeGreaterThan(0)
  })

  it('NEVER ARRIVED: writes the artefact AND fails', async () => {
    render(<div>loading</div>)

    await expect(
      observeTextTiming('Deploy discussion', 'control-absent'),
    ).rejects.toBeTruthy()

    expect(existsSync(artefact('control-absent'))).toBe(true)
    const r = JSON.parse(readFileSync(artefact('control-absent'), 'utf8'))
    expect(r.verdict).toMatch(/NEVER ARRIVED/)
    expect(r.outcome).toMatch(/FAILED/)
    expect(r.arrivedAfterMs).toBeNull()
  })

  it('the two verdicts are DISTINGUISHABLE — the defect that killed v1', async () => {
    // The first version of flake-capture used an onTestFailed hook, which runs
    // after cleanup() has emptied the DOM, so a LATE arrival reported NEVER
    // ARRIVED — identical to genuine absence. A detector that gives one answer
    // for two states is worse than none. This is that specific regression.
    render(<LateText text="Deploy discussion" delayMs={120} />)
    await observeTextTiming('Deploy discussion', 'v-late')
    const late = JSON.parse(readFileSync(artefact('v-late'), 'utf8'))

    cleanup()
    render(<div>loading</div>)
    await expect(observeTextTiming('Deploy discussion', 'v-absent')).rejects.toBeTruthy()
    const absent = JSON.parse(readFileSync(artefact('v-absent'), 'utf8'))

    expect(late.verdict).not.toBe(absent.verdict)
  })

  it('the artefact carries what a reader needs without being present', async () => {
    // Point 4 of the unattended-capture requirements. A file that lands but says
    // nothing useful satisfies the pipeline and not the question.
    render(<LateText text="Deploy discussion" delayMs={120} />)
    await observeTextTiming('Deploy discussion', 'control-fields', {
      context: () => ({ fetchCalls: ['/api/chat', '/api/agents'] }),
    })

    const r = JSON.parse(readFileSync(artefact('control-fields'), 'utf8'))
    for (const k of ['label', 'needle', 'capturedAt', 'verdict', 'outcome', 'context']) {
      expect(r).toHaveProperty(k)
    }
    expect(r.context.fetchCalls).toEqual(['/api/chat', '/api/agents'])
    // and the untruncated DOM lands beside it — the thing Testing Library's
    // 7000-character cut-off has withheld on all four recorded failures.
    expect(existsSync(join(scratch, ARTEFACT_DIR, 'control-fields.html'))).toBe(true)
  })
})
