# The api suite is flaky, why, and what a green CI run is worth

**Status, as this line was last edited (2026-07-30):** diagnosed, **not fixed**. That
sentence is now stale relative to the tree — read the round eighteen addendum at the end
of this file for what's actually true as of 2026-08-05, rather than trusting this line.
Left as originally written, not rewritten to match later events, per this repo's own
decision-records-preserve rule.

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

### Measured after the SSE leak was fixed: it did not help

The leak fixed in #76 was real, reachable and worth fixing. It made no difference to this
defect, and that was measured rather than assumed in either direction — no improvement was
claimed in advance, and none is claimed now.

Twenty runs of `main` with the fix in the tree, same protocol as the 20-against-20: plain
`npx jest`, default workers, jest 29.7.0, no `--randomize`, no explicit seed, no
`--runInBand`. Per-run outcomes, so the next reader can recompute rather than trust a total:

| Run | Result | First failing test |
|---|---|---|
| 1 | FAIL | Container Profiles routes › POST /container-profiles |
| 2 | pass | — |
| 3 | pass | — |
| 4 | pass | — |
| 5 | pass | — |
| 6 | FAIL | Chat callback › POST /internal/chat/callback tags el |
| 7 | pass | — |
| 8 | FAIL | Usage query routes › GET /usage default from-date us |
| 9 | pass | — |
| 10 | pass | — |
| 11 | pass | — |
| 12 | pass | — |
| 13 | FAIL | Tasks routes › GET /tasks › filters out tasks for ag |
| 14 | pass | — |
| 15 | pass | — |
| 16 | pass | — |
| 17 | pass | — |
| 18 | FAIL | Provider Connections Health › health stats are owner |
| 19 | FAIL | Skill CRUD routes › Scope-change safety contract › a |
| 20 | FAIL | User Models CRUD › POST /user-models creates model |

**7 of 20 failed — 35%.** Against every baseline in this document:

| Baseline (same regime) | Rate | Fisher two-sided p |
|---|---|---|
| observe arm, 3/20 | 15% | 0.273 |
| plain default, 3/8 | 38% | 1.000 |
| pooled default-regime, 6/28 | 21% | 0.339 |
| clear arm, 6/20 | 30% | 1.000 |

**Nothing moved.** If the true rate were still the pooled 21%, the chance of 7 or more
failures in 20 runs is **0.117** — an ordinary outcome, not a surprise. Nor is 7/20 evidence
of *worsening*: none of those comparisons separates, and the two closest baselines land at
p = 1.000.

**Be as sceptical of the shape of this result as of a clean one.** Had it come out 0/20 that
would have been suggestive but not conclusive: P(0 failures in 20) is 0.008 at a 21% rate
and 0.0008 at 30%, so twenty green runs would have been strong evidence of a real change
while remaining consistent with a flake that happened to be quiet. The distinction did not
arise, because the result was not clean.

Victims are again spread across files and different every run: container profiles, chat
callback, usage, tasks, provider connections, skills, user models — the same pattern as
every earlier measurement.

**This was the most plausible remaining cause, and it is now excluded by experiment as well
as by inspection.** The inspection argument — a leaked interval guards on
`res.writableEnded || res.destroyed` and therefore performs no database work — predicted
exactly this. The prediction was made before the measurement and the measurement agreed
with it.

Measured on `main` plus one unrelated local commit touching `compose/local.yml`, a runbook
and a bats test, none of which the api suite reads. The fix was confirmed present in the
measured tree: two `req.on('close', cleanup)` sites, two early-return guards.

### Isolation instead of mechanism: the first localisation, and why the bisection stopped

Measured 2026-07-31. Every previous hypothesis was a theory about a *mechanism*; this
attacked it by *interaction* instead — find which files have to run together, and let that
point at the cause. It produced the first real localisation, and it did **not** produce a
pair.

**How the file set and order were pinned**, because otherwise this chases a moving target:
`npx jest --runInBand --runTestsByPath <explicit list>`, with the list built as
`ls src/__tests__/*.test.ts | sort` — alphabetical, so it is reproducible — and
`--runInBand` so a single process runs them in exactly that sequence and no worker
scheduling can reorder anything.

| Set | Files | Result |
|---|---|---|
| victim alone (`routes-container-profiles`) | 1 | **0/20** |
| A1 — `akm-proxy-errors` … `model-type-detect` | 14 | **0/10** |
| A2 — `openapi-model-aliases` … `routes-chat` | 15 | **2/20** |
| **half A** — `akm-proxy-errors` … `routes-chat` | 29 | **4/10** |
| **half B** — `routes-container-profiles` … `tool-installer` | 29 | **0/10** |
| full set, pinned | 58 | 1/6 |

**Three things this establishes.**

1. **The fault is cross-file, confirmed rather than assumed.** The victim that fails in a
   full run passes **0 times in 20** alone.
2. **Half B is quiet.** Twenty-nine files, zero failures in ten runs — including the very
   file that was the victim in the full run. Whatever interacts is in half A's region.
3. **It is not a pair, and the arithmetic is the reason.** A1 scores 0/10 and A2 scores
   2/20, but A1+A2 together score **4/10** — worse than either part. Combining a 0% set
   with a 10% set produces 40%. A single file poisoning another would keep the rate roughly
   constant when unrelated files are removed; instead the rate *falls* as the set shrinks
   and *rises* when the halves are recombined. That is the signature of an interaction
   needing a quantity of participants, not two named files.

The superadditivity is suggestive rather than proven at this sample size: A 4/10 against
A2 2/20 gives Fisher p = 0.141, and against A1 0/10 gives p = 0.087. Both point the same
way and neither clears 0.05. Said plainly: the pattern is consistent and the sample is too
small to call it significant.

**Why the bisection stopped here, with the numbers.** Continuing means calling subsets
"negative", and a negative is only as good as the run count behind it. From A2's measured
10%, at 13s per run:

| If the true rate is | Runs per negative for 95% confidence | Per candidate | Three more levels |
|---|---|---|---|
| 10% | 29 | 6.3 min | **~38 min** |
| 5% | 59 | 12.8 min | ~77 min |
| 2.5% | 119 | 25.8 min | ~155 min |

The rate has already fallen 40% → 10% at one split, so the 5% and 2.5% rows are the likely
ones rather than the optimistic first. That is one to two and a half hours of machine time
for calls that would still be probabilistic — and the superadditive pattern says the thing
being searched for, a minimal failing pair, **probably does not exist**. Grinding toward an
artefact the evidence argues against is the wrong trade today.

**What the next person should do instead**, and it is cheap: start from half A's 29 files at
40%, which is a *higher* rate than the full suite and a third of the runtime. That is the
best reproduction harness this defect has ever had. Test whether the rate tracks the
*number* of concurrent supertest servers rather than any particular file — half A is
route-test heavy and half B is not — because "needs N interacting files" and "needs N
servers" are the same hypothesis stated two ways, and the second one is measurable.

### Leave-one-out from half A, and a correction to my own claim

Measured 2026-07-31, ~16 minutes of machine time against a 40-minute budget. Stopped early
because the signal strength makes further search unproductive, not because time ran out.

**Ordering by suspicion, and why.** Files were ranked by descending `request(` count with
SSE-touching files promoted, on the reasoning that every surviving cross-file candidate needs
either a supertest server (accumulation) or a timer, and a file making zero requests can do
neither. `routes-chat` led on every metric — 74 requests, 82 tests, 467 `Once(` calls, and it
touches SSE.

**Every configuration measured, so a later session resumes from the table rather than
restarting.** All runs `--runInBand --runTestsByPath` with an explicit alphabetical list.

| Configuration | Files | Failures | ~s/run |
|---|---|---|---|
| full set, pinned | 58 | 1/6 | 19 |
| full set, default workers (earlier) | 58 | 7/20 | 4 |
| **half A** — `akm-proxy-errors` … `routes-chat` | 29 | **4/10, then 3/20 → pooled 7/30** | 15 |
| half B — `routes-container-profiles` … `tool-installer` | 30 | 0/10 | 9 |
| A1 — first 14 of A | 14 | 0/10 | 3 |
| A2 — last 15 of A | 15 | 2/20 | 13 |
| R15 — A's 14 request-making files + auth-boundary | 15 | **0/10** | 15 |
| U14 — A's 14 zero-request files | 14 | **0/10** | 2 |
| A minus `routes-chat` | 28 | 2/10 | 14 |
| A minus `routes-agents-events` | 28 | 1/10 | 6 |
| A minus `routes-agents` | 28 | 1/10 | 13 |
| A minus 9 unit-only files | 20 | **0/10** | 13 |
| victim alone (`routes-container-profiles`) | 1 | 0/20 | 2 |

#### A correction: half A is not a 40% harness, and I over-read n=10

The previous entry called half A "the best reproduction harness this defect has ever had" on
the strength of 4/10. Twenty further runs gave **3/20**. Pooled, half A is **7/30 ≈ 23%** —
indistinguishable from the full suite. The 4/10 was a small-sample draw and I presented it as
a property. **There is no better harness than the full suite**, and the recommendation built
on that claim was wrong.

#### Hypothesis six is dead: it is not the number of supertest servers

That was the next step this document recommended, and it is now measured and refuted by a
free observation — no runs required. **Half B has more of everything and never fails:**

| | half A (fails ~23%) | half B (0/10) |
|---|---|---|
| files | 29 | 30 |
| request-making files | 14 | **26** |
| total `request(` calls | 192 | **417** |
| total tests | 301 | **473** |
| SSE-touching files | 2 | 2 |

Two-and-a-bit times the requests, nearly twice the request-making files, 1.6× the tests — and
zero failures in ten runs. Whatever drives this, it is **not** the count of servers, requests
or tests. That kills the hypothesis this document was pointing the next person at.

#### No single file is necessary, and every subset is quiet

Removing `routes-chat`, `routes-agents-events` or `routes-agents` individually leaves it
reproducing. Meanwhile *every* subset tried — A1, A2, R15, U14, A-minus-9-unit-files — scores
0/10 or near it while the 29-file whole scores ~23%. The shape is: many participants needed,
no one of them necessary, so several different combinations are probably sufficient.

**That makes minimal-set search combinatorial rather than a bisection**, and at this signal
strength it is not affordable. At 23% and ~14s per run, a 95%-confidence negative needs 12
runs ≈ 3 minutes; 29 single-file leave-one-outs is ~87 minutes and would only test the
necessity of single files — a question the data has already answered *no* to. Pairs and
triples multiply from there.

#### Where the search actually got to

Localised to half A's 29 files at ~23%, with no necessary member and no reproducing subset.
That is a narrowing over "somewhere in 58 files", and it is also a boundary: **isolation has
now produced everything it can cheaply produce.** Six honest dead ends and one real bug.

What is *not* yet tried, and is cheap when someone next has budget: hold the file **count**
constant and vary composition — for example 29 files drawn only from B, or 15 from A plus 14
from B — to test whether membership in A's region matters at all, or whether some
still-unidentified property tracks it. That is a different question from "which file", and
the table above is the baseline to compare against.

## The standing hypothesis — untested reasoning, not a finding

**Read this before forming a seventh theory.** It is the shape of cause that remains
consistent with every measurement in this document. It is reasoning, explicitly labelled as
such: nothing below has been tested, and it should not be cited as a finding.

**The carrier must be per-process mutable state, written at an unpredictable moment, and
read as a branch condition by a later file's handler.**

Each clause is forced by a measurement rather than chosen:

- **Per-process, not per-file.** Jest gives every file a fresh module registry, so a
  module-level singleton cannot cross a file boundary. Yet the fault is cross-file — the
  victim passes 0/20 alone. So the carrier lives *outside* the registry: `process.env`,
  something on `globalThis`, the filesystem, or an object captured by a callback that is
  still running.
- **Written at an unpredictable moment.** The same pinned file list in the same order under
  `--runInBand` sometimes passes and sometimes fails. Order is therefore not the variable;
  *when* the write lands is.
- **Read as a branch condition.** Every observed symptom is a handler taking a different
  path — `403 → 404`, `201 → 400`, `501 → 404`, `calls[1] undefined` — not a crash, not a
  timeout, not a connection error. Something the handler consults was different.
- **Supplied by several files, none of them necessary.** Removing `routes-chat`,
  `routes-agents-events` or `routes-agents` individually still reproduces, so more than one
  file can supply the ingredient.
- **Requiring enough participants to collide.** Every subset tried is quiet while the
  29-file whole runs at ~23%, which is what a collision between an unpredictable write and a
  later read looks like when both become likely only at scale.

**One measurement actively supports it.** `--runInBand` was *slightly worse* than default
workers (4/10 against 3/10). With one process every file shares the store; with workers only
about six do. A per-process carrier predicts exactly that ordering, and no
mechanism-in-the-code theory does.

**And the honest limit: this does not explain why half A fails and half B does not.** Every
quantity measured is *higher* in the silent half — 26 request-making files against 14, 417
`request(` calls against 192, 473 tests against 301, and 47 `process.env` assignments against
36. So whatever discriminates A from B is a **specific key or a specific pair of behaviours,
not a volume**. Any seventh theory has to account for that inversion, which is where the
previous six each failed.

### What to do first, and why it is cheap

**Audit the carrier deterministically instead of hunting the failure probabilistically.**
This is the part that makes it affordable: it needs no reproduction at all.

Snapshot `process.env` and the enumerable keys of `globalThis` after every test file in a
worker, diff each against the snapshot taken before it, and flag any key that (a) changed and
was not restored, and (b) is read as a branch condition in `src/routes/` or
`src/middleware/`. That runs once, in a single suite pass, and either produces a list of
suspects or rules the whole class out. It converts a 23%-probability hunt into a
deterministic check — which is what every experiment in this document has lacked.

The obvious candidate is `process.env.DATABASE_URL`: read **19 times** in handler code as
`if (!process.env.DATABASE_URL) → 503`, assigned 21 times and deleted 33 times across half
A's files alone. **But note the caveat, because it matters:** its absence produces **503**,
and 503 is *not* among the observed symptoms. So if the carrier is `process.env`, expect a
different key — and the audit finds it without anyone having to guess which.

## Status: the flake investigation stops here

Taken from "about a third of runs fail, cause unknown" to: a localised region (half A's 29
files), a measured rate (~23% there, 7/20 on the full suite), six hypotheses eliminated with
the numbers that eliminated each, a thirteen-row table of every configuration tried, one real
bug found and fixed along the way, and the standing hypothesis above.

**Nobody should restart from zero.** The per-configuration table is the resume point, and the
deterministic audit is the next step. Further bisection is expensive and, on this evidence,
aimed at a minimal pair that probably does not exist.

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

**That last candidate is now closed too.** The handler-level fix shipped in #76 — not as a
`finally`, which would have been a regression, but by registering cleanup before the awaits
— with a test that fails when it is removed. Twenty runs afterwards measured **7/20**. So
the leak was real, the fix was right, and it did not help this defect. **There is no
outstanding hypothesis.**

**Operational consequence, in one line: a green run of the api suite is not evidence that a
change is safe, and should not be cited as one until this is fixed.**

Re-checked against measurement on 2026-07-31 and unchanged: 7 of 20 runs of current `main`
fail. The sentence is not stale, and it is not there for lack of looking.

## A correction to an earlier report

I first described this as "roughly one failure per run" and said it "reproduces on main".
The second part is true; the first overstated it — the measured rate is about 30% of runs.
My original evidence was also contaminated: I ran a "baseline" with `git stash`, which does
not stash untracked files, so the new test file I suspected was still present in the
control. I noticed that at the time and described it as "the cleanest control". It was the
opposite. The rate above comes from clean runs of unmodified `main`.

---

# Round two: the carrier audit was run, and it eliminates the standing hypothesis's named candidates

`Measured 2026-08-01.` The previous section ended by proposing a deterministic carrier
audit as the next step. **It was built, positive-controlled, and run.** This section records
what it found. Nothing here re-derives an earlier result.

## The audit

`services/api/jest.audit.js`, enabled with `CARRIER_AUDIT=1` and **off by default** so it
changes nothing about how CI runs the suite. Per test file it snapshots `process.env` and
the enumerable keys of `globalThis` before, diffs after, and appends any key that changed
and was not restored.

**Positive-controlled before being believed.** A test that deliberately leaks
`process.env.ZZ_CONTROL_LEAK` and a `globalThis` key is caught, naming both. A check that
has never been seen to fail is not evidence, and this one has been seen to fail.

## Result: `process.env` is not the carrier, and neither is `globalThis`

**20 full-suite runs with the audit enabled. 5 failed, 15 passed — a 25% failure rate**,
consistent with the 7/20 and ~23% recorded earlier, so the flake was reproducing normally
throughout.

**Across all 20 runs, including all 5 failing ones, the audit reported exactly one line per
run**, always the same:

```
file: src/__tests__/model-router-delegation.test.ts
env: []
globals: ['__extends','__assign','__rest','__decorate','__param','__esDecorate']
```

Those are TypeScript's `tslib` emit helpers — added once, read by nobody as a branch
condition. **Zero unrestored `process.env` changes across 61 files, on failing and passing
runs alike.**

The standing hypothesis named `process.env`, `globalThis`, the filesystem, or a captured
object as the carrier. **The first two are now eliminated by measurement**, on failing runs
specifically. `DATABASE_URL` — the document's "obvious candidate" — never leaks.

## The symptom set is wider than recorded, and that contradicts the standing hypothesis

The standing hypothesis states its symptoms are *"a handler taking a different path — 403 →
404, 201 → 400, 501 → 404 … **not a crash, not a timeout**, not a connection error."*

Classifying all five failures from the 20 runs:

| Run | Failing test | Symptom |
|---|---|---|
| 2 | `routes-chat` — GET /chat/threads … agent info | **`Exceeded timeout of 5000 ms`** |
| 5 | `routes-agents-model-ownership` — A10 non-owned model | Expected `400`, received **`404`** |
| 11 | `routes-shared-knowledge` — POST collections | Expected `201`, received **`404`** |
| 16 | `routes-notifications` — filters unread only | (assertion, not captured) |
| 18 | `routes-agents` — S1-S4 network resolution | Expected `200`, received **`404`** |

**A timeout is in the set.** So the premise "not a timeout" is false, and any theory built on
symptoms being purely logical is built on an incomplete list.

**404 dominates** — three of the four classified failures. These files mock the pool with a
module-level `jest.fn()` and queue results with `mockResolvedValueOnce`. Both observed
symptoms fall out of one mechanism: **if anything drains that queue unexpectedly, a handler
reads the wrong row set and returns 404; if the queue empties, the handler awaits a promise
that never resolves and the test times out at 5s.** That is a single explanation for two
symptoms which the earlier write-up treated as one symptom class.

**This is a lead, not a finding.** Nothing here proves an extra caller exists.

## A measurement that did NOT hold up, recorded so nobody repeats it

The audit was extended to census `process._getActiveHandles()` per file. Across 12 further
runs it reported every request-making file "leaking" **2 handles per run** (`routes-agents-events`,
3), of types `Server`, `Socket`, `Pipe` — which looked like unclosed supertest servers
accumulating, and would have explained the resource-pressure gradient neatly.

**It does not survive its own control.** Running `routes-notifications.test.ts` **alone**
leaks **0** handles. A file that leaks 2 in a full run and 0 in isolation is more likely
measuring jest's own worker plumbing — IPC pipes and the reporter's sockets — than anything
the application did. **The census is not trustworthy as written and the "unclosed supertest
server" theory is NOT supported.** It is written down because it is an attractive wrong
answer and the next person will otherwise find it again.

## Where this leaves the search space

Eliminated, by measurement rather than argument:

