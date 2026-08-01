// DETERMINISTIC CARRIER AUDIT — see docs/decisions/api-suite-flakiness.md.
//
// The standing hypothesis is that the flake's carrier is per-process mutable state
// written at an unpredictable moment and read as a branch condition. This does not
// hunt the failure; it audits the carrier, so one pass is enough whether or not the
// run happens to fail.
//
// Snapshot process.env and the enumerable keys of globalThis before each test file
// and diff after it. Anything changed-and-not-restored is a candidate carrier.
const fs = require('fs');
const path = require('path');

const OUT = process.env.CARRIER_AUDIT_OUT || path.join(__dirname, 'carrier-audit.jsonl');
let envBefore, globalBefore, handlesBefore;

// Node's active-handle census. Undocumented but stable, and the only cheap way to
// see sockets and timers that outlive the test that created them.
function handleCensus() {
  const h = (process)._getActiveHandles ? (process)._getActiveHandles() : [];
  const r = (process)._getActiveRequests ? (process)._getActiveRequests() : [];
  const byType = {};
  for (const x of h) {
    const t = (x && x.constructor && x.constructor.name) || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  }
  const detail = [].map((x) => {
    const t = (x && x.constructor && x.constructor.name) || 'unknown';
    let extra = '';
    try {
      if (t === 'Server' && x.address) { const a = x.address(); extra = a ? ':' + (a.port || '') : ':closed'; }
      if (t === 'Socket') extra = ':' + (x.destroyed ? 'destroyed' : (x.readyState || 'open'));
    } catch (e) { extra = ':?'; }
    return t + extra;
  });
  return { handles: h.length, requests: r.length, byType, detail };
}

beforeAll(() => {
  envBefore = { ...process.env };
  globalBefore = new Set(Object.keys(globalThis));
  handlesBefore = handleCensus();
});

afterAll(() => {
  const envAfter = { ...process.env };
  const changed = [];
  const keys = new Set([...Object.keys(envBefore), ...Object.keys(envAfter)]);
  for (const k of keys) {
    if (envBefore[k] !== envAfter[k]) {
      changed.push({
        key: k,
        before: envBefore[k] === undefined ? null : '<set>',
        after: envAfter[k] === undefined ? null : '<set>',
      });
    }
  }
  const addedGlobals = Object.keys(globalThis).filter((k) => !globalBefore.has(k));
  const handlesAfter = handleCensus();
  const leaked = handlesAfter.handles - handlesBefore.handles;
  if (changed.length || addedGlobals.length || leaked > 0) {
    fs.appendFileSync(
      OUT,
      JSON.stringify({
        file: path.relative(__dirname, expect.getState().testPath || 'unknown'),
        pid: process.pid,
        env: changed,
        globals: addedGlobals,
        handlesBefore: handlesBefore.handles,
        handlesAfter: handlesAfter.handles,
        leakedHandles: leaked,
        byTypeAfter: handlesAfter.byType,
      }) + '\n'
    );
  }
});
