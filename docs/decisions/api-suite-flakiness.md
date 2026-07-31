# The api suite is flaky, why, and what a green CI run is worth

**Status:** diagnosed, **not fixed**. Recorded 2026-07-30.

## The measurement

Full `services/api` suite, on `main`, this machine:

```
10 full-suite runs          3 failed          ~30% of runs
routes-agents.test.ts alone, 10 runs   0 failed
--detectOpenHandles        nothing reported
```

Four *different* tests failed across today's captures, never the same one twice in a row:

```
POST /profile/password › returns structured 501        expected 501, received 404
GET /agents/:id/events › SSE backfill owner scoping    calls[1] undefined
POST /agents/:id/skills › agent not found 404
DELETE /agents/:id › works for admin                   socket hang up
```

Only 3 of the failures were `socket hang up`; the rest are assertion failures. So this is
not simply connection pressure.

**A green CI run is therefore roughly a 70% coin flip, not proof.** Roughly fifteen pull
requests were merged today citing a green check. None of those merges is invalidated —
but none of them was *verified* to the degree the green implied, and a genuine regression
would have been indistinguishable from this noise.

## The mechanism

Two things combine.

**1. Test files drive one shared mock through an ordered queue.** Every api test file does
some version of:

```ts
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));
// ...
mockQuery.mockResolvedValueOnce({ rows: [...] });   // "the first query"
mockQuery.mockResolvedValueOnce({ rows: [...] });   // "the second query"
```

The contract is positional: *the Nth query this handler makes gets the Nth queued
response*, and assertions read `mockQuery.mock.calls[1]` to mean "the backfill query".

**2. Handlers do asynchronous work that outlives the response.** The SSE endpoint at
`services/api/src/routes/agents.ts:1730` starts

```ts
const pollInterval = setInterval(async () => { /* queries the pool */ }, ...)
```

cleared on `req.on('close')` (`:1780`). Correct in production. In a test, the interval can
fire *after* the assertion, or after `mockQuery.mockReset()` in the next test's setup, and
each firing consumes a queued response or adds an unexpected entry to `mock.calls`.

So a test can be handed a response queued for someone else — which is exactly the
`expected 501, received 404` shape, a handler taking a different branch because it got the
wrong row — or can sample `mock.calls` before the work it is asserting on has happened,
which is the `calls[1] undefined` shape.

**Why concurrency matters.** Alone, a file runs fast and the interleaving rarely happens:
0 failures in 10 runs. Under parallel workers the machine is contended, timings stretch,
and the interleaving becomes likely. That is why it looks like "shared state between
files" and is not: the shared state is *within* each file, and parallelism only changes the
timing that exposes it.

## Measured: no jest setting fixes this, and --runInBand makes it worse

`--runInBand` was the obvious candidate and it is **refuted**. Ten full-suite runs per mode,
same machine, unmodified `main`:

| Mode | Test files per process | Failures / 10 |
|---|---|---|
| `--runInBand` | all 58 | **4** |
| default (~10 workers) | ~6 | **3** |
| `--maxWorkers=16` | ~4 | **2** |
| one file, alone | 1 | **0** |

**The failure rate is monotonic in how many test files share a process.** That is the
finding. Serialising the suite puts every file in one process and makes leakage *more*
likely, not less — so the intuitive fix costs wall-clock and buys a worse result.

Two further hypotheses were tested and both failed:

- **"One file poisons the others."** Excluding `routes-agents-events.test.ts`, the only
  file that opens streaming connections, gives **6/10** — no better. It is not one culprit.
- **"Cross-file mock pollution."** Jest gives each file its own module registry, so the
  shared mock queue cannot cross files. The queue explains failures *within* a file; it
  does not explain this gradient.

## What actually accumulates

`request(app)` creates and destroys **a new HTTP server per call**, and the suite makes
thousands. The 404-shaped failures are the tell: `expected 501, received 404` and
`GET /agents returns 401 without auth` failing are not assertion logic going wrong — a 404
means Express matched no route, i.e. **the request was answered by an app that does not
mount that route**. That is a request landing on the wrong server, which is what port and
descriptor reuse across thousands of short-lived listeners produces.

So the fix is to stop creating a server per request: one listening server per file, opened
in `beforeAll` and closed in `afterAll`, with `request(server)` instead of `request(app)`.
Mechanical, and it touches every api test file — which is the ordering problem stated
below: a large mechanical change to the tests, while the suite cannot be trusted to tell
you whether you broke something.