- `process.env` as the carrier — 20 runs, 5 failures, deterministic audit, positive-controlled
- `globalThis` as the carrier — same runs; only `tslib` helpers ever appear
- "symptoms are purely logical" — a 5s timeout is in the set

Still open, and now the narrowest description available:

- **The carrier is per-process and is neither `process.env` nor `globalThis`.** The remaining
  candidates from the standing hypothesis are the filesystem and an object captured by a
  still-running callback. The second fits the mock-queue mechanism above.
- **The specific question worth attacking next:** instrument the shared `mockQuery` in one
  half-A file to record, per test, calls made against `Once` values queued, and flag any test
  where the counts disagree. That is deterministic in the same way this audit was, and it
  targets the object the 404s and the timeout both point at.

## Status: still unfixed

**The flake is not fixed and the cause is not known.** A green run of this suite is still not
evidence. Nothing was disabled, retried or quarantined — the rate is unchanged at 25% (5/20)
because nothing was done to change it, and converting a known flake into a silent one would
be worse than leaving it.

---

# Round three, 2026-08-03: the hypothesis's one supporting measurement does not replicate

**210 runs.** Attacking the standing hypothesis rather than confirming it, as asked.

## The arithmetic first, because a handful of green runs proves nothing

| Arm | Files | Result | 95% CI |
|---|---|---|---|
| half A, `--runInBand`, alphabetical | 29 | **3/40 = 7.5%** | [0, 15.7] |
| half A, `--runInBand`, **reversed** | 29 | **2/40 = 5.0%** | [0, 11.8] |
| half A, **default workers** | 29 | **6/40 = 15.0%** | [3.9, 26.1] |
| the three victims, each alone | 1 | **0/90 = 0%** | — |

Harness committed as `services/api/flake-harness.sh`; it records pass/fail, the
failing suite and a classified symptom per run, and does not retry anything.

**Note the local rate is lower than CI's 25%.** 7.5% here against 25% there, same
files. Whatever modulates it is environmental, so a rate measured on one machine
should not be quoted as the rate.

## What this falsifies

**The single measurement the standing hypothesis called its active support does
not replicate, and inverts.** That section says:

> One measurement actively supports it. `--runInBand` was *slightly worse* than
> default workers (4/10 against 3/10) … A per-process carrier predicts exactly
> that ordering, and no mechanism-in-the-code theory does.

Measured again at four times the sample: **workers 6/40 (15.0%) against runInBand
3/40 (7.5%)** — the opposite ordering. The intervals overlap, so this does not
prove workers is worse; it does establish that *runInBand is not worse*, which is
the claim the hypothesis rested on. The original 4/10-vs-3/10 was two failures'
difference at n=10 and should not have carried argumentative weight.

**Order is not the variable, now at n=80.** Reversing all 29 files end to end
moved 7.5% to 5.0%, well inside noise. The prior claim was right and is now
measured properly.

**Cross-file is confirmed for three new victims.** `platform-eligibility`,
`platform-models` and `routes-agents-events` each failed in a full half-A run and
each passed **30/30 alone**. 0/90 solo against 11 failures in company.

## What the failures actually look like now

| Arm | Victim | Symptom |
|---|---|---|
| runInBand | `platform-eligibility` | 200 → **501** |
| runInBand | `routes-agents-events` | 409 → **401** |
| runInBand | `platform-models` | 200 → **404** |
| reversed | `routes-agents-events` | 200 → **501** |
| reversed | `routes-agents` | 200 → **401** |
| workers | `routes-agents-events` ×4 | OTHER, 200→**400**, **TIMEOUT**, 200→**404** |
| workers | `routes-agents-policy` | 200 → **404** |
| workers | `routes-agents` | 200 → **501** |

**The symptom set is now six wide** — 400, 401, 404, 501, timeout, and an
unclassified assertion. `401` and `400` are new to this record. Any theory
requiring a single logical carrier has to explain an authentication failure and a
timeout in the same set.

## The strongest signal is not logical at all

**`routes-agents-events` is 6 of 11 failures**, and its duration is wildly
unstable: 8.8s and 8.8s under runInBand, then **11.5s, 12.6s, 12.9s and 83.2s**
under workers — in a half that completes in ~11s in total. An 83-second file is
not a branch condition being read differently. It is a file that could not get
what it needed.

Taken with workers failing at twice the runInBand rate, the shape that fits is
**contention, not carriage**: more concurrency, more failures, concentrated in the
one file that does the most asynchronous work. That is the opposite of the
standing hypothesis's direction, which predicts sharing (runInBand) is worse.

**This is a lead, not a finding.** Nothing here identifies the resource.

## Where the search space now stands

Eliminated by measurement, cumulative:

- `process.env` and `globalThis` as carriers (round two, positive-controlled)
- "symptoms are purely logical" — timeout, and now 401/400, are in the set
- **order-dependence** — n=80, forward against reversed, no effect
- **the runInBand-worse-than-workers asymmetry** — does not replicate at n=80

Still open, narrowed:

- The fault is **cross-file** and needs company: 0/90 solo, 11/120 in half A.
- It is **not order-sensitive**, so *when* something happens matters more than
  *what runs before what* — consistent with the record's earlier reasoning.
- The next thing worth attacking is **why `routes-agents-events` takes between
  8.8 and 83 seconds**, since that variance is the largest unexplained quantity in
  this document and it sits on the file that fails most. Instrument its
  asynchronous work — open handles, pending supertest requests, unresolved
  promises — per test rather than per file.

**Nothing was disabled, retried or quarantined.** The rate is unchanged because
nothing was done to change it.

---

# Round four, 2026-08-03: contention-as-starvation is eliminated, and one stated mechanism is false

**20 runs of half A, default workers. 2 failed — 10%.** The flake reproduced normally;
nothing was skipped, retried, reordered or quarantined, and the rate is unchanged because
nothing was done to change it.

Round three's closing instruction was to instrument `routes-agents-events`'s asynchronous
work, because its 8.8s-to-83.2s variance was the largest unexplained quantity here. That was
done, and it answers a question the record could not previously ask.

## The instrument, and the control that caught it lying

"Contention" has two mechanisms that look identical from outside — a slow test, then a
timeout or a wrong status — and have opposite fixes:

- **STARVED** — the process has work and cannot get CPU. The loop is blocked, timers fire
  late, a 5s jest timeout expires while the callback that would satisfy it waits in the queue.
- **WAITING** — the process is idle on I/O or a timer that never comes. The loop is free.

`services/api/jest.loopdelay.js` (`LOOP_AUDIT=1`, off by default) records per test:
duration, and `monitorEventLoopDelay`'s max/mean/p99. High delay means starved; low delay
across a long test means waiting.

**Its first version was wrong and its own positive control caught it.** A deliberate 400ms
block was reported as **0.0ms**, because the histogram is fed by a libuv timer that cannot
fire while the loop is blocked — the sample only lands on the next turn, and the audit read
it synchronously. After yielding 20ms before the read:

```
CONTROL=block   tests: 11 | loopMax median 401.6ms, worst 404.5ms | starvedPct>50%: 11/11
CONTROL=wait    tests: 11 | loopMax median  12.1ms, worst  26.2ms | starvedPct>50%:  0/11
```

Blocking is detected; an identical duration spent *waiting* is not flagged. Only then was
it believed.

## Result: the failure was not starved

6,020 test executions captured. The two failures were
`routes-agents › POST /agents with valid container_profile_id persists it` (timeout) and
`docs.test.ts › G1: POST /user-models without connection_id` (**expected 400, received 501**).

```
     ms  loopMax  starved%  test
   5003     36.5       0.7  routes-agents :: POST /agents with valid container_profile_id
```

**The one execution that hit the 5000ms ceiling ran with a free event loop** — 36.5ms of
delay across 5 seconds, 0.7%. It was not competing for CPU. It was waiting for a response
that never came.

The same holds for every slow execution:

```
  durations vs jest's 5000ms ceiling:   <1s: 5978 | 1-3s: 1 | 3-4s: 20 | 4-4.5s: 20 | >=5s: 1
  executions within 1.5s of the timeout: 40
    their loop delay: median 34.5ms, worst 129.9ms
```

Blocking does happen — 12 of the 66 executions slower than 500ms were >50% blocked, the
worst being 835.7ms in an 842ms `routes-agents-skill` test — **but never on the path that
failed.**

**So contention-in-the-sense-of-CPU-starvation is eliminated as the mechanism of the
timeout.** The shape round three read as "contention" is real, and it is *waiting*.

## A structural fragility, measured

Forty executions sit between 3s and 4.5s against a **5000ms** ceiling. They are the SSE poll
tests, and the cause is in production code, not the test:

```
services/api/src/routes/agents.ts:1729:  const INFERENCE_POLL_MS = 3000;
```

A test that must observe one poll cannot finish in under 3s, and lands near 4s. **The margin
to jest's default timeout is about one second.** That is why `routes-agents-events` is the
most frequent victim and why TIMEOUT is in the symptom set — no carrier required, only a
delay of more than a second from any source.

## A mechanism this document asserts, which is false

Round two states:

> if the queue empties, the handler awaits a promise that never resolves and the test times
> out at 5s

**A drained `mockResolvedValueOnce` queue does not return a pending promise. It returns
`undefined`:**

```
  1st call: object
  2nd call (queue drained) returns: undefined
```

`await undefined` resolves immediately, so that sentence's mechanism cannot produce a hang.

**But the conclusion survives on a different mechanism, and it was tested rather than
reasoned.** The handler then reads `.rows` off `undefined` and throws — and **Express 4.22.1
does not catch a rejection from an async handler**, so no response is ever sent:

```
  /awaited     -> HUNG (no response after 2004ms)
  /unawaited   -> HUNG (no response after 2002ms)
```

A drained queue therefore *does* hang the request, by throwing into a void rather than by
awaiting forever. That matches the observed failure exactly: `await request(app)` in a test
queueing four `Once` values, 5003ms, event loop free.

## Where this leaves the search space

Eliminated by measurement, cumulative:

- `process.env` and `globalThis` as carriers (round two, positive-controlled)
- "symptoms are purely logical" — timeout, 401 and 400 are in the set
- order-dependence, n=80
- the runInBand-worse-than-workers asymmetry, n=80
- **CPU starvation as the timeout mechanism** — free loop during the only ≥5s execution
- **"drained queue → promise never resolves"** — a drained queue returns `undefined`

Still open, and now stated mechanically rather than as a mood:

1. **What drains the queue.** The hang is now explained end to end *given* a drained queue.
   What is not explained is why the queue is out of step. Round one's "extra caller" lead is
   the live one, and it now has a confirmed downstream mechanism instead of a guessed one.
   Note the constraint that killed it before still stands: a file with **zero** `Once(` calls
   flakes too, so this cannot be the whole defect — it is the explanation of the TIMEOUT
   class, not of the 501/401/400 class.
2. **The one-second margin.** Independent of any carrier, `INFERENCE_POLL_MS = 3000` against
   a 5000ms timeout means any delay over ~1s becomes a failure. This is worth fixing on its
   own merits, and it is a **fragility, not the cause** — the 501/400/401 failures have
   nothing to do with it.

**The next instrument** follows round two's own suggestion, now better targeted: wrap
`mockQuery` in the affected files to record, per test, calls made against `Once` values
queued, and flag any test where the counts disagree. The mechanism above says a mismatch
must precede every timeout; if a run times out with the counts in agreement, that kills this
lead outright.

**Nothing was disabled, retried or quarantined.**

---

# Round five, 2026-08-03: the queue lead is refuted

**15 runs of half A, 1 failure. 615 test executions with per-test queue accounting.**
Nothing skipped, retried, reordered or quarantined.

Round four closed by naming the next instrument and, importantly, the condition that would
kill the lead: *count calls made against `Once` values queued, per test; a timeout with the
counts in agreement refutes this outright.* The instrument was built. **The lead is dead —
on stronger evidence than the condition asked for.**

## The result

| | executions | with a DRAINED queue |
|---|---|---|
| the 14 green runs | 574 | **280 (49%)** |
| the 1 failing run | 41 | **20 (49%)** |
| total | 615 | 300 (49%) |

**A drained queue is the normal, everyday state of this suite.** Half of all test executions
make more calls than they queued `Once` values for, on runs that pass. Examples from a fully
green run, cross-checked by hand against the source:

```
DRAINED: 2 calls vs 1 queued — POST /agents creates agent with user role
DRAINED: 2 calls vs 1 queued — DELETE /agents/:id works for admin
DRAINED: 9 calls vs 1 queued — POST /agents/:id/start starts agent
```

The rate is **identical to the percentage point** on passing and failing runs. It has no
discriminating power whatsoever.

## What that does to round four's mechanism

Round four proved, and this document still records, that a drained queue *can* hang a
request: the mock returns `undefined`, the handler reads `.rows` off it and throws, and
Express 4.22.1 does not catch an async handler's rejection. That chain is real and was
measured.

**It is not what happens here.** If it were, 49% of test executions would hang. They do not.
So on the paths where the queue drains, one of two things must be true — the extra calls
happen *after* the response is sent, or the handler never dereferences the result. The
record's very first section already described post-response work outliving the request; that
is the reading consistent with this measurement, and "drain causes the failure" is not.

**Do not resurrect this lead on the strength of the round-four mechanism.** The mechanism is
sound and the premise is false: the drain is ubiquitous and benign.

## Honesty about the stated condition

The condition named in round four was a **timeout** with the counts in agreement. That exact
observation was not obtained: the one failure in these 15 runs was
`routes-agents-events › SSE follow forwards a late-arriving event without reconnect`, an
assertion failure in a file the shim did not cover, not a timeout in the instrumented file.

The lead is nonetheless refuted, by a disconfirmation the condition did not anticipate and
which is stronger than it: the proposed cause occurs at an identical rate on runs that pass.
A cause that is present in half of all green executions explains nothing.

## The instrument, and a hook that does not exist

Two things are worth recording so the next person does not spend the time again.

**A global `jest.fn` hook is not available in this setup.** Patching `jest.fn` from
`setupFilesAfterEnv` intercepts **0** of the suite's mock creations; so does patching from
`setupFiles`; so does patching `ModuleMocker.prototype.fn` resolved from the project's own
`node_modules`. Measured, all three:

```
QA-DBG  jest.fn() calls intercepted: 0      (setupFilesAfterEnv)
QA-DBG3 mocks created via ModuleMocker: 0   (prototype patch)
QA-DBG4 intercepted via setupFiles: 0
```

The test module receives a `jest` object distinct from the setup file's, and the mocker's
`fn` is bound before setup runs. **No global auto-instrumentation of mocks is possible this
way.** The broken instrument is deliberately not committed; a diagnostic that silently
reports `mocks: 0` is worse than none, and it read exactly that against a file using
`Once(` fourteen times.

What worked was a **counting Proxy around the file's own `mockQuery`**, applied to the
working tree for the measurement and reverted afterwards, so the committed suite is
unchanged. It preserves behaviour exactly — it returns whatever the underlying mock returns,
including `undefined` on a drained queue — and counts calls, `Once` values and defaults.

**Its positive control caught a real bug in it.** jest implements
`mockResolvedValueOnce(v)` as `mockImplementationOnce(() => Promise.resolve(v))`, so wrapping
both members of that pair counts one queued value **twice** — which makes an over-called mock
read as balanced, the precise failure the instrument exists to detect. A synthetic control
(2 calls against 1 queued value must read drained; 2 against 2 must not; a non-`Once` default
must not) failed, the re-entrancy guard was added, and it passed. Without that control the
49% above would have been reported as 0%.

## Where the search space stands

Eliminated by measurement, cumulative:

- `process.env` and `globalThis` as carriers
- "symptoms are purely logical" — timeout, 401 and 400 are in the set
- order-dependence, n=80; the runInBand-worse-than-workers asymmetry, n=80
- CPU starvation as the timeout mechanism (round four, free loop during the only ≥5s execution)
- "drained queue → promise never resolves" (round four — it returns `undefined`)
- **a drained queue as the cause of the flake** — 49% on green runs, 49% on the failing one

**Still unexplained, and deliberately not folded together:**

- **The 501/401/400 class.** Untouched by this round and by round four. Nothing measured so
  far bears on it. It should not be attached to the queue mechanism, which is now known to be
  benign, nor to starvation, which is eliminated.
- **The SSE class.** The failure caught here — a late-arriving event not forwarded — and
  round four's finding that `INFERENCE_POLL_MS = 3000` sits ~1s under jest's 5000ms ceiling
  both point at `routes-agents-events`, which remains the most frequent victim across every
  round. That file's timing, not its state, is the last thing pointed at by evidence.

**Nothing was disabled, retried or quarantined.**

---

# Round six, 2026-08-03: the timing-margin lead is refuted

**20 runs of half A, 2 failures, 6,020 test executions with per-test durations.**
Nothing skipped, retried, reordered or quarantined, and **neither the poll interval nor the
jest timeout was changed** — widening either would have hidden the failure rather than
explained it.

## The instrument, controlled first

The lead needs a classifier that separates *failed because it ran out of the 5000ms budget*
from *failed for some other reason*. Two synthetic failures with known causes:

```
CTL-NEAR-CEILING  ran  5002ms  -> OUT OF HEADROOM        [FAILED]
CTL-FAST-FAIL     ran     1ms  -> 4999ms headroom        [FAILED]
CTL-PASSES        ran     1ms  -> 4999ms headroom
```

It flags the budget-limited failure, does not flag the instant one, and does not flag the
passing test. Only then was it used.

## The margin is real, and it is never consumed

`INFERENCE_POLL_MS = 3000` against a 5000ms ceiling is a genuine ~1s margin. The question is
whether anything ever spends it. Across 20 runs:

```
routes-agents-events test executions:            580
  of those, poll-waiting (>=3000ms):              40
    durations: min 3515ms, median 4006ms, MAX 4082ms
    worst headroom observed:                     918ms
    executions within 500ms of the ceiling:        0
    loop delay during them: median 65.4ms, worst 212.7ms

ALL 6,020 executions:
    within 500ms of the 5000ms ceiling:            0
    exceeded it:                                   0
```

**The worst excursion in 40 poll waits used 82ms of roughly 1,000ms of slack.** The poll
tests are strikingly stable — a 567ms spread across 20 runs — and the loop is free
throughout, so nothing is even competing for the time.

For the margin to cause a failure something must consume ~1s of slack. Across 6,020
executions nothing consumed a tenth of it.

## And the failures that did happen were nowhere near it

```
run 11  routes-agents-skill      ran  321ms, loopMax  84.9ms -> 4679ms headroom   200 -> 400
run 14  platform-connections     ran  180ms, loopMax 157.8ms -> 4820ms headroom   403 -> 501
run 14  root-route non-regression ran 148ms, loopMax 100.1ms -> 4852ms headroom   404 -> ?
```

Every failing test finished in under a third of a second with **more than 4.6 seconds of
budget unused**. `routes-agents-events` did not fail at all in these 20 runs.

**The timing-margin lead is dead.** It was the obvious suspect, it is arithmetically real,
and it explains none of the observed failures.

## One reconciliation, and one thing not reproduced

Round three recorded `routes-agents-events` at **83.2s** and read that as the largest
unexplained quantity here. Per test, nothing in that file exceeds **4.1s**. So a
file-level 83s is not any single test overrunning its budget — it is many tests, or
file-level setup, and the per-test framing that suspicion was built on does not hold.

**This round did not reproduce an 83s file.** Twenty runs, all normal. That is recorded as a
non-reproduction, not as a refutation of the original observation.

## The 501 class — kept separate, and now with a concrete target

This is **not** folded into the timing lead. It is named because this round produced a code
fact worth the next session's time.

`platform-connections › P2` calls **`POST /provider-connections`** and expects 403. It
received **501**. So:

