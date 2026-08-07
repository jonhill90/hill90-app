// TIMEOUT CAPTURE PROBE (reporter half). See jest.timeoutprobe.js for the full
// design note and why this is split across two files — in short: jest-circus's
// own internal event bus is unreachable from a setupFilesAfterEnv file (tried,
// verified not to work), because that file runs inside a sandboxed module
// registry separate from the one actually dispatching test-runner events. A
// custom Jest Reporter runs in Jest's own main process and receives the real,
// final per-test result through the PUBLIC, documented API — including jest's
// own "Exceeded timeout of Nms" failure message, jest's real timeout signal,
// never a duration threshold this probe invents itself.
//
// Wired via jest.config.js's `reporters` array, gated on PROBE_TIMEOUT — same
// toggle jest.timeoutprobe.js checks for its own half.
const fs=require('fs');
const path=require('path');

const OUT=process.env.PROBE_TIMEOUT_OUT||'test-artifacts/timeoutprobe.jsonl';

class TimeoutProbeReporter {
  constructor() {
    try{fs.mkdirSync(path.dirname(OUT),{recursive:true});}catch(e){}
    this._rec({event:'timeoutprobe-reporter-installed'});
  }

  _rec(o) {
    try{o.ts=Date.now();fs.appendFileSync(OUT,JSON.stringify(o)+'\n');}catch(e){}
  }

  // Fires once per test case (jest-circus reports these individually, not
  // just per file), with the ACTUAL final status jest-circus produced —
  // 'passed' | 'failed' | 'pending' | 'skipped' | 'todo'. A timeout is a
  // 'failed' result whose failureMessages contains jest's own fixed message
  // text (see node_modules/jest-circus/build/utils.js, _makeTimeoutMessage) —
  // checked directly against that string, not inferred from duration.
  onTestCaseResult(_test, testCaseResult) {
    if (testCaseResult.status !== 'failed') return;
    const messages = testCaseResult.failureMessages || [];
    const timeoutMessage = messages.find(
      (m) => typeof m === 'string' && m.indexOf('Exceeded timeout of') !== -1
    );
    if (!timeoutMessage) return;

    // Capped, not the full stack trace jest attaches (frames through
    // jest-circus/jest-runtime internals that name nothing about THIS
    // failure) — same discipline as jest.probe400.js's BODY_CAP. The first
    // ~300 chars already contain jest's own fixed "Exceeded timeout of Nms"
    // sentence in full; that is the diagnostic content, not the frames below it.
    const MESSAGE_CAP = 500;

    this._rec({
      kind: 'test-timeout',
      test: testCaseResult.fullName || testCaseResult.title,
      // AssertionResult.duration is jest's own measured elapsed time for
      // this test case — not a value this probe computed itself.
      elapsedMs: typeof testCaseResult.duration === 'number' ? testCaseResult.duration : null,
      message: timeoutMessage.slice(0, MESSAGE_CAP),
    });
  }
}

module.exports = TimeoutProbeReporter;
