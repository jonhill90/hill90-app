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

const ID = `${process.pid}:${(process.env.JEST_WORKER_ID || '0')}`;
const HEADER = 'x-test-app-id';
let stampValue = ID;                 // overridable by the control only
const violations = [];

// PORTS THIS PROCESS LISTENS ON.
//
// Not every response our own app writes goes through http.ServerResponse. The
// terminal websocket handshake tests reject an upgrade from inside `ws`, which
// writes `HTTP/1.1 403 Forbidden` straight to the socket — legitimately ours, and
// unstampable. CI caught this as a false NO STAMP; the local check missed it
// because those tests are in half B and the verification ran half A.
//
// So a missing stamp is only a violation when the responder is not one of OUR
// listeners. A foreign daemon is on a port we never bound; `ws` is not.
const ourPorts = new Set();
// A port is ours only WHILE WE HOLD IT. This set was append-only in the first
// version, and that silently reopened the hole it was added to close: supertest
// binds and closes an ephemeral port per request, the OS returns it to the pool,
// and the foreign daemon can then answer on the same number later in the run. The
// guard treated that stranger as ours and stayed silent on a 501 that reached a
// test — observed in a real failing run, seventh instrument failure in this
// investigation. Removing on close is what makes "ours" mean currently-held.
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) {
  const srv = this;
  srv.once('listening', () => { try { const p = (srv.address() || {}).port; if (p) { srv.__ourPort = p; ourPorts.add(p); } } catch (e) {} });
  srv.once('close', () => { try { if (srv.__ourPort) ourPorts.delete(srv.__ourPort); } catch (e) {} });
  return origListen.apply(this, a);
};

// --- server side: stamp every response this worker writes ---------------------
const origWriteHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function (...a) {
  try { if (!this.headersSent) this.setHeader(HEADER, stampValue); } catch (e) {}
  return origWriteHead.apply(this, a);
};
const origEnd = http.ServerResponse.prototype.end;
http.ServerResponse.prototype.end = function (...a) {
  try { if (!this.headersSent) this.setHeader(HEADER, stampValue); } catch (e) {}
  return origEnd.apply(this, a);
};

// --- client side: every response must carry OUR stamp -------------------------
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
      if (ourPorts.has(sk.remotePort)) return;
      violations.push({ kind: 'NO STAMP', statusLine, port: sk.remotePort, head: head.slice(0, 300) });
    } else if (m[1].trim() !== ID) {
      violations.push({ kind: 'FOREIGN STAMP', got: m[1].trim(), expected: ID, statusLine, port: sk.remotePort });
    }
  });
  return origConnect.apply(this, a);
};

afterEach(() => {
  if (violations.length === 0) return;
  const v = violations.splice(0, violations.length);
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

module.exports = { __setStampForControl: (v) => { stampValue = v; }, __ID: ID };