```
$ grep -rn "status(501)" src --include='*.ts' | grep -v __tests__ | wc -l
1
src/routes/profile.ts:287   // POST /profile/password — "NOT_IMPLEMENTED"
```

**There is exactly one site in the entire application that can produce a 501**, it is on
`POST /profile/password`, and it is on a different router from the route under test. Express
and finalhandler contain no 501 of their own — checked, no matches.

`501` has now appeared in round three (200→501, twice), round four (`docs.test.ts`, 400→501)
and here (403→501). Every one of them must have come from that single handler, on a path
none of those tests called.

**This is a lead, not a finding.** It does point somewhere specific: a response produced by
one route arriving at a request made to another. The record eliminated a "wrong server"
hypothesis in round one, but on 404 evidence — *"455 of 470 captured 404s were handler
JSON"* — which says nothing about this. A unique-origin status code is a much sharper probe
than a 404, because 404 has many sources and this has exactly one.

**The next thing to attack:** instrument that single handler to record, when it fires, which
request it believes it is answering — method, path, and the supertest socket — and compare
against the request the failing test made. If they agree, cross-talk is dead and the 501 came
from somewhere unmodelled. If they disagree, the carrier is the connection, not the state.

## Where the search space stands

Eliminated by measurement, cumulative:

- `process.env` and `globalThis` as carriers
- "symptoms are purely logical" — timeout, 401 and 400 are in the set
- order-dependence, n=80; the runInBand-worse-than-workers asymmetry, n=80
- CPU starvation as the timeout mechanism
- "drained queue → promise never resolves" — it returns `undefined`
- a drained queue as the cause — 49% on green runs, 49% on the failing one
- **the SSE timing margin** — 0 of 6,020 executions came within 500ms of the ceiling, and
  every observed failure had >4.6s of headroom

**Nothing was disabled, retried or quarantined, and no timeout or interval was widened.**

---

# Round seven, 2026-08-03: the 501 instrument works, and the experiment did not decide

**25 runs of half A, 0 failures, 0 audit rows.** The question round six posed is **not
answered**. This section records why, what was learned anyway, and the one change that makes
the next attempt sharp.

## The instrument, and its control

The 501 handler at `src/routes/profile.ts` was instrumented (working tree only, behaviour
unchanged, env-gated) to record which request it believes it is answering: method,
`originalUrl`, `baseUrl`, `path`, and the socket's local/remote ports.

**The way this instrument could lie is by reporting the route pattern rather than the real
request** — it would then always "agree" and prove nothing. So the control mounted the *same
router* at a second path and required two distinct readings:

```
POST originalUrl=/profile/password     baseUrl=/profile     socket local=53509 remote=53510
POST originalUrl=/zz-control/password  baseUrl=/zz-control  socket local=53511 remote=53512
distinct originalUrls: 2 -> PASS: reports the actual request
```

## And then it measured nothing, exactly as feared

Across the 25 half-A runs the audit produced **zero rows**. That is the third time in this
investigation an instrument has silently reported nothing — after the mock counter that
double-counted and the global `jest.fn` hook that intercepted 0 mocks. It was caught the same
way: by running it against a case that must produce output.

```
rows from routes-profile.test.ts (which really calls the endpoint): 1
```

The instrument is fine. **The reason is a fact about the corpus, and it is the useful part of
this round:**

- `docs.test.ts` contains the string `/profile/password` only as an entry in a spec-contract
  array (line 188). It never issues the request.
- `routes-profile.test.ts` is the **only** file in the suite that calls it, and
  `grep -c routes-profile /tmp/halfA.txt` = **0** — it is not in half A.

**So no test in half A can legitimately make that handler fire.** Yet round six recorded
`platform-connections › P2` (which *is* in half A) receiving a 501.

## Why that makes the next attempt much sharper

The round-six plan was to compare the handler's `originalUrl` against what the failing test
sent. That comparison is now unnecessary: in a half-A run **any audit row at all is
anomalous**, because nothing there should reach the handler. Presence or absence is the
signal, and it does not depend on catching the failing assertion at the same moment.

The premise was re-checked rather than assumed. `status(501)` appears once in the
application; `src/routes/secrets.ts:122` mentions 501 only in a comment, and that route
deliberately requests `?sealedcode=200&uninitcode=200&standbycode=200` and always replies
with its own `res.json(...)`, so it never forwards an upstream 501. **One origin, confirmed.**

## The honest verdict: undecided

The condition set in round six was that agreement kills cross-talk and disagreement makes the
connection the carrier. **Neither was observed, because no 501 event occurred.** 0 failures in
25 runs — at the ~10% rate measured in rounds four to six that has a probability of about
7%, so it is unremarkable but it is also not evidence the flake is gone, and it is not
recorded as such.

**The cross-talk lead is neither confirmed nor refuted.** It is not rescued either: nothing
here argues for it.

## What the next attempt should do, in one command

Reapply the audit (it is not committed — a diagnostic belongs with the other diagnostics, and
this one lives in a production route file, so it stays out of `main`):

```
# in services/api/src/routes/profile.ts, inside the POST /password handler,
# before res.status(501):
if (process.env.API_501_AUDIT) { try { const s:any=(_req as any).socket||{};
  require('fs').appendFileSync(process.env.API_501_OUT||'/tmp/audit501.jsonl',
  JSON.stringify({ts:Date.now(),method:_req.method,originalUrl:(_req as any).originalUrl,
  baseUrl:(_req as any).baseUrl,path:(_req as any).path,
  localPort:s.localPort,remotePort:s.remotePort,pid:process.pid})+'\n'); } catch(e){} }
```

Then run half A until a failure occurs and check for **any** row. Because half A has no
legitimate caller, a single row is the finding; an unexpected 501 with **no** row means the
status did not come from this handler at all, which would refute the unique-origin reasoning
this lead rests on and is equally worth having.

**Nothing was disabled, retried or quarantined, and no handler behaviour was changed.**

---

# Round eight, 2026-08-03: the unique-origin argument does not hold, so the experiment is not sharp

## How many runs a meaningful null would take, stated first

Measured rates: ~10% of half-A runs fail (rounds four to seven), and roughly a third of
failures are 501-class (round three ×2, round four ×1, round six ×2 of the classified set).
So P(501 event per run) ≈ **0.03**, and a null result means something only at

```
N >= ln(0.05) / ln(0.97)  ≈  98 runs
```

**About 100 runs**, roughly an hour. Round seven's 25 runs were nowhere near that, which is
why they were reported as undecided rather than as evidence.

Those runs were not spent, because the premise they would test does not survive inspection —
which is cheaper and settles more.

## The claim that fails

Round six said:

> There is exactly one site in the entire application that can produce a 501.

**That was a grep for the literal `status(501)`, and the literal is not the only way a 501
reaches a client.** Twelve sites forward whatever status an upstream returned:

```
src/routes/knowledge.ts:51,85,104,126,151,160        res.status(result.status).json(result.data)
src/routes/shared-knowledge.ts:89,105,116,147,159,175  res.status(result.status).json(result.data)
```

`result.status` is `resp.status` from a proxied call (`src/services/shared-knowledge-proxy.ts:58`,
`src/services/task-proxy.ts:52`). Any upstream status passes straight through, 501 included.
**So uniqueness cannot be established by grepping for the literal, and round six's reasoning
rests on exactly that.**

## Being precise: unproven, not disproven

No alternative origin has been *demonstrated*. The proxies return their own **503** when the
service is unconfigured and **502** when it is unreachable — not 501 — and they only pass
through an upstream status when a real response arrived. In tests the upstream is mocked, and
`grep -rln 501 src/__tests__/` returns **one** file, `routes-profile.test.ts`, which is not in
half A.

So the honest state is: **the uniqueness claim is unproven, not refuted.** What is refuted is
the *argument* — "only one site emits 501, therefore a 501 anywhere else is cross-talk" — and
the experiment built on it, which treated presence or absence of one handler's audit row as
decisive. It is not decisive if other origins are possible, and they are.

## What was checked on the two actual victims

Both round-six 501s came from routes that cannot emit one:

- `platform-connections › P2` calls `POST /provider-connections`. That route emits
  **503, 400, 403, 201** — checked line by line. No 501.
- `docs.test.ts › GET /nonexistent returns 404` got **501** for a path with no route at all,
  and `app.ts` has no catch-all or error handler that could produce one.

A request to a route with no 501 path, and a request to no route at all, both receiving 501,
remains the strangest observation in this document. It is *consistent* with a response
generated elsewhere arriving on the wrong socket — but "elsewhere" is now a dozen candidate
sites rather than one, so the observation no longer points anywhere specific.

## The audit

Reapplied and re-controlled as before; the control still passes (the same router on two
mounts is recorded with two distinct `originalUrl`s). It is **not committed** — production
route files are byte-identical to `main`, and the exact patch remains in round seven.

Running it ~100 times was not done, deliberately: it would spend an hour testing whether one
particular handler fired, when the inference from that answer has just been shown not to hold.

## The next question, which is a different shape

Stop instrumenting one handler and instrument the **response**: wrap `res.status` for the
duration of a run and record, for every response with status 501, the route that produced it
and the socket it went out on. That does not assume where 501s come from — it observes it —
and it answers the question round six was really asking:

- if a 501 is emitted by a route the failing test never called, on the socket that test is
  waiting on, the carrier is the connection;
- if no 501 is emitted anywhere while a test receives one, the status is not coming from this
  application at all, which would be a much larger finding;
- if a 501 is emitted by a route the failing test *did* call, then some upstream mock is
  returning it and this whole class is local, not cross-talk.

All three are worth having, and unlike the round-six design, none of them depends on an
assumption about how many places can emit the status.

**Nothing was disabled, retried or quarantined, and no handler behaviour was changed.**

---

# Round nine, 2026-08-03: no route emits the 501, and a test receives it anyway

**This is the third of the three outcomes named in round eight, and the largest of them:
the 501 does not come from this application's route layer.**

## How long a null would have needed, and why it was not needed

At the observed rate — 1 run in 38 where a test receives a 501 — a null result carries weight
at `N >= ln(0.05)/ln(1 - 1/38)` ≈ **112 runs**. That budget was not spent, because the run
produced a **positive observation** rather than a null: the event occurred at run 6.

## The instrument

`express.response.status` was wrapped for the whole worker, so it observes **every** 501
regardless of which route emits it. This is the correction round eight called for: it assumes
nothing about how many sites can produce the status.

Controlled before use — two routes emitting 501 on different paths, one emitting 403:

```
GET /alpha  socket local=64670 remote=64671
GET /beta   socket local=64672 remote=64673
rows=2 distinct urls=2 -> PASS: records each 501 with its real url, and no 403
```

**Then the first batch was thrown away.** 38 runs produced `rows=0` everywhere — which is
ambiguous between *no 501 was emitted* and *the wrapper never loaded*, the exact trap that
has caught this investigation twice. A liveness marker was added (one row per test file at
install), verified to appear and to coexist with real captures:

```
installed markers: 1 | 501s captured: 2 -> PASS
```

Every subsequent half-A run then reports **29 rows** — one marker per file — so any emission
shows as a row beyond 29, and an empty result can no longer be confused with a dead
instrument.

## The observation

```
run 6:  FAIL   rows=29   received501=2
  run6b rows=29  liveness markers=29  actual 501 emissions=0
  ● ... Expected: 404 / Received: 501
```

**Twenty-nine liveness markers, zero 501 emissions, and a test that expected 404 received
501.** The wrapper was demonstrably installed in every worker and no route in the application
called `res.status(501)` — or `res.status(...)` with any 501-valued variable, since the
wrapper sees the resolved code, not the literal.

Nothing bypasses it inside the app either: `grep -rn "writeHead(" src` excluding tests returns
**0**, so there is no path that writes a status header without going through `res.status`.

## What this kills, and what it does not

**Killed:** every explanation in which some route of this application produces the 501 —
including round six's `POST /profile/password` reasoning, and round eight's status-forwarding
sites (`res.status(result.status)`). Neither fired. The forwarding sites were a valid reason
to doubt uniqueness; they are now excluded as the actual source by measurement rather than by
counting.

**Not established: where the 501 does come from.** Two candidate mechanisms were probed
directly and **neither reproduces it**:

```
unknown method -> HTTP/1.1 400 Bad Request | app handler ran: false
bad TE         -> HTTP/1.1 200 OK          | app handler ran: true
```

Node's HTTP server answers a malformed request with **400**, not 501, on this version. So
"Node emitted it below express" is not supported by evidence, and is not claimed.

The remaining candidates, none of them tested: superagent/supertest synthesising a status when
a response is malformed or truncated; a response belonging to another request arriving on this
socket, where the status line is read from bytes this application never wrote; or something in
the test harness. **These are candidates, not findings.**

## The next instrument, and what would settle it

Capture the **raw bytes** of the response the failing assertion read. If the socket carries a
literal `HTTP/1.1 501 Not Implemented` status line, something wrote those bytes and the
question becomes who — and since no express route did, the writer is outside the app, which
would make connection-level cross-talk the leading explanation for the first time on direct
evidence. If instead the bytes show a different status and supertest reports 501, the defect
is in the client layer and has nothing to do with the server at all.

That is a smaller and sharper question than any asked so far, and it does not depend on any
assumption about the application.

## Standing state

Eliminated by measurement, cumulative: `process.env` and `globalThis` as carriers; "symptoms
are purely logical"; order-dependence; the runInBand asymmetry; CPU starvation as the timeout
mechanism; "drained queue → promise never resolves"; the drained queue as the cause (49% on
green runs); the SSE timing margin; and now **every route-level origin of the 501**.

**Nothing was disabled, retried or quarantined; no handler behaviour was changed; production
route files remain byte-identical to `main`.**

---

# Round ten, 2026-08-03: the wire carries a literal 501, so the client did not invent it

**71 runs of half A, 5 failures, one carrying the event. The status line on the socket is
real.**

## The instrument

A recorder taps every client socket and captures the first status line actually delivered,
with the socket's ports and the running test. It carries a liveness marker for the same
reason as round nine — a byte recorder that silently records nothing looks exactly like a
clean run, and that has already happened once in this investigation.

Controlled before use, against three known statuses:

```
wire: HTTP/1.1 403 Forbidden       | ports 52393 -> 52392
wire: HTTP/1.1 501 Not Implemented | ports 52395 -> 52394
wire: HTTP/1.1 200 OK              | ports 52397 -> 52396
installed=1 captures=3 statuses=['403','501','200'] -> PASS
```

## The observation

```
run 35   FAIL   received501=4   wire501=2   caps=253   install markers=29

● Agent create/update scope RBAC › update with vps_system skill as non-admin returns 403
    Expected: 403   Received: 501
● Agent CRUD routes › POST /agents returns 409 on duplicate agent_id
    Expected: 409   Received: 501

{"statusLine":"HTTP/1.1 501 Not Implemented","localPort":50442,"remotePort":50441,
 "pid":33670,"test":"...vps_system skill as non-admin returns 403","testFile":"routes-agents-skill.test.ts"}
{"statusLine":"HTTP/1.1 501 Not Implemented","localPort":50443,"remotePort":50437,
 "pid":33669,"test":"...POST /agents returns 409 on duplicate agent_id","testFile":"routes-agents.test.ts"}
```

**A literal `HTTP/1.1 501 Not Implemented` was delivered on the socket**, in two different
worker processes, to two tests that asked for entirely different things (a 403 RBAC check and
a 409 duplicate check).

## What this rules out

**The client layer.** supertest/superagent did not synthesise the status: the bytes say 501.
Everything downstream of the wire — assertion helpers, response parsing, the harness — is
exonerated. The status is real, and something wrote it.

That was one of the two outcomes named in round nine, and it is the one that occurred.

## What it makes leading, and the caveat that keeps it a lead

Round nine measured, with liveness proven, that **no express route emitted a 501** while a
test received one. This round measures that **the 501 is genuinely on the wire**. Together
those say: bytes that no route in this application wrote were delivered to a socket a test was
reading — which is connection-level cross-talk, and it is the first time in ten rounds that
anything points there on direct evidence rather than by elimination.

**The caveat is real and is not buried: those are two different runs.** The
`res.status` wrapper and the byte recorder have never been active in the same run, so "no
route emitted it" and "the wire says 501" have not been observed of the *same* event. Both are
`setupFilesAfterEnv` files; running them together is one command, and it is the next thing to
do. Until then the conjunction is an inference across runs, not a measurement of one.

One further observation, recorded without interpretation: in the control every capture paired
consecutive ports (`52393 -> 52392`), and in run 35 the first 501 did too (`50442 -> 50441`)
while the second did **not** (`50443 -> 50437`). Ephemeral ports carry no guarantee of
adjacency, so this is not evidence of anything on its own — it is written down because if
cross-talk is real, socket pairing is where it would show, and the next run should record it
deliberately rather than notice it by accident.

## Standing state

Eliminated by measurement, cumulative: `process.env` and `globalThis` as carriers; "symptoms
are purely logical"; order-dependence; the runInBand asymmetry; CPU starvation as the timeout
mechanism; "drained queue → promise never resolves"; the drained queue as the cause; the SSE
timing margin; every route-level origin of the 501; and now **the client layer as the inventor
of the 501**.

Leading, on direct evidence for the first time: **connection-level cross-talk.**

**Nothing was disabled, retried or quarantined; production route files remain byte-identical
to `main`.**

---

# Round eleven, 2026-08-03: the conjunction holds on one event — and it is not express cross-talk

**Both instruments in one run, 35 runs, the event captured at run 34.** The conjunction that
round ten could only infer across two runs is now a measurement of a single event.

## Socket identity, established rather than inferred

Round ten noticed port adjacency by accident and refused to read anything into it. This run
establishes pairing by the **swap rule**: a server row `(local=S, remote=C)` and a client row
`(local=C, remote=S)` are the same connection. Controlled first — every delivered response
paired with its emitter, by code and url:

```
client HTTP/1.1 501 Not Impleme ports 53051->53050 | server match: code 501 url /x -> PAIRED
client HTTP/1.1 403 Forbidden   ports 53053->53052 | server match: code 403 url /y -> PAIRED
-> PASS: the swap rule pairs every response with its emitter
```

## The event

```
● Platform Connections › P1: POST /provider-connections ... created_by = NULL
    Expected: 201    Received: 501

install markers=29   server rows=110   client rows=256
server rows with code 501:  0
client rows with a 501 status line:  1

CLIENT  HTTP/1.1 501 Not Implemented   ports 50444->50441  pid=50433
        test: Platform Connections (P1-P5) P1: POST /provider-connections ...
PAIRED SERVER ROW -> NONE. No express response was emitted on this connection.
```

**Both instruments were live in the same run and both spoke about the same event.** The wire
carried a literal 501; no express route emitted a 501 anywhere in the run; and — the part
that could only be seen with pairing — **no express response was emitted on that connection
at all.**

Following the server port further:

```
express responses emitted from server port 50441: 0
client sockets that talked to port 50441:         1   (the 501)
```

## What is demonstrated, plainly

**The 501 was produced by something that is not an express response in this application.**
The conjunction holds: it is on the wire, and this app did not put it there.

## And what is NOT demonstrated — including by me

**This is not express-to-express cross-talk, and that was my leading hypothesis going in.**
Classic cross-talk has a signature: the client row would pair with a *server row belonging to
a different request* — someone else's response arriving here. That signature **did not
appear.** There is no paired server row at all, and the server port in question emitted
nothing, ever, for anybody.

So round ten's reading — "bytes no route wrote were delivered to a socket a test was reading,
therefore connection-level cross-talk" — was too strong. The first half is confirmed. The
conclusion is not: a response can fail to come from this app without coming from another of
its responses.

## Where that leaves the mechanism

Something answered on an ephemeral port with `HTTP/1.1 501 Not Implemented` while express
served nothing on it. Candidates, none tested:

