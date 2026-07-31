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

### The twenty-against-twenty: clearing leaked timers is NOT the fix

Run because 2/6 against 3/6 separated nothing. **The result does not support the timer fix,
and the direction is against it.**

**Method**, stated so it can be criticised. Both arms ran **in the same session,
alternating** — observe, clear, observe, clear — rather than twenty of one then twenty of
the other, because machine load drifts over half an hour and a block design confounds that
drift with the treatment. Both arms loaded the *same* setup file with the *same* timer
wrapper, so instrumentation overhead is identical; the single variable was one `if`, whether
a leaked timer is cleared. Default worker regime, the same as every earlier measurement in
this document — jest 29.7.0, no `--randomize`, no explicit seed, no `--runInBand`.

| Pair | observe (no clearing) | clear (clearing) |
|---|---|---|
| 1 | FAIL | pass |
| 2 | pass | pass |
| 3 | pass | FAIL |
| 4 | pass | pass |
| 5 | pass | pass |
| 6 | pass | pass |
| 7 | pass | FAIL |
| 8 | pass | pass |
| 9 | pass | FAIL |
| 10 | pass | FAIL |
| 11 | pass | pass |
| 12 | pass | pass |
| 13 | pass | FAIL |
| 14 | pass | pass |
| 15 | pass | pass |
| 16 | FAIL | FAIL |
| 17 | pass | pass |
| 18 | pass | pass |
| 19 | pass | pass |
| 20 | FAIL | pass |

**Totals: observe 3/20 failed. clear 6/20 failed. Fisher exact two-sided p = 0.451.**

**Manipulation check:** both arms recorded **120 leaked timers over 20 runs, 6.00 per run,
identical** — confirming the wrapper behaved the same in both and that clearing was the only
difference.

#### What this settles, and what it does not

**Settled, and it needs no statistics: clearing leaked timers at the test boundary is not a
fix.** The treatment arm failed 6 times in 20 runs. A change that leaves a third of runs
failing has not fixed anything, whatever the p-value says. Do not adopt it.

**Not settled: whether clearing makes things worse.** 3/20 against 6/20 with p = 0.451
cannot separate the arms. It is tempting to read "clearing doubled the failures" — resist
it; that is exactly the over-reading this experiment was designed to avoid. Separating 15%
from 30% at 80% power needs roughly **120 runs per arm**, about eight hours of the machine.
Nobody should spend that to answer a question that does not change what we do next.

**A methodological limit that matters, and it is mine.** The hook cleared timers in
`afterEach` — *after* the test finished. The fix proposed below clears in a `finally` when
the handler completes, which is **earlier**, during the test. A timer that fires between
response-end and `afterEach` still polluted in the treatment arm and would not under the
real fix. So this experiment refutes *clearing at the test boundary*; it is a weaker test of
the handler-level fix, which is therefore **unproven rather than disproven**.

#### The fix shape, recorded because it is right even though it is not shipped

Not landing it: shipping a security-adjacent behaviour change on an experiment that trends
the wrong way would be a fix adopted for the effort spent on it. If someone tests it
properly and it works, this is the shape:

```ts
// in the SSE handlers: routes/agents.ts:1730, routes/chat.ts:1115/1118/1282/1295
const poll = setInterval(...);
try { /* stream */ } finally { clearInterval(poll); }   // not only req.on('close')
```

Clear the interval in a `finally` on the handler rather than only on `close`, so a response
that ends without a close event still tears its timers down. That removes the boundary's
ability to hold cross-test state instead of asking sixty test files to clean up after it —
which is the difference between fixing a design and hiding it. **It must ship with a test
that fails when the `finally` is removed**, or it is unverifiable.

#### The next hypothesis, which no amount of timer clearing would touch

Timers are not the only thing that outlives a response. **An unawaited promise is not a
timer**, so every experiment above leaves it untouched: a handler that calls the pool
without `await` finishes its response, the test asserts and ends, and the query resolves
into the next test. That fits every symptom recorded here — `403 → 404`, `201 → 400`,
`calls[1] undefined` — and it fits the zero-`Once(` file too, because a late call corrupts
`mock.calls` counts even when no queued value exists to steal.

The instrumentation for it is per-file rather than global, which is why it was not done
here: the pool mock is created inside each file's `jest.mock` factory, so a global hook
cannot see it. Wrapping the mock in **one** representative failing file and logging every
query with `expect.getState().currentTestName` at call time would show a query arriving
under a test that did not make it. That is the next experiment.

### Environment note for whoever runs this next

`jest` will not run on Node 26 with the committed lockfile: `sharp` has no loadable
`darwin-arm64` binary and 40 of 59 suites fail at import, which looks exactly like a
catastrophic regression and is not one. `npm install --no-save --include=optional
--os=darwin --cpu=arm64 sharp` fixes it locally without touching the lockfile. CI runs
Node 20 and is unaffected.

### Ruled out: unawaited promises, by reachability

