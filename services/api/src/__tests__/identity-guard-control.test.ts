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
 * ARM B (FOREIGN STAMP) IS NOW HERE — it was pulled out once (see #339) after
 * failing 2/2 real full-suite parallel runs while passing every isolated and
 * artificial-load run. The root cause, found and fixed in jest.identityguard.js:
 * that file is a setupFilesAfterEnv entry, so Jest re-executes it fresh once per
 * test file, but http.ServerResponse.prototype is the same real, un-sandboxed
 * object across every file in a worker — so each file's load used to stack
 * another monkey-patch layer on top of whatever was already installed, each layer
 * re-stamping the response with its OWN module-closure's stampValue on the way
 * back down the call chain. A file's own __setStampForControl override only ever
 * touched its own layer, so an older sibling file's layer silently overwrote it
 * whenever more than one file in a worker had loaded the setup before it — arm B
 * failed to see its own override on the wire and recorded zero violations, the
 * exact shape #339 measured. The fix moved the guard's state off per-file module
 * closures onto the shared carrier itself, keyed by a plain string property (not
 * Symbol.for(), whose registry is per-realm and does not collide across Jest's
 * per-file realms), and made the monkey-patch installation idempotent instead of
 * stacking. Full mechanism, the diagnostic blind spot that missed it the first
 * time, and the deterministic before/after reproduction are in #339.
 *
 * The instrument that first tried to rule out patch-stacking stored its counter
 * on `global`, which is also fresh per test file — so it could never observe a
 * layer stacked by an earlier file. Patch-stacking was not ruled out; it was
 * ruled out by an instrument incapable of seeing it.
 *
 * WHAT THIS DOES NOT PROVE: a deterministic two-layer reproduction (forcing a
 * second module load via jest.resetModules(), simulating an earlier sibling
 * file's load) failed 5/5 against the pre-fix guard and passed 8/8 against the
 * fix — but twelve-plus attempts to reproduce the SAME failure across two
 * genuinely separate test files under Jest's own real scheduler did not succeed
 * (Jest did not honor the requested file order). So this arm proves the
 * mechanism is real and the fix closes it; it does not confirm that this exact
 * ordering is what caused the two original full-suite failures. If this test
 * ever needs a skip to stay green, that is itself evidence the fix did not fully
 * close the hole — pull it back out and reopen #339, do not skip it in place.
 */
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

const guard = require('../../jest.identityguard.js');
const API_ROOT = path.resolve(__dirname, '../..');

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

  test('arm B — FOREIGN STAMP: a response stamped with another worker\'s ID is a violation', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await listen(server, 0);
    const port = (server.address() as net.AddressInfo).port;

    guard.__setStampForControl('other-worker:9');
    let header: string | undefined;
    try {
      header = await get({ port, path: '/', method: 'GET' });
    } finally {
      // Reset before the response finishes draining, not after — a real request
      // in-flight when this test ends must not carry the forced stamp into
      // whatever the guard's own afterEach inspects next.
      guard.__setStampForControl(guard.__ID);
    }
    await close(server);

    // Ties the pass back to the mechanism, not just the outcome: the wire header
    // must actually carry the forced foreign value, not just "some violation".
    expect(header).toBe('other-worker:9');

    const violations = guard.__drainViolationsForControl();
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('FOREIGN STAMP');
    expect(violations[0].got).toBe('other-worker:9');
  });

  // #350's own ask named both instruments — "capturing whatever the identity
  // guard AND the auth401 probe wrote" — and the first shipped fix (#352)
  // only wired up the probe. Before the write added alongside this test, a
  // real violation's only evidence was the thrown Error's message: visible
  // in the raw CI job log until GitHub's retention window closes it, never a
  // durable artifact.
  //
  // Arms A/B/C above use __drainViolationsForControl(), which drains BEFORE
  // afterEach runs — deliberately, so the control's own synthetic violations
  // don't fail the control test that just proved the detector fires. That
  // means none of them exercise the write, which only happens for a
  // violation that survives to actually fail a test. A REAL undrained
  // violation can't be produced in-process without failing this file, so
  // this spawns the violation in a genuinely separate jest process (same
  // pattern as boot-fatal.test.ts) and asserts on its exit code and the
  // evidence file it leaves behind — proving the write happens on the actual
  // fail path, not a path adjacent to it.
  test('a REAL (undrained) violation writes evidence before it fails the test', () => {
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-guard-evidence-'));
    const evidenceOut = path.join(evidenceDir, 'identityguard.jsonl');
    const fixtureName = `zz-nested-identity-violation-${process.pid}.test.ts`;
    const fixturePath = path.join(__dirname, fixtureName);

    const fixtureSource = `
import http from 'http';
import net from 'net';

function listen(server: net.Server, target: number): Promise<void> {
  return new Promise((resolve) => server.listen(target, resolve));
}
function get(opts: http.RequestOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      res.on('data', () => {});
      res.on('end', () => { res.socket?.destroy(); resolve(); });
    });
    req.on('error', reject);
    req.end();
  });
}

test('deliberately fails with an undrained FOREIGN STAMP violation', async () => {
  const guard = require('../../jest.identityguard.js');
  guard.__setStampForControl('deliberately-wrong-worker:0');
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await listen(server, 0);
  const port = (server.address() as net.AddressInfo).port;
  await get({ port, path: '/', method: 'GET' });
  guard.__setStampForControl(guard.__ID);
  await new Promise((r) => server.close(r));
  // Deliberately not drained — this is the point of the fixture.
});
`;

    fs.writeFileSync(fixturePath, fixtureSource);
    try {
      const result = spawnSync(
        path.join(API_ROOT, 'node_modules/.bin/jest'),
        ['--runTestsByPath', fixturePath, '--config', path.join(API_ROOT, 'jest.config.js')],
        {
          cwd: API_ROOT,
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, IDENTITY_GUARD_OUT: evidenceOut },
        },
      );

      // The violation must still fail the fixture's own test — this test
      // must not silently make the detector toothless while checking that
      // it also writes evidence.
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('RESPONSE IDENTITY VIOLATION');

      const raw = fs.readFileSync(evidenceOut, 'utf8').trim();
      expect(raw.length).toBeGreaterThan(0);
      const row = JSON.parse(raw.split('\n')[0]);
      expect(row.kind).toBe('FOREIGN STAMP');
      expect(row.got).toBe('deliberately-wrong-worker:0');
      expect(typeof row.ts).toBe('number');
      expect(row.test).toContain('deliberately fails with an undrained FOREIGN STAMP violation');
    } finally {
      fs.rmSync(fixturePath, { force: true });
      fs.rmSync(evidenceDir, { recursive: true, force: true });
    }
  }, 35000);
});