- **Node's HTTP server answering below express.** Probed twice in round nine and it did not
  reproduce — an unknown method gave 400 and a bad `Transfer-Encoding` gave 200 — so this is
  not supported by what has been tried, but the probes were not exhaustive.
- **A server that had already closed, or a port reused between listeners**, so the connection
  reached a listener that never handed the request to express.
- **supertest's own ephemeral listener** in a state where it answers before the app.

The next measurement is narrow: record, per supertest server, its port and its open/closed
lifetime, and check whether port 50441 was live and owned by the app at the moment of the
connection. If the port was closed or owned by a previous server, this is a port-reuse defect
in the harness and has nothing to do with application state at all — which after eleven rounds
would be the plainest explanation yet offered for a class of failures that has resisted every
state-based theory.

## Standing state

Eliminated by measurement, cumulative: `process.env` and `globalThis` as carriers; "symptoms
are purely logical"; order-dependence; the runInBand asymmetry; CPU starvation as the timeout
mechanism; "drained queue → promise never resolves"; the drained queue as the cause; the SSE
timing margin; every route-level origin of the 501; the client layer as its inventor; and now
**express-to-express cross-talk**, which was the leading hypothesis one round ago.

Established: **the 501 is real on the wire and this application did not emit it.**

**Nothing was disabled, retried or quarantined; production route and test files remain
byte-identical to `main`.**

---

# Round twelve, 2026-08-03: not port reuse — the port was live and app-owned

**77 runs of half A, 4 failures, the event captured at run 76 with all three recorders live.**
The appealing explanation is **refuted by its own measurement.**

## The lifetime recorder, controlled on a real reuse

Wrapping `net.Server.prototype.listen`/`close`, each listener gets an id so a port used twice
is two rows. The control forces an actual reuse — bind, close, rebind the same port:

```
listen rows=3 close rows=3 install=1
port 51792 used by serverIds [1, 2] -> REUSE DETECTED
swap-rule pairing still works: True
-> PASS: detects reuse AND pairs responses
```

## The event

```
● Platform Connections › P5: DELETE /provider-connections/:id as admin ...
    Expected: 200    Received: 501

install=29  server=111  client=241  listen=241  close=241
server rows with code 501: 0        client 501 rows: 1

CLIENT 501  ports 50442->50441  at ts=...992667
  paired express response: NONE
  listeners that ever owned port 50441: 1  (serverIds [5])
    serverId=5 listen@...992631 close@...992671
    -> connection at ...992667 was INSIDE (live)
```

## What that settles

**Port reuse is refuted.** Port 50441 had **exactly one listener in the entire run** — no
second `serverId`, so nothing rebound it — and the connection landed **inside** that
listener's live window. The harness did not hand the client a stale or foreign port.

This was the explanation that would have been plainest after eleven rounds, and it is the one
the measurement rules out. Recording that rather than reaching for it.

## What is now established, cumulatively, about a single event

1. The wire carried a literal `HTTP/1.1 501 Not Implemented` (round ten, controlled).
2. No express route emitted a 501 anywhere in the run — 111 `res.status` calls recorded, zero
   of them 501 (rounds nine and eleven, liveness-proven).
3. No express response was emitted on that connection at all (round eleven, swap-rule pairing).
4. **The server on that port was live, app-owned, and singly-bound** (this round).

So a live supertest server, owned by this application, accepted a connection and the client
received a 501 that express never produced.

## The sharpest untested candidate, and it is new

The lifetime numbers hand over something the earlier rounds could not see:

```
listen@...631   connection@...667   close@...671
```

**The whole server lived 40ms, and the connection arrived 4ms before it closed.** That is a
closing-server race: a connection accepted while `close()` is in flight, on a listener whose
entire existence is shorter than one event-loop tick under load.

That is now the leading candidate and it is **not** yet tested. It is testable directly:
force a connection into the window between `close()` being called and the listener finishing,
and observe what status the client receives. If it is 501, the mechanism is found and it lives
in supertest's per-request server lifecycle, not in application state — which would end an
investigation that has eliminated every state-based theory for eleven rounds.

The other candidates named in round eleven — Node answering below express, supertest's
listener answering before the app — remain untested and are not displaced by this, only
ranked below it.

## Standing state

Eliminated by measurement, cumulative: `process.env` and `globalThis` as carriers; "symptoms
are purely logical"; order-dependence; the runInBand asymmetry; CPU starvation as the timeout
mechanism; "drained queue → promise never resolves"; the drained queue as the cause; the SSE
timing margin; every route-level origin of the 501; the client layer as its inventor;
express-to-express cross-talk; and **port reuse in the harness.**

One caution on rates: these batches ran at **4 failures in 77** against the ~10% of rounds
four to six. Three wrappers per response is not free, and an instrument that changes the rate
may be changing the thing it measures. That is a reason to treat the *rate* here as
uninformative — it is not a reason to doubt the event, which was captured whole.

**Nothing was disabled, retried or quarantined; production and test files remain
byte-identical to `main`.**

---

# Round thirteen, 2026-08-03: the closing-server race does not reproduce it

**280 forced attempts, two shapes, zero 501s. The leading candidate is weakened, not
confirmed.**

Round twelve ranked a closing-server race first on the strength of one timing:
`listen@631, connection@667, close@671` — a 40ms listener taking a connection 4ms before it
closed. Forcing that window deliberately is worth more than waiting for it, so it was forced.

## Shape one — connect after `close()` is called

```
CONTROL (server left open)      -> HTTP/1.1 200 OK
ARM (connect while closing, 120 attempts):
  120x  ERR ECONNREFUSED
-> NOT reproduced
```

A connection attempted after `close()` is **refused**, not answered. Note this is also the
wrong model of the event: in run 76 the connection landed *before* the close, not after.

## Shape two — the shape actually observed: request in flight, then `close()`

```
CONTROL (no close during request) -> HTTP/1.1 200 OK
close 0ms after send, fast handler   -> 38x HTTP/1.1 200 OK | 2x ERR ECONNRESET
close 0ms after send, 20ms handler   -> 38x HTTP/1.1 200 OK | 2x ERR ECONNRESET
close 5ms after send, 20ms handler   -> 40x HTTP/1.1 200 OK
```

A server closing under an in-flight request either **completes the response normally** or
**resets the connection**. It never answers 501.

## Saying it plainly

**This weakens the closing-server explanation.** The window was forced at three offsets
against both a fast and a slow handler, 280 attempts, and the control confirms the harness
delivers normally throughout — so the arms were live and the failure to reproduce is not an
artefact of a dead experiment.

It is *not* being written off as "the window was too narrow". That excuse is available and it
is refused: the two behaviours a closing server actually exhibits here — a clean 200 and an
ECONNRESET — are both observable and neither is a 501, so the mechanism does not merely need
finer timing, it produces the wrong output entirely.

**A reproduction on demand would have identified the mechanism. Its absence does not identify
anything, and that is the honest result of this round.**

## What survives

The four established facts about run 76 are untouched, since none of them depended on the
race being the cause:

1. the wire carried a literal `HTTP/1.1 501 Not Implemented`
2. no express route emitted a 501 anywhere in that run
3. no express response was emitted on that connection
4. the server on that port was live, app-owned and singly-bound

**Something answered 501 on a live application-owned socket, and neither express, nor the
client layer, nor port reuse, nor a closing-server race accounts for it.**

## What is left, ranked

- **Node's HTTP server answering below express.** Probed in round nine with an unknown method
  (400) and a bad `Transfer-Encoding` (200), so two paths are excluded and the space is not.
  Node's own 501 paths should be enumerated from its source rather than guessed at — that is
  a reading task, not a running task, and it is the cheapest thing left.
- **supertest's per-request listener answering before the app.** Untested.
- A source outside both, reached because the connection went somewhere unexpected. Round
  twelve rules out port *reuse*, not every form of misdirection.

## Standing state

Eliminated by measurement, cumulative: `process.env` and `globalThis` as carriers; "symptoms
are purely logical"; order-dependence; the runInBand asymmetry; CPU starvation as the timeout
mechanism; "drained queue → promise never resolves"; the drained queue as the cause; the SSE
timing margin; every route-level origin of the 501; the client layer as its inventor;
express-to-express cross-talk; port reuse; and now **the closing-server race**.

Thirteen rounds, thirteen dead ends, and one fact that has survived all of them: **the 501 is
real on the wire and this application did not write it.**

**Nothing was disabled, retried or quarantined; production and test files remain
byte-identical to `main`.**

---

# Round fourteen, 2026-08-03: Node cannot emit 501 — the enumeration is complete

**Source read, not remembered: Node `v26.5.0`, the exact binary running this suite**, via
`process.binding('natives')`, which returns the embedded source of the internal modules.
Modules examined: `_http_server`, `_http_common`, `_http_incoming`, `_http_outgoing`,
`internal/http`.

## Being exact about what the earlier probes achieved

Round nine probed two inputs — an unknown method (got **400**) and a bad `Transfer-Encoding`
(got **200**). Those excluded **two paths, not the category**, and the round-thirteen ranking
said so. This enumerates the category.

## Every occurrence of 501 in Node's HTTP server

```
_http_server:176:   501: 'Not Implemented',            // RFC 7231 6.6.2
```

**One occurrence, in the `STATUS_CODES` lookup table** — a label used to render a status line
if some caller asks for 501. It is not an emission.

## The reading, positive-controlled

A grep that finds nothing proves nothing unless it can find something. The same scan over the
same module locates every canned response Node actually sends:

```
_http_server:972-973:  const badRequestResponse     = ... `HTTP/1.1 400 ${STATUS_CODES[400]}`
_http_server:976-977:  const requestTimeoutResponse = ... `HTTP/1.1 408 ${STATUS_CODES[408]}`
_http_server:981:                                     ... `HTTP/1.1 431 ${STATUS_CODES[431]}`
_http_server:986:                                     ... `HTTP/1.1 413 ${STATUS_CODES[413]}`
_http_server:1014:     response = requestTimeoutResponse;
_http_server:1017:     response = badRequestResponse;
_http_server:269:      ServerResponse.prototype.statusCode = 200;
_http_server:727:      res.statusCode = 500;
```

So the scan does find emissions where they exist. **Node's HTTP server has exactly four
hard-coded error responses — 400, 408, 431, 413 — plus a 200 default and a 500 for a throwing
request listener. 501 is not among them.**

## The complete list, each marked

| Candidate Node 501 path | Status |
|---|---|
| `STATUS_CODES[501]` table entry, `_http_server:176` | **not an emission** — a label only |
| unknown/unsupported HTTP method | **excluded by evidence** — probe returned 400 |
| unsupported `Transfer-Encoding` | **excluded by evidence** — probe returned 200 |
| malformed request / parser error (`badRequestResponse`) | **excluded by source** — emits 400 |
| request timeout (`requestTimeoutResponse`) | **excluded by source** — emits 408 |
| headers too large | **excluded by source** — emits 431 |
| payload too large | **excluded by source** — emits 413 |
| throwing request listener | **excluded by source** — sets 500 |
| any other | **none exist** — 501 appears nowhere else in the HTTP modules |

## Plainly: Node is eliminated

**Node's HTTP server cannot emit a 501 of its own.** The enumeration is complete for the
version in use, it was read from the running binary rather than recalled, and the reading was
controlled against codes Node does emit.

That was the top-ranked remaining candidate and it is gone. Thirteen rounds of elimination do
not pay off here — this closes a door rather than opening one, and that is the honest result.

## What is left

**One named candidate: supertest's per-request listener answering before the app.** It is
untested, and it is now the only surviving named explanation for the fact that has outlived
everything else:

> a literal `HTTP/1.1 501 Not Implemented` was delivered on a live, application-owned socket,
> and neither express, nor the client layer, nor port reuse, nor a closing-server race, nor
> Node itself wrote it.

If supertest is also excluded, the honest position becomes that the 501 comes from something
not yet named at all, and the next step would be to widen rather than narrow — capture the
full response body alongside the status line, since a body identifies its author far more
specifically than three digits do, and every capture so far has deliberately read only the
first line.

## Standing state

Eliminated by measurement or source, cumulative: `process.env` and `globalThis` as carriers;
"symptoms are purely logical"; order-dependence; the runInBand asymmetry; CPU starvation as
the timeout mechanism; "drained queue → promise never resolves"; the drained queue as the
cause; the SSE timing margin; every route-level origin of the 501; the client layer as its
inventor; express-to-express cross-talk; port reuse; the closing-server race; and **Node's
HTTP server**.

**Nothing was disabled, retried or quarantined; production and test files remain
byte-identical to `main`.**

---

# Round fifteen, 2026-08-03: the 501 comes from a third-party process on the machine

**The body names its author. Fourteen rounds of elimination were looking inside an
application that never wrote the response.**

## Part one: supertest is eliminated too

`supertest@6.3.4` and `superagent@8.1.2`: **zero occurrences of `501`** anywhere in their
`lib/`. The same grep finds the codes they do reference — `response-base.js:113 badRequest ===
400`, `:117 notFound === 404` — so the scan works. The last named candidate is gone.

At that point the honest position was that the source is **something not yet named**. It was.

## Part two: the full body

Every capture until now read only the status line — a limitation of the instrument, not a
property of the failure. The recorder was extended to keep the whole response, controlled
first (a 501 carrying `CTL-AUTHOR-TAG` captured entire, a 200 ignored), then run.

Captured at run 33 of 67, on a test expecting 400:

```
HTTP/1.1 501 Not Implemented
Server: websocket-sharp/1.0
Connection: close
```

**`Server: websocket-sharp/1.0`.** That is a C#/.NET WebSocket library. It is not Node, not
express, not supertest, and not anything in this repository.

In the same run: 110 `res.status` calls recorded, **zero of them 501**, and no express
response on that connection — consistent with every previous round, and now explained.

## The mechanism

```
$ lsof -nP -iTCP:50441
LogiPlugi 2654 jon 355u IPv4 TCP 127.0.0.1:50441 (LISTEN)
```

**A third-party service on the development machine — Logitech's plugin daemon — listens on
127.0.0.1:50441 and serves websocket-sharp, which answers a non-WebSocket HTTP request with
`501 Not Implemented`.** Port 50441 is inside the ephemeral range supertest draws from. When a
supertest client's connection lands there, it gets that daemon's 501 instead of the
application's response.

This is why:

- the wire carried a real 501 — it did, written by another process
- no express route emitted one — none did
- no express response existed on that connection — the connection never reached the app
- port *reuse* within the run was refuted — the collision is with a **foreign** listener, which
  the lifetime recorder could not see because it only instruments this process
- the closing-server race did not reproduce it — it was never the mechanism
- Node could not emit it — correct, and irrelevant
- **the rate is environmental.** Round three recorded 7.5% locally against 25% in CI and said
  "whatever modulates it is environmental, so a rate measured on one machine should not be
  quoted as the rate". That was right, and this is the reason.

## Scope — stated narrowly on purpose

**This explains the 501 class.** It is not extended to the 400/401/404 or timeout classes
without evidence; a foreign listener answering with something else would produce a different
status, which is a testable prediction and not a claim. The same capture, kept for every
status rather than only 501, would settle it.

**It is a defect in the test environment, not in the application**, and the fix is not a code
change: it is to bind supertest servers away from a range a foreign daemon occupies, or to
detect the collision and fail loudly rather than assert on a stranger's response.

## What this cost, and what it was worth

Fourteen rounds eliminated: `process.env` and `globalThis`; "symptoms are purely logical";
order-dependence; the runInBand asymmetry; CPU starvation; "drained queue → promise never
resolves"; the drained queue as the cause; the SSE timing margin; every route-level origin of
the 501; the client layer; express-to-express cross-talk; port reuse; the closing-server race;
Node's HTTP server; and supertest.

Every one of them searched **inside the application**. The answer was outside it, and the
single instrument that found it was the one that stopped reading three digits and read what
the response actually said.

**Nothing was disabled, retried or quarantined; production and test files remain
byte-identical to `main`.**

---

# Round sixteen, 2026-08-03: the guard ships, and the cross-class question stays open

## Part one: full capture for every status — no foreign response recurred

The recorder was widened from "capture 501s" to "flag any response carrying a `Server:`
header", since neither express nor Node's http server sets one and anything that does is not
us. That covers **every status**, not just 501, which is what the 400/401 question needs.

**30 runs of half A, 1 failure, and zero foreign responses of any status.**

So the collision did not recur in this batch, and **the question of whether the 400/401 class
shares this cause is still open.** It is not being answered by inference from the 501 case: a
foreign daemon answering a different request with a different status is a *prediction*, and no
instance of it was observed. Saying it is the same cause would be exactly the forcing this
document has spent fifteen rounds avoiding.

What has changed is that the question is now **answerable without another investigation**. The
guard names the status and the `Server:` header of any foreign response the moment one occurs,
so the next occurrence classifies itself.

## Part two: the fix, and why it fails loudly

`services/api/jest.portguard.js`, **on by default** — a guard, not a diagnostic.

It does not retry, skip, rebind or work around the collision. It throws, naming what answered:

```
FOREIGN HTTP RESPONSE — this test received a response that this application did not write.
  HTTP/1.1 501 Not Implemented  (Server: websocket-sharp/1.0)  from 127.0.0.1:51706

A process outside this repository is listening inside the ephemeral port range
supertest binds from, and answered instead of the app. Known offender on macOS:
Logitech Options (LogiPluginService), which serves websocket-sharp and replies
501 Not Implemented to any non-WebSocket request.

Find it with:   lsof -nP -iTCP -sTCP:LISTEN | grep <port>
```

Positive-controlled both ways before shipping:

```
✓ does NOT fire on a normal app response
✕ CONTROL-FOREIGN: a stranger answering must fail this test
```

**Rebinding away from the range was the alternative and was rejected.** A test that quietly
avoids the collision still cannot tell a real response from a stranger's, and that is the
family of defect this entire investigation was closing — an instrument that cannot distinguish
an observation from an artefact. Failing loudly converts a silent wrong assertion into a named
one.

## For the next person meeting a weird status

- **Daemon:** Logitech Options / `LogiPluginService` (macOS), serving `websocket-sharp/1.0`.
- **Observed port:** `127.0.0.1:50441`, confirmed with
  `lsof -nP -iTCP:50441` → `LogiPlugi 2654 jon ... (LISTEN)`.
- **Range:** the ephemeral range supertest draws from — on this machine the collisions landed
  in the **50400–50500** area, but the range is OS-assigned and the specific port is not the
  point; any listener inside it will do this.
- **Signature:** a status your application cannot emit, on a request that never appears in
  your handler logs, with a `Server:` header your stack does not set.

## Standing state

The 501 class is explained and guarded. The 400/401/404 and timeout classes remain
**unexplained and unattached** — deliberately.

Eliminated across sixteen rounds: `process.env` and `globalThis`; "symptoms are purely
logical"; order-dependence; the runInBand asymmetry; CPU starvation; "drained queue → promise
never resolves"; the drained queue as the cause; the SSE timing margin; every route-level
origin of the 501; the client layer; express-to-express cross-talk; port reuse within the
process; the closing-server race; Node's HTTP server; supertest.

**Nothing was disabled, retried or quarantined; production files remain byte-identical to
`main`.**

---

# Round seventeen, 2026-08-03: the classes are separate — the collision explains only the 501s

## How many runs a null would need, stated first

From prior data, P(a foreign response in a run) ≈ 1/67 ≈ **0.015**, so a null on *"no foreign
response ever occurs"* would need `ln(0.05)/ln(0.985)` ≈ **200 runs**.

**That null was not needed, because the result is a contrast rather than an absence.** Foreign
responses did occur, non-501 failures also occurred, and the question is whether they coincide.

## The data — 60 runs, 4 failures