The hypothesis recorded above as "the next experiment" was that an unawaited promise — which
is not a timer, so no timer clearing touches it — resolves into the following test. It fits
every symptom here, including the zero-`Once(` file, because a late call corrupts
`mock.calls` counts even where no queued value exists to steal. It was the best remaining
theory.

**It does not survive inspection, and the reasoning is the useful part.**

There are **344 `pool.query` / `getPool().query` call sites** in non-test code. **18** have
no `await` on the same line. On reading them, all but two are members of
`await Promise.all([...])` — properly awaited, just on a different line. Examples:
`routes/agents.ts:2234`, `routes/skills.ts:96`, `routes/profile.ts:40`.

**Two are genuinely fire-and-forget:** `routes/workflows.ts:291` and `routes/workflows.ts:501`.
Both are `pool.query(...)` inside a `.catch()` attached to a dispatch promise, neither
awaited, both writing `workflow_runs` on failure. They are real instances of the pattern and
worth fixing on their own merits.

**But neither can be the mechanism, because of where they are.** Both run only when a
*workflow dispatch fails*, on the workflow routes. The measured victims are elsewhere:
shared-knowledge, model-policies, agents, container-profiles, skills, user-models,
eligible-models, ownership-boundary. A failing workflow dispatch is not on any of those code
paths, so it cannot be the thing corrupting their mocks. Reachability kills it, not
statistics — which is why this entry is inspection rather than another twenty runs.

### The handler-level fix: the leak is real, the fix is not the one proposed, and it is still not a flake fix

Resolved 2026-07-31. Three separate results, and they do not all point the same way.

**1. The leak is real and reachable.** `GET /chat/threads/:id/stream` registered
`req.on('close')` *after* `await poll()`, and that was its **only** cleanup path. A client
that goes away during the backfill query — an ordinary page navigation — makes Node emit
`'close'` with no listener attached. Events are not replayed, so the listener registered a
moment later never fired and both intervals ran for the lifetime of the process.
`GET /threads/:id/events` had the same shape. Proven by a test that fails against the old
code with two leaked timers and passes against the new one.

**2. The `finally` fix proposed in this document was WRONG, and would have been a
regression.** These handlers return while the stream is still open. Clearing the intervals
in a `finally` on the handler would have cleared them the instant setup finished, killing
the poll loop and the heartbeat — a broken feature shipped in the name of a fixed leak.
The correct fix is to register cleanup *before* the awaits and refuse to create timers for
a client that has already gone. Anyone reading the earlier proposal should stop there.

**3. It is still not a fix for the flake, and this closes the timer line for good.** Both
leaked intervals begin with `if (res.writableEnded || res.destroyed) return;`, and so does
`poll`. A leaked interval therefore performs **no database work at all** — it cannot
consume a queued mock value or add a `mock.calls` entry. That is the mechanism the timer
hypothesis needed, and the guard was there the whole time. It is consistent with the
20-against-20 result rather than explained away by it.

So the timer hypothesis is dead twice over: measured (6/20 with clearing) and now by
inspection (a leaked timer cannot reach the pool). **The flake rate was not measured after
this fix and no claim is made about it.** If someone measures it later and it moves, that
is a surprise to investigate, not a prediction confirmed.

## Where this leaves it: four hypotheses dead, the defect alive

| Hypothesis | Killed by |
|---|---|
| positional `mockResolvedValueOnce` queues | a file with **zero** `Once(` calls that flakes anyway |
| requests landing on the wrong supertest server | **455 of 470** captured 404s were handler JSON; all 15 HTML ones came from a test that asserts 404 |
| leaked timers crossing the test boundary | clearing them still failed **6/20** |
| unawaited promises | the only two genuine ones are unreachable from the affected paths |

That is a real result and it is worth more than a fifth theory picked because the lane was
free. **No further hypothesis is currently worth testing.** If someone forms one, it should be
written here before it is worked on, so the next dead end costs one session rather than two.

**The one candidate that is untested rather than disproven** is the handler-level fix: clear
the interval in a `finally` on the handler rather than only on `req.on('close')`, so a
response that ends without a close event still tears its timers down. The 6/20 experiment
cleared at the *test* boundary, which is later than this would, so it is a weaker test of it.
**It ships with a test that fails when the `finally` is removed, or it does not ship** —
otherwise it is an unverifiable change to a suite that cannot verify anything.

**Operational consequence, in one line: a green run of the api suite is not evidence that a
change is safe, and should not be cited as one until this is fixed.**

## A correction to an earlier report

I first described this as "roughly one failure per run" and said it "reproduces on main".
The second part is true; the first overstated it — the measured rate is about 30% of runs.
My original evidence was also contaminated: I ran a "baseline" with `git stash`, which does
not stash untracked files, so the new test file I suspected was still present in the
control. I noticed that at the time and described it as "the cleanest control". It was the
opposite. The rate above comes from clean runs of unmodified `main`.
