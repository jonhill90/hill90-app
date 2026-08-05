// RESPONSE IDENTITY GUARD — supersedes the Server-header guard (round fifteen).
//
// Every response this worker produces is stamped with the worker's identity. The
// client side then asserts the stamp on each response matches the app it believes
// it called. Two failures are caught by one check:
//
//   stamp MISSING  -> the response came from something that is not this suite at
//                     all: the foreign daemon of round fifteen (websocket-sharp on
//                     a colliding ephemeral port) never stamps anything.
//   stamp DIFFERENT-> the response came from a SIBLING JEST WORKER: a different
//                     app instance, with a different RSA keypair (42 of 59 test
//                     files mint their own) and a different route table, which
//                     produces 401 and 404 exactly as the surviving failures do.
//
// WHY THIS IS STRONGER THAN EVERY EARLIER INSTRUMENT IN THIS INVESTIGATION:
// a status code can always be a legitimate answer, so every check built on one
// had to infer. An identity stamp cannot be mistaken for a legitimate response —
// it is either ours or it is not. The mock counter, the global jest.fn hook and
// the byte recorder all lacked that property and all reported clean results that
// were wrong.
//
// Test-side only. No production file is touched.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

// #350's own ask named this explicitly and the shipped fix (#352) only
// covered jest.auth401.js: "capturing whatever the identity guard AND the
// auth401 probe wrote." Before this, a real violation's only evidence was
// the thrown Error's message — visible in the raw CI job log until GitHub's
// retention window closes it, and never a durable artifact. Same trap
// #350 named for the probe, same fix: write unconditionally, on the
// occurrence, to a workspace-relative path the existing "Collect AUTH_401_PROBE
// evidence" artifact step already picks up (it globs the whole
// test-artifacts/ directory, not a single filename).
const EVIDENCE_OUT = process.env.IDENTITY_GUARD_OUT || 'test-artifacts/identityguard.jsonl';
try { fs.mkdirSync(path.dirname(EVIDENCE_OUT), { recursive: true }); } catch (e) {}
function recordViolation(v) {
  try {
    const testName = (typeof expect !== 'undefined' && expect.getState) ? expect.getState().currentTestName : '';
    fs.appendFileSync(EVIDENCE_OUT, JSON.stringify({ ts: Date.now(), test: testName, ...v }) + '\n');
  } catch (e) {}
}

// SHARED STATE, NOT MODULE STATE — and this is load-bearing, not style. This file
// is a setupFilesAfterEnv entry, so Jest re-executes it fresh (new module registry,
// new closures) once per test file. But http.ServerResponse.prototype and
// net.Socket.prototype are the real, un-sandboxed Node core objects — the SAME
// object across every test file sharing a worker. A module-scoped `let stampValue`
// used to mean every file's setup wrapped ANOTHER layer around whatever writeHead
// currently was, each layer re-stamping with its OWN closure's stampValue on the
// way back down the call chain (headersSent stays false until the real, innermost
// call), so the OLDEST — first-loaded — layer always won on the wire. A file's own
// __setStampForControl override could only ever affect its own (usually outermost)
// layer, so it was silently overwritten by an older sibling file's layer the moment
// more than one file in a worker had loaded this setup before it. #339 found this
// failing 2/2 on real full-suite runs; the diagnostic that first tried to rule out
// "patch-stacking" stored its counter on `global`, which — confirmed directly — is
// ALSO fresh per test file, so it could never see a layer stacked by an earlier
// file. That ruling-out was performed by an instrument incapable of observing the
// thing it was ruling out, not a diagnosis that stacking doesn't happen.
//
// The fix: state lives on the shared carrier itself (http.ServerResponse.prototype,
// confirmed by direct probe to persist across files in one worker), keyed by a
// plain string property — not a Symbol, since Symbol.for()'s registry is per-realm
// and Jest gives each test file its own realm, so two files' Symbol.for() calls
// with the same description are not guaranteed to collide to one symbol. Every
// file that loads this setup now reads and mutates the SAME state object instead
// of minting its own, and the monkey-patches themselves are installed at most once
// per worker (guarded by state.patched) instead of stacking a new wrapper layer on
// every file load.
const STATE_KEY = '__hill90IdentityGuardState';
const CARRIER = http.ServerResponse.prototype;
if (!CARRIER[STATE_KEY]) {
  const id = `${process.pid}:${(process.env.JEST_WORKER_ID || '0')}`;
  Object.defineProperty(CARRIER, STATE_KEY, {
    value: { ID: id, stampValue: id, violations: [], ourPorts: new Set(), patched: false },
    enumerable: false,
    configurable: false,
  });
}
const state = CARRIER[STATE_KEY];
const { ID } = state;
const HEADER = 'x-test-app-id';