| Run | foreign responses | received | class |
|---|---|---|---|
| 3 | **8** | 501 | 501 |
| 43 | **8** | 501 | 501 |
| 26 | **0** | — | **TIMEOUT** |
| 45 | **0** | 401 | **401** |

```
foreign response statuses across all 60 runs:
   8x  HTTP/1.1 501 Not Implemented  (Server: websocket-sharp/1.0)   from 127.0.0.1:50441
```

**Every foreign response ever captured is a 501.** Not one carries a 400, 401, 404 or anything
else, across every run of this batch and the batches before it.

**And the separation is exact:** both 501-class failures came with foreign responses — eight
apiece, so the collision is bursty rather than a single stray packet — while both non-501
failures came with **zero**.

## The answer, plainly

**The collision explains only the 501s. The 400/401/404 and timeout classes are a separate
defect and need their own hunt from the start.** They are not a variant of this one:

- the timeout in run 26 happened with no foreign response anywhere in the run
- the 401 in run 45 likewise
- and the daemon has never been observed answering with anything but 501, which is what
  websocket-sharp does for a non-WebSocket request — it has no reason to emit a 401 or a 404

## Confidence, stated honestly

The separation is perfect at **n=4** — two of each class — which is a clean contrast and a
small sample. What strengthens it beyond those four is the status evidence: **8 foreign
captures, all 501**, with no non-501 foreign response ever seen in any batch across the whole
investigation. A shared cause would have to explain why a daemon that only ever answers 501 is
also producing 401s and timeouts, and nothing suggests it does.

So this is stated as a **finding with a named limit**: the classes are separate on the evidence
available, the evidence is a four-failure contrast plus a uniform status distribution, and the
guard now labels every future occurrence so the sample grows on its own without anyone
re-running this.

## What the next hunt starts from — and what it must not inherit

The remaining defect is: **400/401/404 and timeouts, on responses this application really
does write.** That is a different problem from the one closed today, and it starts clean.

It should not inherit this investigation's assumptions. Specifically, these are now known
*false* for the surviving classes and cost sixteen rounds to establish:

- it is not `process.env`, `globalThis`, ordering, worker count, CPU starvation, the mock
  queue, the SSE poll margin, or anything about the 501 path
- and the one instrument lesson worth carrying over: **every check in this file that reported
  a clean result was wrong at least once until it was positive-controlled** — the mock counter
  that double-counted, the global hook that intercepted nothing, the byte recorder that read
  only three digits.

## Standing state

- **501 class: explained** (foreign daemon) and **guarded** (fails loudly, on by default).
- **400/401/404 and timeout classes: unexplained, and now positively established as separate.**

**Nothing was disabled, retried or quarantined; production files remain byte-identical to
`main`.**

---

# Hunt two, round one, 2026-08-03: characterising the surviving failures

A fresh investigation into the **400/401/404 and timeout classes**. Carried forward only the
known-false list; everything else is treated as open, including anything that felt settled by
association with the 501 work.

No new runs were needed. **623 logs from today's batches were already on disk**, and mining
them is free.

## The instrument, controlled before its first result

A log miner extracts, per failing run, the failing test, expected/received values and whether
a timeout occurred. Controlled against two failures read by hand earlier:

```
c-run45 (hand-read: received 401) -> 401
c-run26 (hand-read: a TIMEOUT)    -> timeout=True
-> PASS: miner reproduces both known cases
```

## The corpus

```
logs scanned: 623        failing runs found: 42
of which 501-class (explained): 13        surviving: 29
```

## Symptoms

```
  8x  TIMEOUT
  6x  200->404
  4x  200->400
  4x  200->401
  3x  OTHER-assertion
  1x  409->401     1x  400->404     1x  409->404     1x  201->401
```

Eighteen status mismatches, eight timeouts, three other assertions. **The expected value is
`200` in fourteen of the eighteen**, and the received value is always a client-error code the
handler itself can produce — 400, 401, 404. Nothing here resembles the foreign 501: these are
responses this application really did write.

**`401` appears six times across three different expectations** (200, 409, 201). An
authentication failure on a request whose token was accepted moments earlier in the same file
is the most surprising single fact in this table, and it is recorded as an observation, not a
theory.

## Victims

```
 10x  GET /agents/:id/events
  4x  Agent start — network resolution (S1-S4)
  2x  Ownership boundary isolation
  2x  Platform Models (M1-M5)
  2x  Agent eligibility enforcement (AI-120)
  2x  Agent PUT skill_ids behavior
```

**That list is the top six, not all of them — it sums to 22 of the 29.** The remaining 7 are a
long tail of one failure each. Truncated when it was written and not marked as truncated,
which reads as an arithmetic error rather than a summary. Flagged by the Copilot review on
#112 and merged past unread.

`GET /agents/:id/events` is **10 of 29 — 34%** — consistent with every earlier round naming it
the most frequent victim, and now measured against the surviving classes specifically rather
than against the mixed set.

## Co-occurrence — and why the obvious reading of it is wrong

```
27 runs had 1 distinct failing test
 2 runs had 2 distinct failing tests
runs with BOTH a timeout and a status mismatch: 0 / 29
```

The tempting conclusion is that zero co-occurrence proves the timeout and status classes are
different defects. **It does not, and saying so would be the same error this record has caught
three times.** Failures here are *singular*: 27 of 29 runs contain exactly one failing test.
With about one failure per run, a run containing both a timeout and a status mismatch is
nearly impossible **whatever the underlying cause**, so observing none is what both hypotheses
predict. The measurement has no discriminating power and is reported as such.

**What the co-occurrence data does establish** is the singularity itself: whatever this is, it
strikes **one test per run**, not a state corruption that would take several with it. That is
a real constraint and it was cheap.

## Where this leaves the hunt

Open, and not yet narrowed by anything measured today:

- one defect or three — **undetermined**; the cheap test was run and cannot decide it
- the 401s, which imply the auth layer rejecting a request in a file whose other requests pass
- the concentration in `GET /agents/:id/events`, which survives the removal of the 501 class

**Deliberately not carried over:** every hypothesis eliminated in hunt one was eliminated
*against the mixed failure set*, which included 501s now known to be foreign. The known-false
list stands because those tests were mechanism-level rather than symptom-level — but any
conclusion in this document that rested on failure *rates* is now suspect, because roughly a
third of the failures being counted were not this defect at all.

**Nothing was disabled, retried or quarantined; production files remain byte-identical to
`main`.**

---

# Hunt two, round two, 2026-08-03: the rate correction, and an instrument for the 401s

## First, a correction that changes how this whole document should be read

**Mechanism-level eliminations survive. Conclusions that rested on failure RATES do not.**

Roughly a third of every failure counted in this record — 13 of 42 in the mined corpus — was
a foreign 501 written by another process, not this defect. So:

**The 25% in the original brief was never measuring one thing.** Neither was the 7/20, the
~23%, the 15.0% vs 7.5% arms comparison, or any other rate quoted here. Each was a blend of at
least two unrelated failure sources in unknown proportion, and the proportion varied by
machine, because one of the sources was a daemon that happens to run on this laptop.

That does **not** reinstate the eliminated hypotheses: those were killed by mechanism — a file
with zero `Once(` calls that flakes, a free event loop during a timeout, a drained queue at
49% on green runs — and a mechanism argument does not care what the base rate was. But any
sentence in this document that compares two rates, or infers something from a rate moving,
should be read as measuring a blend. **The arms comparison in round three is the clearest
casualty**: 15.0% against 7.5% could have been driven entirely by how many foreign 501s each
arm happened to collect.

## The 401s: six failures, and the logs cannot say why

```
6x 401, across 6 different files and 6 different expectations (200, 409, 201)
```

`services/api/src/middleware/auth.ts` has five distinct 401 paths, and line 41 is:

```js
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
```

**A bare `catch` with no binding.** The underlying `jsonwebtoken` error is discarded, and jest
prints only the asserted status — so every 401 in 623 logs is causeless. Grepping the six
failing logs for any of the five messages returns nothing.

This is not a theory about the cause; it is why the existing corpus cannot choose between the
candidate causes at all.

## The probe, and its control

`services/api/jest.auth401.js`, `AUTH_401_PROBE=1`, off by default, **production files
untouched**. It wraps `jsonwebtoken.verify` to record what was actually thrown, and
`res.json` to record which of the five 401 bodies was sent.

The four candidate causes map onto distinguishable evidence:

| Cause | Signature it would leave |
|---|---|
| expiry racing a slow test / clock skew | `TokenExpiredError`, with `expiredAt` and `now` |
| key material differs, signer vs verifier | `JsonWebTokenError: invalid signature` |
| request reached the wrong verifier | `JsonWebTokenError: jwt issuer/audience invalid` |
| request lost its header | body `Missing or invalid Authorization header` |

**Positive-controlled by forcing three of them**, before any null is believed:

```
verify threw: TokenExpiredError | jwt expired      | expiredAt 2026-08-03T11:20:01.000Z
verify threw: JsonWebTokenError | invalid signature | expiredAt None
sent 401 body: {"error":"Invalid or expired token"}
sent 401 body: {"error":"Invalid or expired token"}
sent 401 body: {"error":"Missing or invalid Authorization header"}
-> PASS: expiry and wrong-key are distinguishable, and the missing-header path is named
```

Note what the control also shows: **expiry and wrong-key produce the same 401 body.** Reading
the body alone would have conflated them — the `verify` wrapper is what separates them, and
without it a null on "it isn't expiry" would have been unfounded.

Verified shipped and inert by default:

```
default   : ["<rootDir>/jest.portguard.js"]
with probe: ["<rootDir>/jest.portguard.js","<rootDir>/jest.auth401.js"]
installed rows when enabled: 1
```

## Status

The probe is built, controlled and shipped; **no 401 has been captured with it yet.** At six
occurrences in 623 logs the event is rare, and no claim about the cause is made here — the
next batch run with `AUTH_401_PROBE=1` will name it, or will show a null that is now worth
something because the instrument has been seen to fire.

**Nothing was disabled, retried or quarantined; production files remain byte-identical to
`main`.**

---

# Hunt two, round three, 2026-08-03: a mechanism that produces 401 and 404 from one cause

Built on mechanism, not frequency, because frequency here is contaminated.

## Why waiting was not the plan

Six 401s in 623 logs is ≈1% per run, so catching one with 95% confidence needs
`ln(0.05)/ln(0.99)` ≈ **298 runs**. The probe from the previous round is shipped and ready for
whoever pays that, but the question is answerable at mechanism level for free.

## What the 401 paths require

```js
const signingKey = await opts.getSigningKey(decoded.header);
const payload = jwt.verify(token, signingKey, { algorithms: ['RS256'], issuer: opts.issuer });
```

A 401 needs the token to fail against **the key material or the issuer that this particular
app instance was configured with.** So "the request reached a verifier the test did not
configure" is not a vague worry — it is precisely what this code punishes.

## The corpus makes that possible, and the numbers are stark

```
test files generating their OWN keypair: 42 of 59
distinct issuers across files:           41x realms/hill90   (one value)
```

**Forty-two of fifty-nine test files mint a fresh RSA keypair at module load.** Every jest
worker therefore runs an app that trusts a *different* public key, while all of them use the
same issuer. So the issuer is not the discriminator — **the key is**, and a token is valid for
exactly one worker's app and invalid for all the others.

## The demonstration

A token minted for app A, presented to app B — the sibling-worker case:

```
CONTROL  token A -> app A, route exists : 200
CROSS    token A -> app B (other key)   : 401
CROSS    token B -> app B, route ABSENT : 404
```

**One mechanism produces both dominant surviving symptoms.** A request arriving at another
worker's server yields **401** when the key differs, and **404** when that app does not mount
the route the test asked for. The surviving set is 8× timeout, 6× `200->404`, 4× `200->400`,
4× `200->401` — and 401-plus-404 is what this predicts, without needing a second theory for
each.

It is the same shape as the port collision closed earlier today: **the request arriving
somewhere other than where the test believes.** That shape is no longer speculative in this
codebase — it was demonstrated once with a foreign daemon and is now demonstrated to produce
the surviving symptom set when the wrong destination is a sibling worker.

## Stated as a lead, and the gap it exposes

**This is not proof that cross-worker arrival happens.** It proves that *if* it happens the
symptoms match. No instance has been captured.

And there is a hole worth naming immediately: **the foreign-response guard shipped in round
fifteen cannot detect this case.** It identifies a stranger by the presence of a `Server:`
header, which express does not set — so a sibling worker's response looks exactly like our
own. The guard closes the daemon case and is blind to the worker case.

## The detector this needs

Each app instance should stamp a response header identifying the worker and test file that
produced it, and the client side should assert that the stamp matches the app it believes it
called. A mismatch is then caught at the moment it happens, with both identities named, rather
than inferred from a status code.

That is test-side, needs no production change, and — unlike a status code — **cannot be
confused with a legitimate response**, which is the property every instrument in this
investigation has needed and three of them lacked.

**Nothing was disabled, retried or quarantined; production files remain byte-identical to
`main`.**

---

# Hunt two, round four, 2026-08-03: the identity guard, and it supersedes the Server-header guard

## What it does

Every response this worker writes is stamped `x-test-app-id: <pid>:<JEST_WORKER_ID>`, patched
onto `http.ServerResponse` from a jest setup file. The client side reads the stamp off the
wire and asserts it is **ours**. One check catches two different intruders:

- **NO STAMP** — the responder is not this suite at all. The round-fifteen daemon writes raw
  HTTP and never touches `ServerResponse`, so it cannot be stamped.
- **FOREIGN STAMP** — a **sibling jest worker** answered. Its app carries a different RSA
  keypair (42 of 59 files mint their own) and a different route table, which is how a spurious
  401 or 404 reaches a test that did nothing wrong.

**Why this is the strongest instrument in the investigation:** a status code can always be a
legitimate answer, so every earlier check had to infer. A stamp cannot be mistaken for a
legitimate response — it is ours or it is not. That is the property the mock counter, the
global `jest.fn` hook and the byte recorder all lacked, and all three reported clean results
that were wrong.

## Controlled — and the first attempt at the control failed

A sound design is not a working implementation, so all three cases were forced.

```
✓ A: a normal response from OUR app passes
✕ B: FOREIGN STAMP — a sibling worker answering must fail this test
     FOREIGN STAMP  HTTP/1.1 401 Unauthorized  from 127.0.0.1:59606
         produced by 99999:9, this worker is 78273:1
```

**Control C failed on its first attempt — it timed out at 5002ms instead of firing**, because
it emulated the stranger with an `http.createServer` whose response the guard stamps anyway,
then tried to remove the header after it was sent. Rewritten as a **raw TCP server** writing
HTTP by hand — which is exactly what the daemon does on the wire:

```
✕ NO STAMP — a raw stranger writing HTTP by hand must fail this test
     NO STAMP       HTTP/1.1 501 Not Implemented  from 127.0.0.1:59942
         Server: websocket-sharp/1.0
```

Had that control been left as written, the NO-STAMP path would have shipped unproven. It is
the fourth time in this investigation an instrument would have lied if it had not been forced.

## Does it supersede the Server-header guard? Yes — demonstrated, not argued

**Control C is the 501 collision reproduced byte for byte**, down to
`Server: websocket-sharp/1.0`, and the identity guard catches it as `NO STAMP`.

So the round-fifteen guard detects a strict subset of what this detects:

| Case | Server-header guard | Identity guard |
|---|---|---|
| foreign daemon (501) | caught | **caught** |
| sibling worker (401/404) | **blind** | **caught** |
| our own response | ignored | ignored |

`jest.portguard.js` is therefore **deleted, not retained.** Carrying two overlapping guards is
how one rots unnoticed — and the one that would have rotted is the weaker one, which is worse,
because its silence would have read as evidence.

## Verified non-destructive

The guard patches `http.ServerResponse` globally, so it had to be shown not to change the
suite:

```
Test Suites: 29 passed, 29 total
Tests:       301 passed, 301 total
```

Half A passes unchanged with every response stamped, and the guard is **on by default** —
it is a guard, not a diagnostic.

## What it will now tell us, and what it does not claim

Round three demonstrated that cross-worker arrival *would* produce 401 and 404. **No instance
has been captured, and this section claims none.** What has changed is that the next one
identifies itself: the failure message names the worker that answered and the worker that
should have, so the question is settled by a single occurrence rather than by another
investigation.

**Nothing was disabled, retried or quarantined; production files remain byte-identical to
`main`.**

## Correction, same day: the identity guard had a false positive, and CI caught it

**The guard was verified against half A and shipped. CI failed on the full suite.**

```
● terminal websocket handshake › lets an allowed origin ... THROUGH both security gates
  NO STAMP  HTTP/1.1 404 Not Found  from 127.0.0.1:34753
● terminal websocket handshake › REFUSES a cross-origin handshake
  NO STAMP  HTTP/1.1 403 Forbidden  from 127.0.0.1:42587
```

Those are **our own responses.** A websocket upgrade rejection is written by `ws` straight to
the socket and never passes through `http.ServerResponse`, so it cannot be stamped. The guard
called our own app a stranger.

**The local verification missed it because it ran half A, and those tests are in half B.** The
instrument was controlled — three cases, all passing — and still shipped a defect, because the
control covered the cases I had thought of. That is the fifth instrument failure in this
investigation and the first found by CI rather than by a control.

**Fix:** a missing stamp is a violation only when the responder is on a port **this process
never bound**. Our own listeners are recorded via `net.Server.prototype.listen`; a foreign
daemon is on a port we never bound, `ws` is not.

Re-controlled in both directions, the second case deliberately in **another process** so its
port cannot be in our set:

```
✓ OUR unstampable response (ws-style raw write on OUR port) must NOT fire
✕ CONTROL: a stranger in ANOTHER process must still fail this test
     NO STAMP  HTTP/1.1 501 Not Implemented  Server: websocket-sharp/1.0
```

And verified against **the full suite this time**, which is what CI runs:

```
Test Suites: 61 passed, 61 total
Tests:       786 passed, 786 total
```

**The lesson worth keeping:** "positive-controlled" means the control covered the cases the
author imagined. Half A was a convenient corpus for fourteen rounds of hunting and a bad
corpus for validating a global guard, and nothing in the process flagged the difference.

## Correction 2: the identity guard's own fix reopened the hole it closed

**Observed in a real failing run, not in a control.** Half A run 7 failed with
`Expected: 409 / Received: 501` and `Expected: 201 / Received: 501` — the foreign-daemon
signature — and the guard printed **nothing**:

```
IDENTITY VIOLATION in run 7: 0
```

**Seventh instrument failure in this investigation.** Treated as an instrument problem first,
as it should be.

**Cause.** The websocket false-positive fix suppressed a missing stamp when the responder was
on a port "we bound". That set was **append-only**. supertest binds and closes an ephemeral
port per request, the OS returns the number to the pool, and the daemon can answer on the same
number later in the same run — at which point the guard classified a stranger as ours and went
quiet. The fix for one blind spot created another.

**Fix:** a port is ours only *while held*. `ourPorts` now deletes on `close`.

**And the first control for the fix was invalid**, which is worth recording because it passed:

```
✓ a stranger on a port WE PREVIOUSLY HELD must still be caught      <- WRONG, should fail
```

The "stranger" was created in **our own process**, and the guard wraps
`net.Server.prototype.listen` globally — so the stranger's own `listen` re-registered its port
as ours. A same-process stranger cannot be a stranger. Redone with the responder in a **child
process**:

```
✕ a stranger on a port WE PREVIOUSLY HELD must still be caught
     NO STAMP  HTTP/1.1 501 Not Implemented  Server: websocket-sharp/1.0
```

Full suite still passes with the ws case unaffected: **62 suites, 788 tests**.

