// PER-TEST EVENT-LOOP DELAY AUDIT — see docs/decisions/api-suite-flakiness.md.
//
// THE QUESTION IT ANSWERS
// =======================
// Round three left one quantity unexplained and it is the largest in the record:
// `routes-agents-events` takes 8.8s in one arm and 83.2s in another, inside a half
// that completes in ~11s. The reading offered was "contention", but contention has
// two entirely different mechanisms and the record cannot currently tell them apart:
//
//   STARVED — the process has work to do and cannot get CPU. The event loop is
//             blocked; timers fire late; a 5s jest timeout expires while the
//             callback that would have satisfied it sits in the queue.
//   WAITING — the process is idle, waiting on I/O or a timer that is late or never
//             comes. The event loop is free the whole time.
//
// Both look identical from the outside: a slow test, then a timeout or a wrong
// status. They have opposite fixes, and "contention" as written in the record does
// not distinguish them.
//
// `monitorEventLoopDelay` distinguishes them directly, because it measures how late
// the loop's own timer is. Validated before use:
//
//     blocking 300ms  -> loop max 304.9 ms
//     waiting  300ms  -> loop max  12.1 ms
//
// So high delay means STARVED and low delay during a long test means WAITING.
//
// POSITIVE CONTROL: set LOOP_AUDIT_CONTROL=block or =wait. The suite then injects a
// deliberate 400ms block or 400ms wait into every test's teardown, and the audit
// must report the first and not the second. A check that has never been seen to
// fire is not evidence — this repo has already been bitten by an active-handle
// census that measured jest's own plumbing (round two).
//
// Off by default. LOOP_AUDIT=1 enables it; it changes nothing about how CI runs.
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const OUT = process.env.LOOP_AUDIT_OUT || path.join(__dirname, 'loop-audit.jsonl');
const CONTROL = process.env.LOOP_AUDIT_CONTROL || '';

// resolution 10ms: fine enough to see a 5s timeout being missed, coarse enough that
// the monitor itself is not a load.
const h = monitorEventLoopDelay({ resolution: 10 });

let t0 = 0;
let file = '';

function relFile() {
  try {
    const p = expect.getState().testPath || '';
    return p.split('/services/api/')[1] || p;
  } catch (e) {
    return 'unknown';
  }
}

beforeAll(() => {
  file = relFile();
  h.enable();
});

beforeEach(() => {
  // Reset per test so one slow test does not colour the next.
  h.reset();
  t0 = Date.now();
});

afterEach(async () => {
  if (CONTROL === 'block') {
    // Deliberate STARVATION: hold the loop. The audit must show this.
    const until = Date.now() + 400;
    while (Date.now() < until) { /* spin */ }
  } else if (CONTROL === 'wait') {
    // Deliberate WAITING: idle the same duration. The audit must NOT flag this.
    await new Promise((r) => setTimeout(r, 400));
  }

  const ms = Date.now() - t0;

  // YIELD BEFORE READING, and this is not optional.
  //
  // The histogram is fed by a libuv timer. While the loop is blocked that timer
  // CANNOT fire, so the sample recording the delay only lands on the next turn of
  // the loop. Reading `h.max` synchronously after a block therefore reports 0 —
  // which is exactly what the first version of this file did, and its positive
  // control caught it: a deliberate 400ms block was reported as 0.0ms.
  await new Promise((r) => setTimeout(r, 20));

  let name = '';
  try { name = expect.getState().currentTestName || ''; } catch (e) { name = ''; }

  const row = {
    file,
    test: name,
    ms,
    loopMaxMs: +(h.max / 1e6).toFixed(1),
    loopMeanMs: +(h.mean / 1e6).toFixed(1),
    loopP99Ms: +(h.percentile(99) / 1e6).toFixed(1),
    // STARVED when the loop was blocked for a large fraction of a slow test.
    // Deliberately a ratio, not a threshold on duration: a test that legitimately
    // waits 10s for a timer is not starved, and must not be reported as such.
    starvedPct: ms > 0 ? +((h.max / 1e6 / ms) * 100).toFixed(1) : 0,
    pid: process.pid,
    control: CONTROL || undefined,
  };
  try {
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  } catch (e) { /* never fail a test because the audit could not write */ }
});

afterAll(() => {
  h.disable();
});
