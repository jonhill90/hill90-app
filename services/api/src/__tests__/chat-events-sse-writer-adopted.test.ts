/**
 * `GET /chat/threads/:id/events?follow=true` is the twin of #204's
 * `/threads/:id/stream` defect: it forwards each running agent's `tail -f`
 * line straight through a raw `res.write()`, discarding the return value,
 * with no cap on what accumulates for a client that has stopped reading.
 *
 * The producer here is a real pausable stream per agent (unlike the
 * DB-polled thread stream), so the fix mirrors `routes/agents.ts`'s existing
 * adoption of `createBoundedSseWriter` rather than inventing a new shape.
 *
 * `sse-backpressure.test.ts` already drives a live stalled client through
 * `agents.ts`'s identical construction end-to-end; this asserts the SAME
 * shape landed on the twin route rather than re-running that (expensive,
 * real-timer) harness a second time for a construction that is now shared
 * code. It is a narrower claim than a live test — see the note in the PR.
 */
export {};

const SRC = require('fs').readFileSync(
  require('path').join(__dirname, '../routes/chat.ts'), 'utf8',
);

const EVENTS = SRC.slice(
  SRC.indexOf("router.get('/threads/:id/events'"),
  SRC.indexOf("router.get('/threads/:id/screenshot'"),
);

describe('the thread event stream adopts the bounded SSE writer, like its DB-polled twin', () => {
  it('imports it', () => {
    // Not an exact-line match: app#443 added more named imports from the same
    // module (createPollFailureSignal, failureThresholdFor, sseErrorFrame),
    // which is a legitimate reason for this import to span multiple lines.
    // The claim this test makes is narrower — these two names come from this
    // module — and should not break every time that module gains a new export
    // this route also starts using.
    const importMatch = SRC.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/services\/sse-writer'/);
    expect(importMatch).not.toBeNull();
    expect(importMatch![1]).toContain('createBoundedSseWriter');
    expect(importMatch![1]).toContain('SSE_DEFAULTS');
  });

  it('constructs it with the shared hard cap before opening any agent stream', () => {
    const construct = EVENTS.indexOf('createBoundedSseWriter(res');
    // Two execInContainer call sites live in this route: the one-shot branch
    // (tail -n) and the follow/SSE branch (tail -f). Only the second is
    // relevant here.
    const followExec = EVENTS.indexOf("'-f', '-n'");
    expect(construct).toBeGreaterThan(-1);
    expect(followExec).toBeGreaterThan(-1);
    expect(construct).toBeLessThan(followExec);
    expect(EVENTS).toContain('SSE_DEFAULTS.hardCapBytes');
  });

  it('pauses and resumes every open agent stream as a group on backpressure', () => {
    const source = EVENTS.slice(EVENTS.indexOf('sse.setSource('));
    const body = source.slice(0, source.indexOf('for (const agent of runningAgents)'));
    expect(body).toContain('pause() { for (const s of streams)');
    expect(body).toContain('resume() { for (const s of streams)');
  });

  it('ends the stream with an explicit error frame on overflow, not a silent stop', () => {
    const overflow = EVENTS.slice(EVENTS.indexOf('onOverflow:'), EVENTS.indexOf('sse.setSource('));
    expect(overflow).toContain('cleanup()');
    expect(overflow).toContain("event: error");
    expect(overflow).toContain('res.end()');
  });

  it('no longer writes agent event frames through the raw, unchecked res.write()', () => {
    // The two forwarding sites (live 'data' and the end-of-stream flush) and
    // the heartbeat must all go through the bounded writer now.
    const dataHandler = EVENTS.slice(
      EVENTS.indexOf("stream.on('data'"), EVENTS.indexOf("stream.on('end'"),
    );
    const endHandler = EVENTS.slice(
      EVENTS.indexOf("stream.on('end'"), EVENTS.indexOf("stream.on('error'"),
    );
    const heartbeat = EVENTS.slice(EVENTS.indexOf('heartbeat = setInterval'));

    for (const [name, body] of [['data', dataHandler], ['end', endHandler], ['heartbeat', heartbeat]] as const) {
      expect(body).not.toMatch(/[^.]res\.write\(/);
      expect(body).toContain('sse.write(');
    }
  });
});