## The 401 classification, first reading — SUPERSEDED, and its runs later discarded

> **Read the next section instead.** This was written at 19 runs. Those 19 are part of the
> batch that the following section discards as contaminated — the branch was switched
> underneath it, so its runs did not all execute the same code. **The count below is not
> usable.** The conclusion it reached happens to have survived at 42 runs, but it survived on
> the later corpus, not this one, and a number that came from a discarded batch should not be
> quoted from here. Kept visible rather than deleted, because a retracted reading is evidence
> about how the investigation went.

Nineteen runs of half A with the probe live produced **one failure, and it was a 501**, not a
401. Every probe row so far comes from tests that assert 401 deliberately —
`Cross-auth boundary AB-1/AB-2` (Ed25519, `invalid algorithm`) and the
`Missing or invalid Authorization header` negative tests.

**So no spurious 401 has been captured, and none of the four candidates can be assigned yet.**
The probe fires correctly; what it fires on is intentional. A spurious 401 is only identifiable
by correlating with a *failing* assertion, and at roughly 1% per run that needs ~300.

**A caveat for whoever reads the probe output:** it cannot distinguish an intended 401 from a
spurious one on its own. That is not a defect — it is why the `auth.ts` cause-preservation
matters more than the probe: a spurious 401 in CI now names its own cause in the log without
anyone running a batch.

**Nothing was disabled, retried or quarantined; the guard's behaviour on legitimate traffic is
unchanged.**

## The 401 classification: still unassigned after 42 runs, and one batch discarded

**Where it stands: no spurious 401 has been captured, so none of the four candidates —
expiry, wrong key, expiry racing a slow test, or reaching a verifier the test did not
configure — can be assigned to any of the six.**

### The six cannot be classified retrospectively

This is worth stating once, plainly, because it will otherwise be asked again. The six 401s
live in logs written *before* `auth.ts` preserved the cause and before the probe existed. The
information that would classify them was discarded at the moment they happened, by the bare
`catch {}`. **It no longer exists.** Only a *new* 401 can be classified, and it will be —
by `auth.ts` itself, without a probe or a batch.

### 42 runs, one failure, and it was a 501

The single failure in that batch was `409 -> 501` / `201 -> 501`, the foreign-daemon
signature — the failure that exposed the recycled-port hole in the identity guard. Not a 401.

Every probe row so far is from a test that asserts 401 **deliberately**:
`Cross-auth boundary AB-1/AB-2` (Ed25519 → `invalid algorithm`) and the
`Missing or invalid Authorization header` negatives. The probe fires; what it fires on is
intended.

### The batch was discarded, and why

Runs 1–42 spanned three merges — `#113`, `#114`, `#115` — because the branch was switched
underneath a running batch. **The runs therefore did not all execute the same code**, which
makes the corpus unusable for a rate and unsafe for a null. It is recorded as discarded rather
than quietly reported, and restarted on merged `main` with a clean tree.

That is a methodology error of the same family this document keeps finding: a measurement
whose conditions changed mid-flight looks exactly like a measurement whose conditions did not.

### What would change the answer

At roughly 1% per run a spurious 401 needs ~300 runs to appear with confidence. The clean
batch was running `as of 2026-08-03` — an undated live status when first written, which is
the very failure this document formalised two sections later; its result is not recorded here
and should not be inferred. But the practical point is that **the batch is no longer the mechanism that
answers this** — `auth.ts` now logs the cause on every 401, in CI and locally, so the next
occurrence classifies itself in the ordinary course of someone's failing build.

**If a failing run ever shows a spurious 401 with no probe row and no `[auth] token rejected`
line, suspect the instrument before the theory.** Seven have misled today, and the pattern is
that the convenient result is the dangerous one.

---

# First-line diagnostic for any suspected flake: does it pass alone?

**Promoted out of the narrative because it decided two separate investigations today and
costs one run.**

Before any instrument, any hypothesis and any batch, run the failing test **by itself**:

```
api  routes-agents-events, platform-eligibility, platform-models, routes-notifications
       0 failures in 30 runs each, alone — 0/90 — against 11 failures in company
ui   DashboardClient.test.tsx
       0 failures in 20 runs alone; 0 in 8 full-suite runs locally; 3 failures in CI
```

What it buys, immediately and cheaply:

- **It passes alone → the defect needs company.** Every single-file theory is dead before it
  is written, and the search space becomes interaction, environment or infrastructure.
- **It fails alone → the defect is in that file**, and the whole cross-file search is
  unnecessary. Fourteen rounds of this document would have been avoidable if that had been the
  answer.
- **It cannot be run alone → that is itself a finding** about the suite's coupling.

It is not a substitute for characterisation. It is what runs *before* it, because a wrong
answer here sends the next week in the wrong direction.

---

# services/ui (issue #117): characterised, unresolved

Same discipline, deliberately not hunted.

## It passes alone

```
DashboardClient.test.tsx, isolated:      0 / 20 failed
full ui suite, locally:                  0 / 8  failed
CI:                                      3 failures today (app#114 once, app#116 twice)
main's own ui job:                       0 / 5 most recent runs — green at HEAD aa7aed4
```

**So: not a broken `main`, not infrastructure, and not caused by the PRs that surfaced it** —
app#116 was docs-only and app#114 touched only `services/api`. It needs company *and* CI.

## The actual assertion, which the issue did not have

```
× DashboardClient > renders active agents widget with running agents
  → Unable to find an element with the text: Scout
    TestingLibraryElementError
```

Not a crash, not a timeout, not a network error: a rendered element that was **not there yet**
when a synchronous query looked for it.

## One structural fact, offered as a fact

```ts
await waitFor(() => {
  expect(screen.getByText('Active Agents')).toBeInTheDocument()   // line 199, awaited
})
expect(screen.getByText('Scout')).toBeInTheDocument()             // line 202, NOT awaited
```

The assertion that fails is **synchronous and outside the `waitFor`** that guards the one
before it. If `Scout` arrives in a later tick than `Active Agents`, the second assertion races
the render.

**That is a candidate consistent with the observed error, not the cause.** It has not been
tested, and this document's history is emphatic about the difference — a plausible mechanism
that matched the symptoms was wrong at least four times today.

**What would settle it cheaply:** change nothing, and instead assert `findByText('Scout')` in a
throwaway copy under the CI-like conditions that reproduce it. If it stops failing, the race
is real; if it still fails, the synchronous query is innocent and the data itself is missing.
Neither is a fix — the fix follows the answer.

## Status: unresolved

The rate is 3 CI failures against 0 in 28 local runs. That is enough to say **CI-only so far**
and not enough to quote a rate, and no rate is quoted. **Nothing was retried to green** — the
job was diagnosed rather than re-run, because a retry that passes establishes only that it is
flaky, which #117 already records.

## The findByText check: ambiguous, and why that is the answer

**The check cannot be run decisively, so it was not run to a conclusion.** Saying ambiguous
rather than manufacturing a verdict.

`findByText` only distinguishes anything under conditions where the failure occurs. It does
not occur locally, so a green result would restate what 28 earlier runs already said.

### Attempts to reproduce it locally, all negative

CI-only is a lead, and the differences worth suspecting are timing, machine speed, locale,
timezone and headless rendering. Three were tested directly:

```
file alone, unloaded                      0 / 3
file alone, 12 busy loops on 11 cores     0 / 6      (machine speed / contention)
TZ=UTC                                    0 / 3      (CI runners are UTC; this host is EDT)
LANG=C LC_ALL=C                           0 / 3      (locale)
TZ=UTC LANG=C LC_ALL=C                    0 / 3
```

With the earlier 0/20 isolated and 0/8 full-suite, that is **roughly 40 local runs across four
emulated CI conditions and not one failure.**

**Negative results, which are still results:** raw CPU contention does not cause it, timezone
does not, locale does not. Headless rendering is not a difference at all — vitest uses jsdom
in both places. What remains untested is worker count, memory pressure, Node version, and
CI-specific environment.

### Why this was not resolved by running it in CI

The obvious move is to change the assertion to `findByText` and watch CI. **That is the move
this record exists to prevent.** If CI then goes green, nothing has been learned: it is
indistinguishable from the flake simply not occurring, and a change that makes a suite green
without explaining it is the failure mode named on the first page.

**A design that would be legitimate**, and is offered rather than performed: add a `findByText`
assertion *alongside* the existing synchronous one rather than replacing it, so both run and
their disagreement is the signal. If the sync assertion fails while the async one succeeds in
the same run, the race is demonstrated. If both fail, the data is genuinely absent and the
query style is innocent. Neither outcome changes behaviour, and neither can be mistaken for
the flake having gone away.

### Status

**Ambiguous, and #117 stays open and unresolved.** The candidate from the previous section —
line 202 asserting synchronously outside the `waitFor` — is neither confirmed nor eliminated.
It remains consistent with the observed error and unsupported by any measurement.

Fifth time today that declining to resolve something the evidence did not resolve was the
correct call, and it cost one section.

## The paired assertion is now in the tree

`DashboardClient.test.tsx` asserts `Scout` **twice** — `findByText` and then the original
`getByText` — with the sync one deliberately kept. Replacing it would very likely turn CI green
while teaching nothing, which is indistinguishable from the flake not occurring.

Running both makes their **disagreement** the signal:

- sync fails while async passes → the race is real, and the query style is the cause
- both fail → the data is genuinely absent and the query style is innocent

Neither outcome changes behaviour, and neither can be mistaken for the flake having gone away.
Passes locally, 11/11, as expected — locally it always did.

## Why the discipline is worth its cost, in the only currency that matters

Stated plainly because it is the argument for everything above:

> **Refusing to resolve what the evidence did not resolve cost one section, and saved a fifth
> wrong mechanism.**

Four had already been retracted the same day — the drained queue, express-to-express
cross-talk, port reuse, the closing-server race — each of which had matched the symptoms,
each of which had felt like an answer. The fifth would have been the line-202 race, declared
on a green CI run that proved nothing.

One section against a wrong mechanism in the record is not a close call. And the asymmetry
compounds: a retracted mechanism is not merely wrong, it redirects whoever reads it next, which
is how this investigation lost several rounds to a rate that was never measuring one thing.

---

# The #127 leak class, swept across both suites, 2026-08-03

`#127` fixed one instance of a specific shape: **a global is replaced, and the call that
puts it back sits on a path a rejection skips** — there, `warn.mockRestore()` inside a
`.then()`. The obvious follow-up question is whether that shape occurs anywhere else. It
was asked of every file in `services/api/src/__tests__` (60) and `services/ui/src` (68).

**The shape is broader than `.then()`.** A restore written as the last statement of a test
body is the same defect: an assertion that throws above it skips it just as a rejection
skips a `.then()`. Both suites were searched for the general form — spy/stub created, and
its restore reachable only on the success path.

## The instrument, and its null arm

Neither `services/api/jest.config.js` nor `services/ui/vitest.config.ts` sets
`restoreMocks`, so nothing restores a spy automatically. That was **not** taken on
inspection. A two-arm control was run under the ui project's own config:

```
positive arm: test A spies on window.confirm, throws before mockRestore()
              → B reports vi.isMockFunction(window.confirm) === true   (LEAK)
null arm:     test A identical but reaches mockRestore(), with the
              vi.clearAllMocks() beforeEach the real files use
              → B reports false                                       (NO LEAK)
```

Both arms behaved as designed, so the instrument distinguishes the thing it claims to.
`vi.clearAllMocks()` — which several of these files do call — clears call history and does
**not** restore an implementation; that is why a `beforeEach` already present is not cover.

## `services/api`: no instance. The #127 fix was the only one

Every other spy in the api suite is created in `beforeEach` and restored in `afterEach`,
which runs whether the test passed or threw: `audit`, `terminal-proxy-handshake`,
`routes-container-profiles`, `routes-agents-skills`, `routes-skills`, `docker-service`,
`sse-timer-cleanup`, and both `routes-chat` audit describes. `routes-chat.test.ts:995`
already uses `try/finally`.

**Environment mutation inside test bodies was checked as the same class and is also
covered**: the `delete process.env.DATABASE_URL` in `routes-agents`, `routes-model-policies`
and `routes-eligible-models`, and the `CHAT_CALLBACK_TOKEN`/`AGENTBOX_CONFIG_HOST_PATH`
deletions, are all re-set by a `beforeEach`. A skipped restore there changes nothing.

**One candidate looked live and is not — recorded so it is not "fixed" again.**
`routes-chat.test.ts:1190` and `:1217` assign `MAX_CHAIN_HOPS` and `MAX_CHAIN_DURATION_MS`
and delete them at the end of the test body, with no `beforeEach` covering them. But
`services/api/src/routes/chat.ts:39-40` reads both into module-level `const`s at import
time, so neither the assignment nor a leaked value can reach a handler. The writes are
inert in both directions. (They are also equal to the defaults, which is why those tests
pass: the assertion is real, the env line is decoration and reads as though it is not.)

**One latent instance was hardened:** `tool-installer.test.ts:446` restored
`HILL90_TOOL_INSTALL_RETRIES` after its assertion, and set `global.fetch` without ever
restoring it. Inert only because it is the file's last test — an accident of ordering, not
a property. Now `try/finally`.

## `services/ui`: five instances, three of them live

| File | Site | Global left behind | Live? |
|---|---|---|---|
| `ModelsClient.test.tsx` | `:180` | `window.confirm` → `false` | **yes** — 24 later tests |
| `ConnectionsClient.test.tsx` | `:208` | `window.confirm` → `false` | **yes** — ~20 later tests, incl. the Health Tab describe |
| `auth-callbacks.test.ts` | `:98`, `:121` | stubbed `fetch` | **yes** — leaks into the session-callback describe |
| `PoliciesClient.test.tsx` | `:207` | `window.confirm` → `false` | no — last test in file |
| `api-proxy.test.ts` | `:141` | `console.error` swallowed | no — last test in file |

`api-proxy.test.ts:141` is the closest match to #127 of all of them: a swallowed
`console.error`, the same global, the same consequence. It is inert purely because nothing
follows it.

All five are now `try/finally`, or `afterEach` where the file's shape made that cleaner
(`auth-callbacks`). Full ui suite after: **68 files, 767 passed, 7 skipped**.
`tool-installer.test.ts` alone after: **31 passed**. The api suite was not run as a whole,
because a green run of it is not evidence and quoting one here would contradict this
document's first page.

## What this is worth, stated narrowly

**No live instance was found in the api suite**, so this does not touch the flake this
document is about, and nothing here should be read as a lead on it. What it changes is
the *failure mode after a failure*: in three ui files a single failing assertion silently
mutated a global for every later test in the file, which turns one honest failure into a
run whose later results cannot be trusted either. That is worth removing on its own
merits, and it is the whole claim.

**No regression test, for #127's reason.** A test that drives these leaks needs the guarded
test to fail, which is exactly what a suite cannot assert about itself. The two-arm control
above is the evidence, and it was run rather than reasoned; it is deliberately not committed,
because a test file whose positive arm must fail cannot live in a green suite.

## Does the #130 leak class explain #117? No — and the reasons are measurements, not inference

Asked after #130 fixed five restore-not-in-`finally` sites in `services/ui`, three of them
live. If those leaks were firing, the flake and the fix should be causally connected, and
the check is whether the failing test is downstream of a leaking one. **It is not, on three
independent grounds, and the third makes the ordering question void.**

### 1. The leak never fired in any of the three CI failures

A skipped restore is **conditional**: it only happens if the guarded test throws first.
Pulled from the CI logs of all three known failures:

| Run | PR | Failing file | Rest of the suite |
|---|---|---|---|
| 30811619768 | #114 | `DashboardClient.test.tsx` | **67 passed (68)** |
| 30813368511 | #116 | `DashboardClient.test.tsx` | **67 passed (68)** |
| 30813600887 | #116 | `DashboardClient.test.tsx` | **67 passed (68)** |

`ModelsClient`, `ConnectionsClient`, `auth-callbacks`, `PoliciesClient` and `api-proxy` —
every file that carried a leak — **passed in all three runs**. No guarded test threw, so no
restore was skipped, so nothing leaked. That alone is decisive and needed no experiment.

### 2. The leak cannot cross a file boundary anyway — measured in three arms

Two temporary control files: A leaks `window.confirm` by throwing before `mockRestore()`;
B checks whether A's leak arrived, **and leaks in-file itself as a positive control in the
same run**, so a null from B is only believable if B's own detector visibly fires.

| Arm | cross-file (B1) | in-file positive control (B3) |
|---|---|---|
| default settings, as CI runs | **not mocked** | **mocked** |
| `--no-file-parallelism --poolOptions.forks.singleFork` | **not mocked** | **mocked** |
| the above plus `--isolate=false` | **not mocked** | **mocked** |

The detector fires every time on the in-file leak and never on the cross-file one, including
with isolation explicitly disabled and both files in one process. **So "downstream in file
order" is not a question that can be answered yes: the boundary is not permeable.** The
controls are not committed — a file whose positive arm must fail cannot live in a green suite.

### 3. `DashboardClient.test.tsx` contains no member of the class

No `spyOn`, no unrestored stub. Its `fetch` is a module-level `vi.stubGlobal`, and the one
test that reconfigures it (`shows platform overview even when some fetches fail`,
immediately before the failing test) is overwritten by `mockFetchDefaults()` in `beforeEach`
— checked, because `vi.clearAllMocks()` does *not* clear an implementation and that would
have been a real in-file leak returning `[]` for `/api/agents`, which is exactly the observed
symptom. It does not happen: the implementation is re-installed every test.

**Verdict: it does not explain #117.** Not "partly" — there is no path by which it could
contribute, and no run in which it was even armed.

### What the CI logs did give up, which #117 does not record

**One run failed two tests, not one.** Run 30813368511 failed *renders active agents widget*
(`Scout`) **and** *renders recent chat threads widget* (`Deploy discussion`). Both have the
identical shape:

```ts
await waitFor(() => expect(screen.getByText('Active Agents')).toBeInTheDocument())  // heading
expect(screen.getByText('Scout')).toBeInTheDocument()                               // content, sync

await waitFor(() => expect(screen.getByText('Recent Chats')).toBeInTheDocument())   // heading
expect(screen.getByText('Deploy discussion')).toBeInTheDocument()                   // content, sync
```

In both, the `waitFor` guards the widget **heading** and the synchronous query then asks for
**data-dependent content**. Two different widgets failing the same way in one run is
consistent with the line-202 race candidate and is evidence the candidate is not specific to
`Scout`. It remains a candidate: nothing here measures it.

**All three failures predate the paired assertion.** At `c1cc4407` and `4233f54f` and
`055578cb`, line 202 was the bare `expect(screen.getByText('Scout'))` with no `findByText`
before it. So the disagreement experiment recorded above has **not yet had a CI failure to
report on** — which is why #117 is still unresolved, and why the next CI failure of this test
is worth reading carefully rather than re-running.

**#117 stays open. Nothing was retried, quarantined or skipped.**

---

# Round twenty-one, 2026-08-03: round four's "one-second margin" does not hold in this tree

Round four recorded a structural fragility and called it the reason TIMEOUT is in this
suite's symptom set:

> Forty executions sit between 3s and 4.5s against a **5000ms** ceiling. They are the SSE
> poll tests … **The margin to jest's default timeout is about one second.**

**Measured today, and the premise is false for every test that waits on that poll.** There
are exactly two, both in `routes-agents-events.test.ts`, and both declare their own timeout:

| Test | sleeps | declares | margin |
|---|---|---|---|
| `T8: SSE inference poll events arrive after initial container events` | 4000ms | **10000ms** | 6000ms |
| `no duplicate inference events between SSE backfill and first poll` | 3500ms | **10000ms** | 6500ms |

