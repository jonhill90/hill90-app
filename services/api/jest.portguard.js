// FOREIGN-RESPONSE GUARD — see docs/decisions/api-suite-flakiness.md, round fifteen.
//
// On 2026-08-03 a test asserting on `res.status` was asserting on a response this
// application never wrote. A third-party daemon (Logitech's LogiPluginService,
// serving websocket-sharp) listens inside the ephemeral port range supertest
// draws from, and answers a non-WebSocket HTTP request with 501. Fourteen rounds
// of investigation searched inside the app for a status written outside it.
//
// A test that silently asserts against whatever answered is the same family of
// defect this whole investigation was closing: an instrument that cannot tell a
// real observation from a foreign one. So this does NOT retry, skip or work
// around the collision — it FAILS LOUDLY and names what answered.
//
// Detection: neither express nor Node's http server sets a `Server:` response
// header. Anything that does is not us.
const net = require('net');

const FOREIGN = [];
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const sk = this;
  let buf = '';
  sk.on('data', (d) => {
    if (buf.length > 2048) return;
    buf += d.toString('latin1');
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const head = buf.slice(0, end);
    const m = /^Server:[ \t]*(.+)$/im.exec(head);
    if (m) {
      FOREIGN.push({
        server: m[1].trim(),
        statusLine: head.split('\r\n')[0],
        port: sk.remotePort,
        head: head.slice(0, 400),
      });
    }
    buf = 'x'.repeat(2049); // stop accumulating
  });
  return origConnect.apply(this, a);
};

afterEach(() => {
  if (FOREIGN.length === 0) return;
  const f = FOREIGN.splice(0, FOREIGN.length);
  const lines = f.map((x) => `  ${x.statusLine}  (Server: ${x.server})  from 127.0.0.1:${x.port}`);
  throw new Error(
    'FOREIGN HTTP RESPONSE — this test received a response that this application did not write.\n' +
    lines.join('\n') + '\n\n' +
    'A process outside this repository is listening inside the ephemeral port range\n' +
    'supertest binds from, and answered instead of the app. Known offender on macOS:\n' +
    'Logitech Options (LogiPluginService), which serves websocket-sharp and replies\n' +
    '501 Not Implemented to any non-WebSocket request.\n\n' +
    'Find it with:   lsof -nP -iTCP -sTCP:LISTEN | grep <port>\n' +
    'This is NOT retried or skipped on purpose: asserting on a stranger\'s response is\n' +
    'how this defect stayed invisible for fourteen rounds. See\n' +
    'docs/decisions/api-suite-flakiness.md, round fifteen.',
  );
});