**Until that lands, `--maxWorkers=16` is the least-bad setting** (2/10 rather than 3/10),
but it is a mitigation of a symptom and should not be mistaken for a fix.

## What the fix is, and why it is not in this commit

Per failing test, the assertion must **wait for** the side effect rather than sample it:
poll until `mockQuery.mock.calls.length >= n` with a timeout, or have the handler signal
completion. And every test that opens an SSE or streaming connection must close it and
await the close before asserting, so no interval can fire afterwards.

That is a per-test change across at least four files, and each one needs its own
before/after verification. At a ~30% reproduction rate, demonstrating "fails reliably
before, passes reliably after" takes tens of runs per change — that is the honest cost, and
it is why this is written down rather than half-done. **These are the tests every other
merge today was verified against; a rushed refactor of them is the worst possible place to
be approximate.**

Two smaller things worth doing alongside, and they are cheap:

- `jest --randomize` (or `--shuffle`) in one CI job, so order dependence would surface
  deliberately instead of by luck.
- Repeat the suite N times in CI on a schedule and record the failure rate, so this number
  stops being folklore.

## Second session, 2026-07-31: what is now ruled out, and how

Written down because this is the second session on this defect and a ruled-out list that
lives only in a terminal is lost when that terminal clears. **Read this before forming a
theory** — three of the obvious ones are already dead.

**The operational consequence, stated plainly: a green CI run in this suite is not
evidence.** At roughly a third of runs failing, a green run is a coin toss that landed
your way. Any claim of the form "the suite passes, therefore my change is safe" is
unsupported until this is fixed. That is the reason this record exists.

### Reproduced on demand

Unmodified `main`, this machine:

| Mode | Runs | Failures |
|---|---|---|
| default workers | 8 | **3** |
| `--runInBand` | 6 | **3** |

**The flake is order-independent, and that is the new structural finding.** Under
`--runInBand` jest runs every file sequentially in one process, so the file order is
fixed — and the failure rate does not drop. Whatever the shared state is, it is not "file
A must run before file B". The trigger is *timing*: something lands asynchronously.

This refines rather than contradicts the monotonic-in-files-per-process result above.
More files per process means more asynchronous work in flight; it does not mean a
particular sequence.

Victims differ every run and are spread across files, which is itself evidence against a
single culprit: three different `shared-knowledge` tests, `model-policies`, `agents`,
`knowledge` proxy, and two `container-profiles` audit-emission tests.

### The valuable negative: the mock-queue theory is not the necessary cause

The leading theory in this document is the positional `mockResolvedValueOnce` queue. It is
widespread — **38 of 59 test files use `Once(`, 1381 calls in total** — so it looked like
the obvious candidate.

**But `src/__tests__/routes-shared-knowledge.test.ts` contains ZERO `Once(` calls and
still flakes**, producing two of the failures observed this session.

A file with no positional queue at all cannot be failing because a queued value was stolen
from it. So the queue is at most *a* mechanism, not *the* mechanism, and a fix aimed only
at queues will leave this flaking. Do not re-derive this: it cost a session.

### Ruled out this session, with the method

| Candidate | Ruled out how |
|---|---|
| stale sweeper / workflow scheduler firing during tests | both are started in `services/api/src/index.ts` only; tests build the app from `app.ts` and never call them. Grepped both files. |
| asynchronous router mounting causing a missing route | every `app.use` in `app.ts` is synchronous; the only `await import` calls are inside request handlers, not at mount time |
| fire-and-forget audit **database** writes landing late | `services/api/src/helpers/audit.ts` is a synchronous `console.log` with no pool access and returns `void`. There is no audit DB write to land late. |
| positional mock queues as the *necessary* cause | the zero-`Once(` file above |

`--runInBand` remains **refuted** and should not be proposed again; this session's 3/6 is
consistent with the earlier 4/10.

### The open lead, and two competing explanations for it

One failure was captured in full:

```
● Shared knowledge stats routes › GET /shared-knowledge/stats returns 403 without user role
  Expected: 403
  Received: 404
```

A 404 where 403 was expected has **two** explanations and they are not equivalent:

1. **The handler ran.** `requireRole('user')` did not reject a role-less token, so
   per-request authorization state was wrong — an identity from another test. This is the
   more alarming reading.