A scan of every `it()` in the suite for a `setTimeout` of ≥2500ms found no other test that
waits that long, and none waiting on the poll under jest's 5000ms default. So
`INFERENCE_POLL_MS = 3000` is not producing a one-second margin anywhere that can be found.

**The likely origin of the original claim is a comparison against the default timeout without
checking per-test overrides** — round four measured durations, not durations-minus-their-own-
ceiling. That is worth naming because it is the same shape as several instrument errors in
this document: a measurement that is correct about what it measured and wrong about what it
meant.

**A scan of mine was wrong first, and in the same way.** Its regex matched each test's own
closing `}, 10000);` as if that were a sleep, so every row read `sleep=10000 timeout=10000
margin=0` — eleven "findings", all artefacts of the instrument. It was rewritten to brace-match
each `it()` call and take sleeps only from `setTimeout(...)`, then validated against the two
tests read by hand.

## What changed, and what it is worth

`INFERENCE_POLL_MS` is now read **per request** (default 3000, production unchanged), and the
two tests opt into 25ms for their own duration and delete it afterwards. Per request rather
than at module scope on purpose: a module-level constant would force every test in the process
onto one cadence, and this suite has an unexplained flake class that a global timing change
would put beyond ruling out.

**They wait on the condition, not the clock.** A shorter fixed sleep is still a race, just a
tighter one — and a tightened race is how a rare flake becomes a common one. Each test now
polls for the thing it is waiting for and stops when it is true, with a ceiling that fails
loudly:

    waitUntil(() => body.includes('container-first') && body.includes('inference-t8-poll'), ...)
    waitUntil(() => mockQuery.mock.calls.length >= 3, ...)

**That made T8 stricter, not just faster.** Its assertion used to read *"the poll may or may
not have fired yet"* and passed either way — it could not fail for the reason it existed.
Waiting for the event makes the ordering assertion unconditional.

Wall clock: the file drops from **11.0s to 2.8s**; the two executions that sat at 4005ms and
3518ms are gone.

## Whether this touches the 400/401/timeout classes: NOT ESTABLISHED, and here is everything

This suite has an unexplained flake class, so a timing change to it needs more than a shrug.
Three measurements, reported whole because the first one looked alarming.

| Design | with change | without | Fisher two-sided |
|---|---|---|---|
| Blocked — 12 runs of one arm, then 12 of the other | **5/12** | **1/12** | p = 0.155 |
| **Alternated** — with, without, with, without, 10 pairs | **3/10** | **4/10** | **p = 1.000** |
| Pooled | 8/22 | 5/22 | p = 0.510 |

**The blocked result is the one to discard, and this document already said why** before I
produced it: *"machine load drifts over half an hour and a block design confounds that drift
with the treatment"*. I ran the design this record warns against, got a frightening number, and
it did not survive alternation. It is recorded rather than deleted because a 5-versus-1 that
evaporates under a better design is exactly the shape of finding that gets published elsewhere.

**An earlier version of this section reported 10 runs with and 10 without at zero failures
each. That measurement was worthless and is withdrawn:** it ran the file ALONE, and this
document establishes across many rounds that the defect does not appear alone. It had no power
to detect anything.

**What cannot be claimed: independence.** 10 pairs cannot separate small differences — this
document's own arithmetic puts ~120 runs per arm behind separating 15% from 30%. The honest
statement is *no effect detected under a valid design*, not *no effect*. A reviewer who would
rather hold any timing change to this suite until the flake class is understood has a
defensible position, and the change is small to revert.

---

## PREDICTION, recorded before the retrospective pass

Written and committed **before** looking at the evidence, so this is a prediction and not a
description of what was found. The commit order in git is the proof; if the next section
agrees with this one, that ordering is the only thing separating a finding from a story.

**The hypothesis: 400, 401 and timeout are not three classes. They are one mechanism — a
response arriving from a socket that is not ours — of which the foreign daemon
(`LogiPluginService`, `websocket-sharp`, answering 501 on the ephemeral range) was the first
instance identified.**

The reasoning is the shape of every recorded symptom:

```
403 → 404      201 → 400      501 → 404
200 → 400      200 → 404      timeout
```

Each is *expected X, received Y* where Y is a **well-formed answer to a different question**.
This record already insists they are "not a crash, not a timeout, not a connection error" — so
they are real HTTP responses that belong to somebody else's request. The timeout is the same
event with the response never arriving rather than arriving wrong; it needs no separate theory.

**Why it looked like three classes: the assertion captured the status code and nothing else.**
Not the responder, not the socket, not whether the process was ours. Given only a number, a
single mechanism with a varying responder *must* present as a family of unrelated classes. The
taxonomy is an artefact of the instrument, in the same way the first `#117` recorder gave one
verdict for two states — there one hook collapsed two states into one answer, here one field
expands one state into many.

### How this is falsified

**A captured occurrence bearing a CORRECT identity stamp with a wrong body.** That would mean
the response was ours, from our process, and simply wrong — a genuine logic race, and this
hypothesis is dead. Nothing else falsifies it; in particular a run of green tests does not.

### What the retrospective can and cannot do, said in advance

The six original 401s **predate the identity stamp**, and this record already states they cannot
be classified retrospectively. So the likely outcome is *unclassifiable*, and that is where the
trap is:

> **"Cannot classify retrospectively" must not become "no evidence of a problem."** They are
> different sentences. The first is a statement about the instrument; the second is a claim
> about the world, and nothing here would support it.

I am the party most likely to make that slide, because the flattering reading — *nothing found,
therefore probably fixed by the port work* — is the one that suits the hypothesis above. It is
recorded here so the next reader can hold me to it, and so I can. **42 clean runs is not
evidence of absence** when this document's own arithmetic puts ~300 runs behind a ~1% event.

If the retrospective cannot classify, the correct action is not another 42 runs. It is the `#117`
move: make sure the next occurrence carries the identity field, prove the recorder works in
**both** arms, and wait. Waiting with a proven recorder is a result.

## RETROSPECTIVE RESULT — the prediction is partly refuted

Written after the pass. The prediction above is in the preceding commit; this is a separate one,
so the order stands on its own.

### 1. It cannot be classified retrospectively — confirmed, and that is a statement about the instrument

Every 400, 401 and timeout in this record predates the identity stamp. This document already
said so; the pass confirms it rather than discovering it. **That is not evidence of absence, and
it is not support for the hypothesis.** It is the absence of a field, in occurrences that
happened before anyone thought to record it.

### 2. One reading of the prediction is REFUTED by data already here

The 60-run table shows the two non-501 failures occurring with **zero foreign responses in the
same run**:

| Run | foreign responses | received | class |
|---|---|---|---|
| 3 | 8 | 501 | 501 |
| 43 | 8 | 501 | 501 |
| **26** | **0** | — | **TIMEOUT** |
| **45** | **0** | 401 | **401** |

So the **foreign-daemon** variant does not explain the 401 or the timeout. The daemon was
absent from both runs. My prediction named the daemon as "the first instance identified" of the
mechanism, and on the strength of this table the daemon reading is dead for these two classes.

### 3. The sibling-worker variant survives, and is demonstrated CAPABLE — not demonstrated as the cause

The identity guard's own control produced exactly this:

```
✕ B: FOREIGN STAMP — a sibling worker answering must fail this test
     FOREIGN STAMP  HTTP/1.1 401 Unauthorized  from 127.0.0.1:59606
         produced by 99999:9, this worker is 78273:1
```

A **spurious 401 from a sibling jest worker**, with a different keypair and route table. That is
the mechanism I predicted, with a different responder — and it is proven *possible*. It has
never been caught in the wild. "Capable of producing the symptom" and "produced the symptom" are
different claims and only the first is established.

**Net: the hypothesis is narrowed, not confirmed.** One responder is excluded; another remains
live and unobserved. It is still falsified by the same single thing — a correct stamp with a
wrong body.

### 4. The gap that actually blocks progress: the guard has NO COMMITTED CONTROL

`jest.identityguard.js` is wired through `jest.config.js` and runs on every suite. Searching the
tree for a test that exercises it returns **nothing**. Its three arms were forced by hand during
the investigation and written up here; no file keeps them forced.

That matters more than it sounds, because this record documents **two holes already found in
this guard after it was working**: the recycled-port hole, and a websocket false-positive fix
that suppressed a missing stamp. Both were found by accident rather than by a control.

So the instrument this whole investigation now depends on is in exactly the state the `#117`
recorder was in before it was controlled: believed good, never watched working, and with a
history of silently losing an arm. **A guard that has lost an arm reports clean, and clean is
the answer that would flatter the hypothesis above.**

### What happens next, and what must not

The `#117` move, applied here: give `jest.identityguard.js` a committed control that forces all
three arms — ours, foreign stamp, no stamp — prove it fails on each, and only then let a run of
green mean anything. Then wait.

**Not** another 42 runs. This document's arithmetic puts ~300 behind a ~1% event, and 42 clean
runs with an unproven guard is two unknowns multiplied together.

## OBSERVED: a foreign responder producing a spurious failure in a sibling worker

**Provenance, stated first because it governs what this is worth: I built the responder.**
This is not evidence that the mechanism occurs naturally. It is evidence that the mechanism is
**real rather than theoretical**, and that the `NO STAMP` arm of `jest.identityguard.js` is
**live** — it fired unprompted, on a genuine foreign responder, in a worker that had done
nothing wrong.

### What happened

While building a committed control for the guard, arm C spawned a child process that bound an
**ephemeral** port and answered raw `HTTP/1.1 501`. Running the full suite:

```
without that file:   75 suites, 853 tests, all pass
with it:             routes-notifications.test.ts FAILS
that file alone:     11/11 pass
```

Supertest in a sibling jest worker allocated from the same ephemeral range, collided with the
child, received its raw 501, and the guard in **that** worker reported `NO STAMP`. Nobody
arranged the collision; it was a side effect.

### Why it matters, and exactly how far it goes

Until now the sibling-worker/foreign-responder mechanism was **demonstrated capable** — the
guard's hand-forced control produced a spurious 401 — but **never observed** outside a
deliberate arrangement. This is the first time in the investigation that a foreign responder has
been seen turning an unrelated test red in a real run.

What it establishes:

- the `NO STAMP` arm works in a real parallel run, not only when forced;
- a raw responder on the ephemeral range **does** reach sibling workers in this suite, which is
  the transport step the daemon hypothesis needs and which had never been shown;
- the failure it produces looks exactly like the recorded class: an unrelated test, a wrong
  status, no crash.

What it does **not** establish: that this happens without someone planting a listener. The
observed responder was mine. `LogiPluginService` remains the only naturally-occurring instance,
and it explains the 501 class only — runs 26 and 45 had zero foreign responses.

### The control itself is NOT in the tree, and why

Arm C cannot currently be shipped. Both available approaches fail for opposite reasons:

- **in-process** — the guard records every port this process opens in `ourPorts` and correctly
  suppresses a missing stamp from one of them, so an in-process raw server proves nothing;
- **out-of-process** — a faithful model of a rogue listener, running inside the suite it models,
  **is** a rogue listener. Binding an ephemeral port turned the suite red. Moving to a fixed port
  below the ephemeral range (19501) still destabilised it — 3 failures on one run, 59 on the
  next — for reasons not yet diagnosed.

Teardown was verified and is not the cause: zero leaked listeners after a normal run and after a
deliberately thrown test. The collision happens while the child is legitimately alive.

**Arms A (OURS) and B (FOREIGN STAMP) are controlled and pass.** Arm C — the arm with a known
history of breaking twice, and the one modelling the only responder observed in the wild —
remains unproven, and is handed over rather than shipped green. A control covering two of three
arms on this guard would be worse than none.


## Round eighteen (2026-08-05) — the doc catches up to the tree, then a real batch

The entries above end mid-problem, on 2026-08-03: arm C of `jest.identityguard.js`'s
control unshippable, the sibling-worker hypothesis "narrowed, not confirmed." Real
progress happened in git and issue history after that and was never folded back in here.
This section does both: reconciles the record, then reports a fresh 30-run batch.

**What actually shipped, in order, that this document never recorded:**

- **#179 → #338**: arm C shipped, using a Unix Domain Socket for the in-process raw
  responder — exempt from `ourPorts` (keyed by TCP port, `undefined` for UDS) without
  itself destabilising the suite the way a real ephemeral-port listener did. Arms A and C
  proven clean across two full 117-suite parallel runs.
