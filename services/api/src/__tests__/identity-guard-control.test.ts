/**
 * A committed control for `jest.identityguard.js` (#179).
 *
 * Before this file, none of the guard's three arms had a permanent test. Arms A and
 * B were verified once, by hand, during the 2026-08-03 investigation and written up
 * in docs/decisions/api-suite-flakiness.md — no file kept them forced. Arm C was
 * never shipped at all: both approaches tried there destabilised the suite for
 * opposite reasons, and are recorded in the same doc rather than committed.
 *
 * IN-PROCESS RAW LISTENER (approach 1) failed because `ourPorts` exempts any TCP
 * listener this process opens, not listeners that are part of the app under test —
 * so a rogue in-process TCP listener gets waved through by the same exemption meant
 * for `ws`'s unstamped upgrade rejections, and arm C never fires.
 *
 * CHILD-PROCESS LISTENER (approach 2) failed for the opposite reason: it is
 * genuinely outside `ourPorts`, but a real TCP listener on the shared, OS-wide
 * ephemeral port range every jest worker draws from doesn't just get caught by its
 * own test — it becomes a live instance of the exact collision bug the guard exists
 * to catch, and it hit unrelated sibling workers on a recycled port.
 *
 * Both trace to the same root: the guard tells "ours" from "foreign" using two
 * properties — which OS process opened the listener (`ourPorts`), and a port number
 * drawn from one shared namespace. Nothing built from an ordinary TCP listener can
 * be foreign enough to trip the first and isolated enough to not trip the second.
 *
 * A Unix domain socket, run in-process, threads both: `srv.address()` for a UDS
 * server returns a path string, so `(srv.address() || {}).port` is `undefined` and
 * the listener is never added to `ourPorts` even though it's in-process; and
 * `net.Socket#remotePort` is `undefined` for a UDS connection, so
 * `ourPorts.has(sk.remotePort)` is `ourPorts.has(undefined)` — always false, so the
 * violation branch fires unsuppressed. And because it's in-process, there is no
 * child, no teardown race, and no shared ephemeral range to collide with a sibling
 * worker on. Measured directly with a throwaway script before this file was
 * written: `srv.address()` returns the socket path, `(srv.address()||{}).port` and
 * `client.remotePort` are both `undefined`, and the raw response still arrives.
 *
 * WHAT THIS DOES NOT PROVE: the real-world offender named in the guard's own
 * afterEach message (LogiPluginService / websocket-sharp on macOS) is a TCP
 * listener, not a UDS one. This control proves the guard's NO-STAMP detection
 * branch fires correctly for an unstamped, non-`ourPorts` responder — the same
 * branch a colliding TCP daemon would trip — without reproducing that specific
 * daemon's transport. It is a control on the detector's logic, not a simulation of
 * the field failure.
 *
 * ARM B (FOREIGN STAMP) IS NOT SHIPPED ACTIVE, and that is deliberate, not an
 * oversight. Alone, and under artificial CPU load, it is 100% reliable (dozens of
 * runs). Under the real full 117-suite parallel run it failed twice out of two —
 * with `__setStampForControl('other-worker:9')` set synchronously before the
 * request and reset synchronously in a `finally` after it resolves, the response
 * this test's own server sent back carried this worker's correct, un-overridden
 * ID, not the forced value, so no violation was recorded. Patch-stacking across
 * test files sharing one worker process was the first suspect and was ruled out
 * directly: an instrumented run showed the guard's setup file loads exactly once
 * per worker (no repeated monkey-patching). Small hand-built repros — up to ten
 * sibling files run before this one, in-band or with two workers, ten attempts —
 * never reproduced it. Root cause not found. Shipping it active would mean a
 * control that cannot reliably go green, which is the same defect this issue
 * exists to keep out of the tree. See the PR/issue discussion for the full
 * writeup; this is left `test.skip` with the evidence above rather than deleted,
 * so the next person doesn't have to rediscover any of it.
 */
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

const guard = require('../../jest.identityguard.js');

function listen(server: net.Server, target: number | string): Promise<void> {
  return new Promise((resolve) => server.listen(target as any, resolve));
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Destroys the socket after the response completes rather than leaving it to a
// keep-alive-style half-close: server.close()'s callback waits for every
// connection to fully end, and a socket the server merely .end()s without the
// client also destroying its side can sit half-closed indefinitely — observed
// directly (a throwaway script's server.close() callback never fired) before
// this was added.
function get(opts: http.RequestOptions): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        res.socket?.destroy();
        resolve(res.headers['x-test-app-id'] as string | undefined);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('identity guard control (#179)', () => {
  test('arm A — OURS: a correctly stamped response is not a violation', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await listen(server, 0);
    const port = (server.address() as net.AddressInfo).port;

    await get({ port, path: '/', method: 'GET' });
    await close(server);

    expect(guard.__drainViolationsForControl()).toEqual([]);
  });

  // Not shipped active — see the file header. This body is preserved, unskipped,
  // as the reproduction the next person picking this up should start from.
  test.skip('arm B — FOREIGN STAMP: a stamp that is not this worker\'s is a violation', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await listen(server, 0);
    const port = (server.address() as net.AddressInfo).port;

    guard.__setStampForControl('other-worker:9');
    try {
      await get({ port, path: '/', method: 'GET' });
    } finally {
      guard.__setStampForControl(guard.__ID);
    }
    await close(server);

    const violations = guard.__drainViolationsForControl();
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('FOREIGN STAMP');
    expect(violations[0].got).toBe('other-worker:9');
  });

  test('arm C — NO STAMP: an in-process UDS listener answering raw is a violation', async () => {
    const sockPath = path.join(os.tmpdir(), `identity-guard-control-${process.pid}.sock`);
    try {
      fs.unlinkSync(sockPath);
    } catch {
      // didn't exist — fine
    }

    // Both ends must fully close, not just half-close, or server.close()'s
    // callback — which waits for every connection to end — never fires.
    // sock.end() alone leaves that to the client; destroying explicitly here
    // closes our side outright once the bytes are handed off.
    const rogue = net.createServer((sock) => {
      sock.end('HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\n\r\n', () => sock.destroy());
    });
    await listen(rogue, sockPath);

    // The exemption this arm depends on bypassing — assert it directly, not just assume it.
    expect((rogue.address() as any)?.port).toBeUndefined();

    await get({ socketPath: sockPath, path: '/', method: 'GET' } as http.RequestOptions);

    await close(rogue);
    try {
      fs.unlinkSync(sockPath);
    } catch {
      // already gone — fine
    }

    const violations = guard.__drainViolationsForControl();
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('NO STAMP');
    // Ties the pass back to the mechanism, not just the outcome: undefined is why
    // `ourPorts.has(...)` couldn't have exempted this responder.
    expect(violations[0].port).toBeUndefined();
  });
});