2. **The request never reached this app.** Per the section above, `request(app)` creates a
   server per call and the suite makes thousands; a request landing on a different
   short-lived server gets Express's default 404 without any authorization involvement.

**The experiment that separates them is cheap and should be run first: capture the response
body of the failing 404.** Express's default 404 is HTML (`Cannot GET /…`); this route's own
404 would be JSON from the handler. One tells you the identity leaked; the other tells you
the request was misrouted. Reasoning further without that byte of evidence is guessing, and
explanation 2 is the more parsimonious of the two — it needs no new mechanism beyond one
already documented here.

### The lead was chased. Explanation 2 is DEAD, and the timer leak is measured

The discriminating experiment above was run: `http.ServerResponse.prototype.end` was wrapped
in a global setup file to capture every 404 body with the test that received it, then the
suite was looped until it failed with the instrumentation attached.

**470 404-responses captured across a failing run. 455 were handler-generated JSON. Exactly
15 were Express's default HTML — and every one of those came from `/nonexistent`, a test
that deliberately asserts a 404.**

So **no request was answered by an app that did not mount its route.** Explanation 2 —
requests landing on the wrong short-lived server, the theory in *What actually accumulates*
above — is not supported by measurement. That section should be read as a hypothesis that
has now failed a direct test, not as an established mechanism. The corollary is that
converting all 59 files to one-server-per-file, the fix that section proposes, would be a
large mechanical change aimed at something that is not happening.

**Explanation 1 also needs narrowing rather than accepting.** The failures are not all
404-shaped. Captured this session, one per failing run: `403 → 404`, `201 → 400`, and a
failure *inside* the SSE file itself. What they share is not a status code but a shape:
**the handler took a different branch than the test set up**, meaning it saw different data
than the test queued.

**The timer leak is real and now quantified.** A global wrapper on
`setInterval`/`setTimeout` recorded any timer still pending when the test that created it
ended. Six runs, **36 leaked timers, a consistent 6 per run**, and the sources are named:

| Count | Kind | Delay | Leaked by |
|---|---|---|---|
| 12 | timeout / interval | 50–4000ms | `GET /agents/:id/events T8: SSE inference poll events arrive after initial container event` |
| 6 | interval | 3000 | `SSE follow forwards a late-arriving event without reconnect` |
| 6 | interval | 3000 | `Chat SSE stream GET /chat/threads/:id/stream returns SSE headers and initial data` |
| 6 | timeout | 3000 | `Secrets vault inventory GET /admin/secrets/status returns vault status` |
| 6 | interval | 3000 | `no duplicate inference events between SSE backfill and first poll` |

These are the SSE poll and heartbeat intervals in `routes/agents.ts` and `routes/chat.ts`,
plus the abort timeout in `routes/secrets.ts:119`. They are cleared on `req.on('close')` in
production; under supertest the response ends without that always firing.

**But clearing them did not obviously fix the flake, and that is the next thing to settle.**
The instrumentation *also* cleared each leaked timer at the end of the test that created it
— so those six runs ran with the cross-test portion of the leak removed — and failures
still occurred at **2 of 6**, against 3/6 and 3/8 without it. Six runs cannot separate 2/6
from 3/6; this is suggestive, not conclusive. **Whoever picks this up should run that
comparison properly — the same clearing hook, twenty runs against twenty — before
concluding the timers are or are not the cause.** That is a cheap, decisive experiment and
it is the single highest-value next step.

If clearing timers does fix it, the fix is not a `beforeEach` added to sixty files: it is to
make the boundary incapable of holding the state, by clearing the interval in a `finally`
on the handler rather than only on `close`, so a response that ends without a close event
still tears its timers down.

### Environment note for whoever runs this next

`jest` will not run on Node 26 with the committed lockfile: `sharp` has no loadable
`darwin-arm64` binary and 40 of 59 suites fail at import, which looks exactly like a
catastrophic regression and is not one. `npm install --no-save --include=optional
--os=darwin --cpu=arm64 sharp` fixes it locally without touching the lockfile. CI runs
Node 20 and is unaffected.

## A correction to an earlier report

I first described this as "roughly one failure per run" and said it "reproduces on main".
The second part is true; the first overstated it — the measured rate is about 30% of runs.
My original evidence was also contaminated: I ran a "baseline" with `git stash`, which does
not stash untracked files, so the new test file I suspected was still present in the
control. I noticed that at the time and described it as "the cleanest control". It was the
opposite. The rate above comes from clean runs of unmodified `main`.