- **#339 → #344**: arm B (FOREIGN STAMP) found failing 2/2 under real full-suite load
  despite passing every hand-built repro. Root cause: `jest.identityguard.js` is a
  `setupFilesAfterEnv` entry, re-executed fresh per test file, but `http.ServerResponse
  .prototype` is the same real Node object across every file sharing a worker — a
  module-scoped `stampValue` meant every file's setup stacked another monkey-patch layer,
  and the *oldest* layer always won on the wire, silently defeating any later file's
  control override. Fixed by moving state onto the shared prototype itself, keyed by a
  plain string (not `Symbol.for()`, whose registry is per-realm and doesn't collide across
  Jest's per-file realms).
- **#350**: asked CI to capture whatever the identity guard *and* the auth401 probe wrote,
  naming explicitly that the guard might not have the probe's already-fixed
  workspace-relative-path property. **#352 shipped only the probe's half** — the guard had
  zero file I/O until today.
- **#431 (this session, 2026-08-05)**: closed that other half. `jest.identityguard.js` now
  writes one JSONL row per violation that survives to fail a real test (not the control's
  own synthetic ones — verified both ways), CI's artifact step renamed and its comment
  expanded to cover both instruments, one new committed test spawning a real separate jest
  process to prove the write fires on the genuine fail path.

**Then a real batch, with the evidence gap finally closed:** 30 full-suite runs on top of
#431, `IDENTITY_GUARD_OUT` and `AUTH_401_PROBE=1` both set, every log and every run's
`identityguard.jsonl` inspected before being overwritten by the next run.

```
30 full-suite runs          11 failed          36.7%
identityguard.jsonl violations, all 30 runs, including all 11 failures:  ZERO
```

**Decisive negative result.** The doc's leading hypothesis since round seventeen —
sibling-jest-worker cross-talk, demonstrated *capable* but never naturally observed — is
now ruled out **for this batch's failures**: the guard durably records every stamp
mismatch or missing stamp, in every worker, and recorded nothing across all 11. Whatever
failed these 11 runs, it was not a response arriving from something other than this
worker's own correctly-routed app instance.

**A correlated, plausible, NOT confirmed replacement lead.** `routes-agents.test.ts` (4
failures) and `role-hierarchy.test.ts` (1) are the *only* two of the eight failing files
that exercise `POST /agents/:id/start` — the only route that calls the fire-and-forget
`dispatchWebhooks()` (`src/services/webhook-dispatch.ts:48`, `void dispatchAsync(...)`,
never awaited by the caller). A hand-built positive-control reproduction of the obvious
version of this race (test A's leaked call landing during test B's `mockQuery.mockReset()`)
did **not** reproduce corruption — tracing the real handler shows mock-queue consumption
is synchronous at call time, not resolution time, which contradicts the simple version of
the theory. Correlated by file, not yet shown causal.

**Six of eleven failures (55%) remain unexplained** — six different files, no shared route
or async path found among them. Consistent with, not a departure from, this document's own
history: not one mechanism, several.

Full writeup, batch data, and the suggested next instrumentation step:
[issue #432](https://github.com/jonhill90/hill90-app/issues/432). Not fixed by serializing
or by retries — both remain rejected for the reasons already established earlier in this
document.

## Round nineteen (2026-08-05, same day) — three leads closed, population split found, investigation paused

Continuing round eighteen's batch, same day: the sibling-worker replacement lead
(webhook-dispatch fire-and-forget racing the mock queue) was tested directly —
instrumented call order (n=20) showed the specific failures never touch the mock at
all, and draining the dispatch in `afterEach` (n=30 vs the n=30 baseline) did not move
the rate (Fisher's exact p=0.35 file-specific, p=0.78 overall). **Disproven, not
merely unconfirmed.**

A second replacement lead — `process.env`/`global` not resetting between test files
sharing a worker — was tested the same way (n=30): real, widespread leakage exists (six
env keys, added and never cleaned up in ~68% of files), but the failing files' rate of
having a dirty predecessor (84.6%) was **not** elevated above the general base rate
(97.2% — nearly every file has one). Two of the thirteen failures had no possible
predecessor at all. **Disproven.**

Before spending a further lead on event-loop/GC contention, the 54 unique failures
collected across all 110 runs so far were classified by SHAPE rather than by file, at
no cost in new runs: 33 (61%) wrong-status, 9 (17%) timeout, 9 (17%) socket-hang-up, 2
(4%) crash-exception, 1 other. Only the timeout+transport class (18/54, 33%) is
plausibly timing/contention-shaped; the majority (36/54, 67%) is branch-shaped — a role
check or route returning a different, internally-consistent wrong answer, which
contention alone does not explain.

**Investigation paused here, not concluded.** Three leads closed with evidence, the
remaining population split into two shapes needing different instruments than anything
tried so far. Full data, sample sizes, and the handoff note for whoever resumes this:
[issue #432](https://github.com/jonhill90/hill90-app/issues/432).

## Round twenty (2026-08-05, same day) — a real contradiction, and a permanent fix

Root-caused ONE wrong-status instance completely, per the standing instruction to stop
sampling and work one defect the way a production bug gets worked: `routes-agents.test.ts`,
`GET /agents/:id/logs requires admin role`, expected 403, received 400 (batch A run 7).
Chosen because it touches no database (confirmed via call-order logging) and the
assertion is unambiguous.

**Exhaustive code-path elimination (deterministic, no runs needed):** read every
middleware and the complete handler for this exact route — `createRequireAuth` (5
`res.status()` calls, all 401), `correlation-id.ts` (no status calls), `app.ts`'s global
error handler (hardcodes 500 regardless of `err.status`), `router.use(dbHealthCheck)`
(503 or `next()` only), `requireRole('admin')` (401 or 403 only), and the handler body
itself (200/404/413/500 only). **It is architecturally impossible for this app's own
code to answer this request with 400, under any input.**

That directly contradicted the earlier "sibling-worker cross-talk ruled out" reading:
the identity guard recorded zero violations for this exact run
(`grep -c "RESPONSE IDENTITY VIOLATION" flakeA_run_7.log` = 0, confirmed from the raw
log, not an artifact-collection gap). Both cannot be true if a real, impossible 400
genuinely arrived. Resolving this by reading code, not by sampling further, is what
this round is about.

**The resolution: the guard had exactly the blind spot the estate keeps re-learning
about.** `state.ID`/`state.stampValue` in `jest.identityguard.js` are WORKER constants —
every response this worker's app writes carries the identical stamp, for ANY request,
correct or misattributed. The guard can prove "not a foreign process" and "not a sibling
worker" — and those rulings stand, unchanged — but it was never built to, and structurally
cannot, prove "the right response for THIS request." A same-worker cross-request mixup
is invisible to a worker-level stamp by construction, not by bug. An instrument that
cannot observe a class of event looks identical to that class being absent.

**Correcting the record, as instructed, rather than leaving the overstated version
standing:** round eighteen's "sibling-worker/foreign-responder cross-talk ruled out" is
correct AS SCOPED — foreign-worker cross-talk really is ruled out, the guard's own check
proves that — but was over-read if taken as ruling out "cross-talk" generally. Same-worker
cross-request mixup was never tested by that instrument and remained genuinely open. The
properly-scoped test for it (this session's temporary `jest.reqcorrelate.js`, per-request
nonce echo, positive-controlled) DID test it directly: 31 executions, 12 real wrong-status
failures observed, zero mismatches — real evidence against it as a general mechanism, via
the correct tool, not via the guard's silence.

**Shipped a permanent fix rather than just a correction.** This was a real gap in an
always-on, shipped instrument the whole investigation depends on trusting, so
`jest.identityguard.js` now carries a third check alongside NO STAMP / FOREIGN STAMP:
WRONG REQUEST — a per-request nonce, echoed by the server, checked by the client against
what was actually sent for that exact connection. The existing worker-stamp checks are
unchanged, not replaced; WRONG REQUEST only evaluates when the worker stamp already says
"ours," so it adds a distinct class rather than overlapping the first two. Positive-
controlled with a new committed arm (arm D in `identity-guard-control.test.ts`),
failing-test-first verified (stashed the guard, confirmed arm D fails with the exact
predicted `TypeError`, restored), and regression-checked with two full-suite runs (one
clean 133/133, no false positives from the new check).

**The original instance is still not mechanistically closed** — it did not recur during
this session's instrumented runs, so there was no live recapture. It remains a genuine,
narrowly-characterized anomaly: proven impossible by the code as read, not yet proven by
what mechanism the 400 actually arrived. The guard now watches for exactly this going
forward, permanently, in every run.

Full writeup and the contradiction-resolution evidence: issue #432.

## Round twenty-one (2026-08-05, same day) — a correction to the shape classification, the guard's first real measurement period, and one mechanism found, fixed, and verified

**Lead with the correction, because it changes how every number above should be read.**
Round nineteen's shape classification sorted 54 collected failures by pattern-matching
literal text — `"Exceeded timeout of"` for timeout, `"socket hang up"` for
crash-transport — and reported 33% timing-shaped, 67% branch-shaped (wrong-status plus
two crash-exceptions). That classification is now known to be imperfect at the boundary
it draws. This round root-caused a genuine timing defect —
`agents-events-poll-failure-signal.test.ts` racing a real SSE socket against an
insufficient wait — and its failure mode is a plain `toHaveLength` assertion mismatch,
not either literal string. A failure caused by timing does not have to *look* like a
timeout; it can just as easily present as "the value isn't there yet," which reads
indistinguishably from a wrong-status defect to a text-pattern classifier. This
specific mechanism, in this specific file, would have been counted in the 61-67%
branch-shaped bucket, not the 33% timing bucket, in every prior round's count.

**Stated plainly: the 33% timing / 67% branch-shaped split from round nineteen is
neither confirmed nor refuted by this round's work.** It was never re-measured here.
What this round shows is that the split's boundary is porous in at least one direction
— some real fraction of what was counted as branch-shaped may actually be timing-caused,
manifesting as a wrong value rather than a timeout. That's a correction to how the
number should be read, stated because these figures have been relayed upward as
measured facts; it is not a new measurement of the true ratio, and nobody should quote
"33%" as more precise than it is until the classification itself is redone with this in
mind.

### The guard's first real measurement period: zero, stated with the count behind it

Per the ask that opened this round: has the WRONG REQUEST check (round twenty, #434)
caught anything since it shipped (merged 2026-08-05 12:00:05 -0400)? **No** — measured
directly, not inferred. Every one of the 30 completed `services/api (jest)` CI job runs
since the merge, across pushes to `main` and PR branches through the latest run this
session, shows `conclusion: success`. Since a guard violation fails the job by
construction, a clean job conclusion is decisive: the guard would have failed the run.
Confirmed further by downloading and inspecting 4 of those runs' `api-flake-evidence`
artifacts directly — `identityguard.jsonl` is absent from all 4 (it writes only on a
real violation, so absence means zero, not "didn't execute"). This session's own 60
fresh local full-suite runs (three 20-run batches, below — the earlier "80" here was a
same-session arithmetic error, corrected once noticed: three batches of 20 is 60, not
80) add zero further violations.
**A single captured instance would have settled more than the rest of this round put
together; there isn't one yet.** The guard stays armed on every future run — this is a
negative result with its sample size stated, not a claim the underlying anomaly doesn't
exist.

### The timing slice, taken on directly for the first time

Prior rounds classified the timing-shaped 33% but never chased an individual instance of
it — the wrong-status majority absorbed every prior round's attention. This round did,
per the explicit instruction not to reach for more sampling but to work one popuation
directly.

**Structural hypothesis going in, stated with its own falsifier.** 834 `supertest`
calls plus 14 test files with a real `app.listen()`/`createServer()` (needed for
WebSocket upgrade or long-lived SSE, which supertest's implicit ephemeral-listen can't
serve) under this machine's 10-way local parallelism (`os.cpus().length - 1`; CI's
`ubuntu-latest` runners have materially fewer cores and would default to fewer jest
workers) is a plausible generic contention story. **What would falsify it:** if
generic, failures should scatter roughly evenly across the real-listener files,
weighted by each file's socket volume — not concentrate in one.

**That's not what happened.** A 20-run full-suite batch (`--maxWorkers=10`, local
default) failed 10/20 (50%). `agents-events-poll-failure-signal.test.ts` alone
accounted for 7 of the batch's 17 distinct test-failure instances — present in 5/20 runs
overall (25%) and 5/10 failing runs (50%) — while every other failing file in the batch
appeared exactly once, in exactly one run. **The generic contention theory is falsified
as stated**: it does not predict one file dominating this hard while ten other files —
several of them among the thirteen other real-listener files — appear only once each.

*(CORRECTION, same session: this paragraph originally read "failed 11/20 (55%)... 14 of
the batch's roughly 30 individual test-failure instances... 5/11 failing runs (45%)...
every other failing test in the batch appeared at most twice." Two separate mechanical
errors, not a different methodology on either count. First: `grep`-counting jest's
`● test name` lines double-counts, because jest prints every failing test's block twice
per run (once inline as it completes, once more in the end-of-run summary), and the
first pass over these logs summed both — the true instance count is 7, not 14, and
every other file appears exactly once, not "at most twice." Second, independent error:
the overall batch's failing-run count (11/20) was also wrong by one — the batch log's
own `exit=1` lines, cross-checked against each run's own "Test Suites: N failed"
summary line, both say 10/20, not 11 — an arithmetic slip while reading the batch log
by eye, unrelated to the double-counting bug above. Re-derived by parsing each run's
`FAIL`/`●` structure directly and deduplicating per run, and cross-checked against the
independent `exit=1` and "Test Suites" counts: 10/20 runs failed overall, 7
instances/5 runs for the target file, 1 instance/1 run for every other file in this
specific batch, 17 total instances, not ~30. The qualitative finding — one file
dominating far past what even scatter across real-listener files would predict — still
holds under the corrected numbers; the magnitude was overstated by roughly 2x. **Not**
caught before it was quoted elsewhere: PR #462's description and the round's own
comment on issue #432 both carried the wrong figure and were corrected separately, in
place, once this was found — see this round's own handoff section for the same
correction restated where a reader of just the PR or the issue would see it.)*

**The mechanism, found by reading the file's own docstring against its code — the same
method as always: read the claim, then check it.** The file deliberately mocks
`global.setInterval` to capture the tick function rather than waiting on real wall-clock
time (documented reason: `failureThresholdFor(3000)` is 4, and a real-timer version
would need ~12s per direction). But the SSE frame it emits still crosses a real socket
— `app.listen()` + `http.get`, the same technique `routes-agents-events.test.ts` uses,
because an open SSE stream never completes for supertest's `request()`. The only guard
between writing that frame and asserting on data received through it was a bare
`await new Promise(r => setImmediate(r))` — one event-loop tick. Reading
`services/sse-writer.ts`'s `createPollFailureSignal` confirmed the asymmetry: below
threshold, `recordFailure()` writes nothing at all; only the threshold-crossing tick (or
a tick that returns real rows) calls `sse.write()`. So most of the file's waits were
guarding a socket delivery that, most of the time, hadn't happened in one tick — the
test's own margin, not the app, not generic contention.

**Diagnostic experiment, not shipped, confirming the mechanism before touching the real
fix.** Patched all six waits in a scratch copy to a real `setTimeout(r, 15)` (reverted
immediately after), reran 20 more full-suite runs at the same worker count: 7/20 runs
failed overall (35%), 0/20 for this file specifically (vs. 5/20 baseline), and the two
batches' failure sets did not overlap at all — the patched batch's 9 distinct failing
tests were spread across 9 different files, each appearing exactly once, consistent
with the general background population this investigation has already characterized.
Fisher's exact on the 5/20 vs. 0/20 split for the target file: **p ≈ 0.047**. This
confirmed the mechanism. It was never proposed as the fix — see below.

### The fix: wait on the condition, not a fixed delay — and why the fixed delay was rejected even though it "worked"

**A longer fixed wait was rejected on principle, not just on style, per the h#725
lesson already learned once in the sibling Hill90 repo: a fixed delay makes a race less
likely, not impossible, and the margin that happens to be enough on an 11-core machine
is not the margin CI's smaller runner needs.** The 15ms figure above was a diagnostic
to confirm the mechanism, never a candidate to ship.

**What the test is actually waiting for, made explicit rather than assumed.** Because
`pollTick.fn()` is awaited directly (the test captured and calls the real interval
callback itself, not a real timer), every IN-PROCESS effect of a tick — the mocked
`getRecentInference` call, and the call into `sse.write()` if any — is already complete
the moment `pollTick.fn()` returns. The only genuinely async gap left is the real
socket hop: `sse.write()` returns once the frame is queued on the Node stream, not once
the test's own `http.get` `'data'` handler has actually received and parsed it. That
delivery is directly observable from the test — `errorFrames().length` reaching the
expected count, or `body` containing the expected marker — so it is exactly the kind of
condition the file's own `waitUntil(predicate, what, timeoutMs)` helper (already used
elsewhere in this same file, to wait for "the inference poll interval to be armed") was
built for.

**A second, equally important half of the fix: most of the waits were never actually
guarding anything, and removing them is as much the fix as adding `waitUntil` to the
one that mattered.** Every sub-threshold failure and every empty-rows success calls
`recordFailure()`/`recordSuccess()` with no write at all (confirmed by reading
`createPollFailureSignal`) — so `errorFrames()` is correct the instant `pollTick.fn()`
resolves, with nothing to race and nothing to wait for. The bare `setImmediate()` after
those ticks was not a weak version of a needed wait; it was dead weight around a
condition that was already deterministic. Only the threshold-crossing tick (both
sustained-failure tests) and the recovery tick (the third test) write anything real,
and only those two call sites now use `waitUntil` — bounded (`timeoutMs`, default
4000ms, already the file's convention), polling as fast as the machine allows, and
failing with a named, specific message (`'the error frame to arrive over the real SSE
socket'` / `'the recovered data row to arrive over the real SSE socket'`) rather than a
bare assertion mismatch if the condition genuinely never becomes true.

**The condition was fully observable from the test in every case here — nothing in this
file needed a code-side change to become observable.** Worth stating because it will
not always be true: if a test needed to wait on an effect with no client-visible
signal at all (an internal counter never surfaced, a write with no distinguishing
content), that would be a real finding about the code — an argument for adding an
observable signal, not for tolerating a fixed delay in the test. This file did not
turn out to be that case.

**Verified, not asserted:** the test passes solo, fast, with no artificial delay
(17ms/6ms/20ms per test, 3/3 pass). A fresh 20-run full-suite batch at the same
`--maxWorkers=10` this file previously failed 5/20 times at: **0/20 failures for this
file**, overall batch rate 6/20 (30%, ordinary noise against the 30-55% range this
investigation has measured throughout — not a general fix, and not read as one). Those
6 failing runs produced 7 distinct failing tests across 6 different files (one run had
two separate files fail, the other five had one each), none repeating, consistent with
the already-characterized background population. `tsc --noEmit` clean, `eslint` clean
(0 errors, pre-existing `any`-typing warnings only).

### Honesty about scope, stated because it is why this result is trustworthy

**One file. One mechanism. p ≈ 0.047 on a 5-vs-0-of-20 split. Measured entirely on an
11-core local machine, not CI's smaller runner — the mechanism (a real socket hop
outrunning a single-tick wait under contention) is not machine-specific in kind, but
its trigger rate is; CI may see this file fail less often in absolute terms for the same
underlying reason, or the same margin-per-tick issue could exist elsewhere and simply
not have surfaced in twenty runs.** This does not explain the branch-shaped majority —
the 7 failures in the fixed batch are exactly as unexplained as before this round
started. It closes one real, mechanistically-verified, now-fixed contributor to what
this session observed as timing-shaped flakiness; it is not a general fix for the
suite's flake rate, and the correction above means it may not even be fully accounted
for under the "timing" label it would previously have been filed under.

### Handoff

- The identity guard has a real measurement period now (30 CI runs, 0 violations) —
  worth restating in a future round once that count is materially larger.
- The 33%/67% shape split needs re-classification, not re-quotation, given the boundary
  case found here — a failure's TEXT (timeout vs. wrong-value) is not a reliable proxy
  for its CAUSE (timing vs. branch) at the boundary.
- `agents-events-poll-failure-signal.test.ts` is fixed and verified; if it reappears in
  a future batch's failure list, that is new information, not a recurrence of this
  round's finding.
- The branch-shaped majority remains the largest untouched population in this
  investigation, unchanged by this round.

Full writeup, both batches' raw data, and the diagnostic-vs-real-fix distinction:
issue #432.

## Round twenty-two (2026-08-05, same day) — looking for the next target, and not finding one that fits the recipe

Round twenty-one's method — find what dominates a batch's failures, read what it
actually waits on, check whether each wait guards anything, replace fixed delays with
condition polls — worked once. This round applied it to the next candidate. It did not
produce a second fix, and that result is reported as directly as the one that did.

### The counts this round is working from, pooled across all three round-twenty-one
batches (60 runs total: `w10`/baseline-`setImmediate`, `w10patched`/diagnostic-15ms,
`w10fixed`/shipped-fix — all three logged and re-parsed with the corrected,
deduplicated method from round twenty-one's own correction), **excluding**
`agents-events-poll-failure-signal.test.ts` itself, since it behaves differently across
the three batches by design (that's the point of `w10patched`/`w10fixed`) and pooling it
in would just re-measure the fix already shipped:

```
 4 instances, 4 runs   routes-chat.test.ts
 2 instances, 2 runs   routes-storage.test.ts
 2 instances, 2 runs   routes-agents.test.ts
 2 instances, 2 runs   docs.test.ts
 2 instances, 2 runs   half-writes.test.ts
 2 instances, 2 runs   routes-skills.test.ts
 1 instance,  1 run    (eleven further files, one instance each)
```

`routes-chat.test.ts` is the nominal leader — 4 of 60 runs, roughly 7% — but that is a
materially weaker signal than round twenty-one's target had (7 of 20 runs in ONE batch,
25-50% by either measure). This round's target was chosen anyway, as the best available
candidate, and the weakness of the signal is exactly why the outcome below turned out
the way it did.

### What `routes-chat.test.ts`'s four instances actually are

Pulled the specific failure for each of the four occurrences rather than assuming they
share a cause because they share a file:

- `routes-chat.test.ts:357`, `POST /chat/threads rejects missing message`: `Expected:
  400, Received: 501`. **This is the already-documented, already-closed 501 artifact**
  from earlier in this document — a third-party daemon (`LogiPluginService`, serving
  `websocket-sharp`) on this machine listens in the ephemeral port range supertest binds
  from and answers 501 for a request that never reached this app at all. This document's
  own standing instruction is not to re-litigate it. Re-flagged here only to name it, not
  to reopen it.
- `routes-chat.test.ts:507`, `asks the database for the newest rows, not the oldest`:
  `TypeError: Cannot read properties of undefined (reading '0')` on
  `mockQuery.mock.calls[3][0]` — the test expected a 4th mock call and only 3 (or fewer)
  happened. A wrong CALL COUNT, not a late arrival — structurally different from the
  round-twenty-one mechanism, where the write happened but hadn't been delivered yet.
- `Chat multi-agent dispatch › ... @-mention routes to single agent (I9)`: a routing
  assertion failure, no error text captured beyond the mismatch itself.
- `Group broadcast dispatch › partial dispatch failure marks only failed placeholders as
  error (T2)`: same shape as the previous — an assertion mismatch on dispatch outcome,
  not a timeout or transport error.

**Four different tests, four different describe blocks, no shared assertion shape.** The
common thread is the FILE, not a mechanism — `routes-chat.test.ts` has 95 tests, the
largest file in this batch's failure set by a wide margin, so it has more combinatorial
exposure to whatever the general background rate is. That is a plausible, sufficient
explanation on its own for why a 95-test file shows up more than a 10-test file, without
needing any single defect at all.

### Applying the two carried-over rules, as instructed

**Rule one — delete a wait that guards nothing, and say so.** Checked for exactly the
round-twenty-one shape: a fixed `setImmediate()`/`setTimeout()` standing in for a
condition. `routes-chat.test.ts` has no such wait anywhere relevant to these four
failures — grepped the whole file for `setTimeout`/`setImmediate`/`app.listen`/
`createServer`/`waitUntil`: one incidental `setTimeout` at line 2056, inside an unrelated
mock (`res.destroy()` callback timing for a different test entirely), not touching any
of the four failing tests. **There is no wait to convert here, weak or otherwise — this
file's failures are not wait-margin-shaped.**

**Rule two — if the condition is not observable, say what would make it observable,
because that is a finding about the code, not the test.** Does not apply either, in the
sense the rule anticipates: these aren't cases of an unobservable condition being
awaited badly. The 501 is an OS-level artifact with nothing to observe from inside the
app or test — no code change here would fix a foreign process on the port. The
call-count mismatch (`mock.calls[3]` undefined) is a **wrong number of calls**, which is
either a genuine app-behavior question (did a request short-circuit before its 4th
query, correctly or not?) or shared-mock-state carryover between tests — both real
questions, but neither is "the test needs to wait longer for a value to become true."
Applying round twenty-one's recipe here would be a category error: forcing a
wait-margin diagnosis onto a failure that isn't wait-margin-shaped.

### The honest result: no second target found at this sample size

Round twenty-one's method produced a fix because the target had an unambiguous,
outsized signal — one file responsible for something like a third of one batch's
distinct failures, with a specific, findable, single mechanism once the file's own
docstring was read against its code. Round twenty-two's nominal target has none of
that: a thin 4-of-60 signal, four unrelated failure shapes, no fixed wait anywhere near
any of them, and one of the four already explained by a defect this document closed
before this investigation even started. **Manufacturing a "fix" here would mean picking
one of these four and inventing a mechanism for it that the evidence doesn't support.**
That is not this round's finding.

What IS this round's finding, stated as a negative result with its basis: at 60 pooled
runs, nothing in the population outside `agents-events-poll-failure-signal.test.ts`
shows the signature that made round twenty-one's target legible — neither a dominant
instance count nor a shared, findable mechanism across its failures. The branch-shaped
majority remains exactly as unexplored as the last three rounds left it; this round
looked at its most-frequent single member and found that "most frequent" at this
sample size is not the same claim as "has one mechanism."

### Handoff

- Do not re-run this exact search at the same sample size expecting a different file to
  emerge as clearly as round twenty-one's target did — 60 runs was not enough to
  separate a second real signal from combinatorial noise across a 137-file suite. A
  larger pooled batch (several hundred runs) would be the honest way to let a genuine
  second cluster surface above the noise floor, if one exists.
- `routes-chat.test.ts`'s four failures are not being carried forward as a lead. Three
  of the four are singleton, unrelated assertion mismatches on a 95-test file; the
  fourth is the already-closed 501 daemon artifact.
- The recipe from round twenty-one (find what dominates, read what it waits on, check
  whether the wait guards anything, replace fixed delays with condition polls) is
  reusable, but it is not guaranteed to find something every time it's pointed at the
  next-most-frequent file — this round is the record of it correctly finding nothing,
  rather than being stretched to manufacture a result.

No infra/secrets/sops/credential work.