// PORTS THIS PROCESS LISTENS ON — see state.ourPorts above for why this is now
// shared rather than one Set per file.
//
// Not every response our own app writes goes through http.ServerResponse. The
// terminal websocket handshake tests reject an upgrade from inside `ws`, which
// writes `HTTP/1.1 403 Forbidden` straight to the socket — legitimately ours, and
// unstampable. CI caught this as a false NO STAMP; the local check missed it
// because those tests are in half B and the verification ran half A.
//
// So a missing stamp is only a violation when the responder is not one of OUR
// listeners. A foreign daemon is on a port we never bound; `ws` is not.
//
// A port is ours only WHILE WE HOLD IT. This set was append-only in the first
// version, and that silently reopened the hole it was added to close: supertest
// binds and closes an ephemeral port per request, the OS returns it to the pool,
// and the foreign daemon can then answer on the same number later in the run. The
// guard treated that stranger as ours and stayed silent on a 501 that reached a
// test — observed in a real failing run, seventh instrument failure in this
// investigation. Removing on close is what makes "ours" mean currently-held.

if (!state.patched) {
  state.patched = true;

  const origListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...a) {
    const srv = this;
    srv.once('listening', () => { try { const p = (srv.address() || {}).port; if (p) { srv.__ourPort = p; state.ourPorts.add(p); } } catch (e) {} });
    srv.once('close', () => { try { if (srv.__ourPort) state.ourPorts.delete(srv.__ourPort); } catch (e) {} });
    return origListen.apply(this, a);
  };

  // --- server side: stamp every response this worker writes -------------------
  const origWriteHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function (...a) {
    try { if (!this.headersSent) this.setHeader(HEADER, state.stampValue); } catch (e) {}
    return origWriteHead.apply(this, a);
  };
  const origEnd = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function (...a) {
    try { if (!this.headersSent) this.setHeader(HEADER, state.stampValue); } catch (e) {}
    return origEnd.apply(this, a);
  };

  // --- client side: every response must carry OUR stamp ------------------------
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    const sk = this;
    let buf = '';
    let checked = false;
    sk.on('data', (d) => {
      if (checked || buf.length > 4096) return;
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      checked = true;
      const head = buf.slice(0, end);
      const m = new RegExp(`^${HEADER}:[ \\t]*(.+)$`, 'im').exec(head);
      const statusLine = head.split('\r\n')[0];
      if (!m) {
        // Ours but unstampable (a ws upgrade rejection) — not a violation.
        if (state.ourPorts.has(sk.remotePort)) return;
        state.violations.push({ kind: 'NO STAMP', statusLine, port: sk.remotePort, head: head.slice(0, 300) });
      } else if (m[1].trim() !== state.ID) {
        state.violations.push({ kind: 'FOREIGN STAMP', got: m[1].trim(), expected: state.ID, statusLine, port: sk.remotePort });
      }
    });
    return origConnect.apply(this, a);
  };
}

afterEach(() => {
  if (state.violations.length === 0) return;
  const v = state.violations.splice(0, state.violations.length);
  // Written here, not at push time: the control test's deliberate violations
  // are drained via __drainViolationsForControl() BEFORE this runs (see that
  // function's own comment — draining is what stops the control itself from
  // failing), so they never reach this line. Only a violation that actually
  // survives to fail a real test is recorded — which is the ones the durable
  // evidence exists for, not the synthetic ones every CI run generates on
  // purpose.
  v.forEach(recordViolation);
  const lines = v.map((x) => x.kind === 'NO STAMP'
    ? `  NO STAMP       ${x.statusLine}  from 127.0.0.1:${x.port}\n${x.head.split('\r\n').map((l) => '      ' + l).join('\n')}`
    : `  FOREIGN STAMP  ${x.statusLine}  from 127.0.0.1:${x.port}\n      produced by ${x.got}, this worker is ${x.expected}`);
  throw new Error(
    'RESPONSE IDENTITY VIOLATION — this test received a response it did not cause.\n' +
    lines.join('\n') + '\n\n' +
    'NO STAMP      = not this test suite at all. A process outside the repository\n' +
    '                answered on a colliding ephemeral port. Known offender on macOS:\n' +
    '                Logitech Options (LogiPluginService), serving websocket-sharp,\n' +
    '                which replies 501 to any non-WebSocket request.\n' +
    'FOREIGN STAMP = a SIBLING JEST WORKER answered. Its app has a different RSA\n' +
    '                keypair and route table, so this surfaces as a spurious 401 or 404.\n\n' +
    'Find the listener with:  lsof -nP -iTCP -sTCP:LISTEN | grep <port>\n' +
    'Not retried or skipped on purpose — see docs/decisions/api-suite-flakiness.md.',
  );
});

// __setStampForControl has existed since the guard was written, for a control
// that was never committed. __drainViolationsForControl is its missing half: a
// control cannot observe an afterEach throwing from inside the same test, but it
// can read what the detector recorded and clear it before afterEach runs.
//
// Draining is deliberate. Leaving the entries would make the guard's own
// afterEach throw and fail the control that just proved it works.
module.exports = {
  __setStampForControl: (v) => { state.stampValue = v; },
  __drainViolationsForControl: () => state.violations.splice(0, state.violations.length),
  __ID: ID,
};
