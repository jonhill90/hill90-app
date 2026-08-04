/**
 * Pins an empirical claim a comment relies on, so a Node upgrade cannot falsify it
 * quietly.
 *
 * `routes/agents.ts` documents, in the comment justifying its `aborted` flag:
 *
 *   "on Node v26.5.0 a `res.write()` after `res.end()`, and a `res.write()` after
 *    the client has disconnected, both return false silently — no throw, no
 *    'error' event even with a listener attached, no uncaught exception."
 *
 * That correction was itself made because the previous comment asserted the
 * opposite and was believed for months. The claim is TRUE today. Nothing would
 * tell us if it stopped being true — it is pinned to a runtime version this
 * repository upgrades on someone else's schedule, and a comment that quietly
 * becomes false is the hazard the correction was written to remove.
 *
 * WHY IT MATTERS BEYOND TIDINESS. The unguarded `end`/`error` handlers in the SSE
 * routes were left alone on the strength of this behaviour: if `res.write()` after
 * a client disconnect ever throws, those handlers become an unhandled-exception
 * path in production. This test is what converts "we checked once" into "we would
 * be told".
 *
 * It tests NODE, not our code, which is unusual and deliberate: the thing at risk
 * of changing underneath us is the runtime.
 */
import http from 'http';
import { AddressInfo } from 'net';

/** Runs a server handler against one real request and reports what happened. */
function drive(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, done: (o: string[]) => void) => void,
  clientBehaviour: (req: http.ClientRequest, res?: http.IncomingMessage) => void,
): Promise<string[]> {
  return new Promise((resolve) => {
    const outcome: string[] = [];
    const onUncaught = (e: Error) => outcome.push(`UNCAUGHT:${(e as NodeJS.ErrnoException).code}`);
    process.once('uncaughtException', onUncaught);

    const server = http.createServer((req, res) => {
      handler(req, res, (o) => {
        process.removeListener('uncaughtException', onUncaught);
        server.close(() => resolve(o));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const req = http.request({ port, path: '/' }, (res) => clientBehaviour(req, res));
      req.on('error', () => { /* the abort itself */ });
      req.end();
      if (clientBehaviour.length === 1) clientBehaviour(req);
    });
    void outcome;
  });
}

describe('the Node behaviour agents.ts documents', () => {
  it('write() AFTER end() returns false and does not throw', async () => {
    const outcome = await drive(
      (_req, res, done) => {
        const seen: string[] = [];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: end\ndata: stream closed\n\n');
        res.end();

        setTimeout(() => {
          res.on('error', (e: NodeJS.ErrnoException) => seen.push(`res-error:${e.code}`));
          try {
            seen.push(`write:${res.write('event: error\ndata: late\n\n')}`);
            res.end();
            seen.push('second-end:ok');
          } catch (e) {
            seen.push(`THREW:${(e as NodeJS.ErrnoException).code}`);
          }
          setTimeout(() => done(seen), 150);
        }, 20);
      },
      (_req, res) => { res?.resume(); },
    );

    // If any of these three change, the comment in agents.ts is false and the
    // unguarded end/error handlers become an exception path in production.
    expect(outcome).toContain('write:false');
    expect(outcome).toContain('second-end:ok');
    expect(outcome.filter((o) => o.startsWith('THREW'))).toHaveLength(0);
    expect(outcome.filter((o) => o.startsWith('res-error'))).toHaveLength(0);
    expect(outcome.filter((o) => o.startsWith('UNCAUGHT'))).toHaveLength(0);
  }, 15000);

  it('write() after the CLIENT disconnects returns false and does not throw', async () => {
    const outcome = await drive(
      (req, res, done) => {
        const seen: string[] = [];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: hello\n\n');

        req.on('close', () => {
          setTimeout(() => {
            res.on('error', (e: NodeJS.ErrnoException) => seen.push(`res-error:${e.code}`));
            try {
              // Exactly agents.ts's 'end' handler firing after the client left.
              seen.push(`write:${res.write('event: end\ndata: stream closed\n\n')}`);
              res.end();
              seen.push('end:ok');
            } catch (e) {
              seen.push(`THREW:${(e as NodeJS.ErrnoException).code}`);
            }
            setTimeout(() => done(seen), 150);
          }, 20);
        });
      },
      (req, res) => { res?.once('data', () => req.destroy()); },
    );

    expect(outcome).toContain('write:false');
    expect(outcome.filter((o) => o.startsWith('THREW'))).toHaveLength(0);
    expect(outcome.filter((o) => o.startsWith('UNCAUGHT'))).toHaveLength(0);
  }, 15000);
});
