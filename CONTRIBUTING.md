# Contributing to hill90-app

This repository deploys to production. There is no CI that runs on its own, and
no workflow fires on merge — deploys are dispatched by hand. Read [`CONTRIBUTING.md`](CONTRIBUTING.md#deploying) below for how the deploy path works,
and the README's status table for what is currently live.

What follows is the working convention this repository uses. Hill90's own deploy rules,
secrets workflow and VPS operations are still **not** reproduced here; this repo
grew its own, deliberately narrower, as a tenant rather than a platform owner.

## Deploying

`gh workflow run "Manual Deploy App (Prod)"`, `workflow_dispatch` only, inputs
`service` / `dry_run` / `confirm_public_deploy`. It runs over SSH from a GitHub
Actions runner on the tailnet. **Never deploy from a workstation** — there is no
supported path for it and the guards do not run there.

Use `dry_run=true` first. It exercises every guard — secrets present, tenancy
contract satisfied, host paths writable — and stops before touching the host.

## Issue tracking

Issues for this repository live in **its own GitHub Issues**. Work spanning more
than one repository is filed in [Hill90](https://github.com/jonhill90/Hill90) and
links out; see that repository's `CONTRIBUTING.md` for the routing table.

`AI-###` identifiers — and the `**Linear:** AI-114` headers on several documents
under `docs/` — refer to a Linear workspace that was retired as a tracker on
2026-07-26. **They are not GitHub issue numbers**: `AI-8` is a Linear identifier
and has nothing to do with this repository's #8, which is a real and separate
issue here.

The workspace was kept as a record rather than deleted. It held about 250 issues
across its two teams and all but two were already closed at the cutover, so only
those two moved to GitHub — `AI-258` is now
[#8](https://github.com/jonhill90/hill90-app/issues/8) here, and `JON-55` became
[Hill90#532](https://github.com/jonhill90/Hill90/issues/532). Every other
`AI-###` resolves only in Linear.

## Branch naming

| Type | Prefix |
|---|---|
| Feature | `feat/<description>` |
| Refactor | `refactor/<description>` |
| Bug fix | `fix/<description>` |
| Docs | `docs/<description>` |
| Enhancement | `enhance/<description>` |
| Chore | `chore/<description>` |

## Commit format

```text
<type>: <short description>

<body explaining why, not what>
```

## If you pick this up cold

- Update `services/api/src/openapi/openapi.yaml` when adding or changing API
  routes. Hill90's CI enforced spec-vs-route drift and also diffed that file against
  the published spec; neither check came across. The published copy now lives in
  [hill90-docs](https://github.com/jonhill90/hill90-docs) as `ai-app/openapi.yaml`, so
  the two may already disagree and nothing checks it.
- Tests live next to their services: `services/api` (jest), `services/ui`
  (vitest), `services/mcp` and `services/agentbox` (pytest). End-to-end
  Playwright suites are in `tests/e2e/` and require a running stack.
- Do not commit real secrets. `.env.example` files are tracked; `.env` is not.

## Dependency pins that are load-bearing

- **`services/api` → `fast-xml-parser` is pinned `~5.6.0` deliberately.** It was pinned
  to fix S3 XML parsing, so storage depends on it; a dependency bump that lets it float
  again will break object storage in a way that does not look like a dependency problem.
  Re-pin it consciously rather than accepting whatever a bump produces. (JSON takes no
  comments, which is why this note is here rather than beside the line.)
- `services/knowledge/Dockerfile` builds the Go `akm` binary with BuildKit's
  `TARGETARCH`. The reason it must not be hardcoded is documented in the Dockerfile
  itself.

## Read the Copilot review before merging — and verify it

Every PR here gets a GitHub Copilot code review (`dynamic/agents/copilot-pull-request-reviewer`).
It is not a repo workflow, so it does not appear in `.github/workflows`, and its check is
green whether or not anyone reads what it said.

**An unread review is indistinguishable from no review.** On 2026-08-03 it reviewed 8 PRs in
one session, left inline comments on 5, and was read on none of them. One of those comments
identified a CI service block wired to the wrong job — the same defect the author rediscovered
later by hand, after it had already been written down.

```
gh pr view <n> --json reviews
gh api repos/<owner>/<repo>/pulls/<n>/comments --jq '.[]|"\(.path):\(.line) \(.body)"'
```

**Verify what it says rather than acting on it.** In the same session its two comments split
one-for-one: the wrong-job finding was correct; a claim that `if: matrix.setup != ''` would
evaluate true for undefined values was not — the step demonstrably skips on the arms where
`setup` is unset. Both were stated with equal confidence. A review comment is a lead, and this
repository's standing rule applies to it exactly as to any other instrument: check it before
believing it.

## An instrument can be wrong in BOTH directions at once

The worst instrument failure is not over-reporting or under-reporting. It is doing both in the
same run, because the two hide each other.

Measured on 2026-08-03, auditing `services/api` for fire-and-forget promise chains. A grep for
un-awaited calls to async functions reported **three** sites:

- two were **false positives** — calls sitting on their own line inside an awaited
  `Promise.all`, which look identical to a floating call when you match line shapes;
- and it never opened `notifications.ts`, `webhook-dispatch.ts` or `workflow-scheduler.ts` at
  all, which between them hold **four** of the six real sites.

Wrong in both directions, simultaneously. **That combination is more dangerous than either
alone**: a reader who spot-checks one of the false positives concludes the tool over-reports,
discounts the output, and by doing so trusts the misses. The noise buys credibility for the
silence.

Re-run with `@typescript-eslint/no-floating-promises` against the real `tsconfig.json` — an
instrument that knows what returns a promise rather than what a line looks like — the answer was
six sites, correctly. Same question, same repository, ten minutes apart.

**The rule this adds to the three above:** when an instrument is shown to be wrong once, do not
patch that one result and carry on. Ask which direction the error was in, then check the other
direction explicitly, because an instrument that can invent a finding can equally well omit one,
and you will only notice the invention.

A corollary worth stating, from the same audit: **choosing the right rule matters as much as
choosing the right tool.** `no-misused-promises` reported 191 sites in the same run — every
`router.get('/x', async …)` in the service — all of them already safe because of the vendored
middleware in `src/boot/async-errors.ts`. Reporting 197 would have counted a solved problem as
an open one.

## Undo a positive control with a snapshot, never with `git checkout`

Every fix here is proven by breaking it again and watching the test go red. The
obvious way to undo that break is `git checkout -- <file>` — and it discards
**everything** uncommitted in that path, exits 0, and prints nothing.

On 2026-08-04 that silently destroyed uncommitted work **four times in one
session**. Every time it was noticed downstream, from a test failing for a
reason that had to be traced back — never from the command, which reported
success by saying nothing. That is this repository's own defect class, moved
from the code into the workflow: an operation that destroys and reports success.

Resolving to be careful had already failed three times before the fourth. So:

```bash
bash scripts/dev/snapshot.sh save services/api/src/routes/agents.ts
# ...break it, run the test, watch it go red...
bash scripts/dev/snapshot.sh restore      # prints every file it restores
```

`restore` **fails loudly when nothing is saved**, because a restore that did
nothing is not the same as a successful one — the same rule the SQL gate applies
to CANNOT DETERMINE. It stores bytes outside the repository, and deliberately
does not use `git stash`: this worktree shares its stash stack with the main
checkout, so a stash here can be popped by another session.

Committing first also works, and is better when the experiment is long. What
does not work is remembering.

## The instrument can contain the fault it was built to catch

The section above says check the instrument. This one is narrower and worse: **an instrument
written specifically to rule out a confusion can reproduce that confusion internally**, and it
will not look wrong when it does.

Measured on 2026-08-04, rotating `DB_PASSWORD` in [#282](https://github.com/jonhill90/hill90-app/pull/282). The
question was whether any deployable stack consumes the value. A name grep was rejected on the
grounds that a search pointed at the wrong tree returns the same zero as a search that is
right — so each production compose file was rendered with the real store interpolated and the
**value** was searched for in the rendered text, and a render that produced nothing was made to
refuse to report a count at all. That guard was the whole point of the script.

The count was then written as `n=$(render "$st" | grep -Fc -- "$v") || return 1`, and a stack
with no hits became indistinguishable from a render that had died — the exact conflation the
render guard existed to prevent, one line below it.

**The tool was not the problem, and this is the part to get right.** `grep` distinguishes the two
perfectly well: **1 for no match, 2 for an error.** What threw the distinction away was the
calling code. `render` signalled its own failure as `return 1` — the same value `grep` uses for a
clean no-match — the pipeline collapsed both into one status, and `|| return 1` mapped every
non-zero to a single meaning. Three ordinary decisions, none wrong alone.

The first run reported both positive controls as failures, which is the only reason it was
noticed. **Had it failed in the other direction it would have read as a pass**, and a zero would
have been reported for a key that was still in use.

Fix: render and count are separate steps, the render is checked on its own, and the count is
`grep -Fc … || true`.

**The rule:** when you build an instrument to rule out a specific failure mode, check whether
that failure mode exists inside the instrument. The common instance is not a tool that cannot
tell two outcomes apart — it is **calling code that discards a distinction the tool was making**:
a bare `|| return 1`, a `set -e` that treats every non-zero alike, a pipeline whose status carries
only one stage. The fix differs accordingly. If the tool genuinely cannot distinguish them,
replace the tool; if the caller flattened it, keep the tool and stop flattening — check exit
status against the value that means *error*, or separate the steps so each is checked on its own.
Either way: a positive control that fails loudly is what caught this, and a script whose controls
always pass has told you nothing about itself.

## Look for the twin before you look for the next defect

When you fix something, the next question is not *what else is broken*. It is **where else does
this exact code live**. Ask it before you move on, every time, and read the answer rather than
reasoning about it — the twin is usually a copy that was never edited, so it is found by
searching for the shape, not by thinking about the design.

**A fix applied at one call site leaves its twins untouched, and the lesson is then recorded
only in code a person writing a different file never opens** — [#114](https://github.com/jonhill90/hill90-app/pull/114) fixed a silent
401 in `middleware/auth.ts` and the same shape survived four months in two other files until
[#308](https://github.com/jonhill90/hill90-app/pull/308). When you fix a shape, search for the shape.

**Write a handover from the tracker and the diffs, never from recall** — it is composed at
the end of a long session, which is exactly when memory substitutes for verification, and on
2026-08-04 one false claim in one led to a check that found four more of the same kind.

This is not a maxim. It is what **2026-08-03** actually looked like — six times in one day:

| Fixed | The twin, found afterwards | How far apart |
|---|---|---|
| [#141](https://github.com/jonhill90/hill90-app/pull/141) clamped `?tail=` on `/agents/:id/events` | the same clamp had existed on the export endpoint all along — #141 *was* the twin nobody had checked for | one route |
| #141's clamp, plus the byte cap from [#143](https://github.com/jonhill90/hill90-app/pull/143) | [#153](https://github.com/jonhill90/hill90-app/pull/153) — the chat events route had **neither**, and multiplied both by up to 8 agents | two files |
| [#182](https://github.com/jonhill90/hill90-app/pull/182) bounded `list_entries` | [#186](https://github.com/jonhill90/hill90-app/pull/186) — "bound the agent-facing entries list **too**" | same service |
| [#181](https://github.com/jonhill90/hill90-app/pull/181) fixed a stale response overwriting the agent you are on | [#187](https://github.com/jonhill90/hill90-app/pull/187) — the chat browser pane had the same shape, and its stale value is a POST body | api → ui |
| [#192](https://github.com/jonhill90/hill90-app/pull/192) registered stream cleanup before the await | found in **three** routes at once, because that time the search came first | three handlers |
| this PR | `execInContainerWithExit` and `execWithStdin` in `services/docker.ts` — byte-identical blocks, the same uncancelled timer in both | 80 lines |

**Not one of the six was found by something failing.** Every one came from someone deciding to
look, and none of the twins had a bug report. Two of them — #153 and #187 — were more severe than the original: #153 multiplied by
the number of agents in a thread, and #187's stale value reaches a write rather than a display.
So the twin is not a tidy-up after the real fix. It is as likely to be the worse instance.

**The mechanism is drift, and drift has a direction.** A bound, a guard or a cancel gets added
where the bug was reported. The copy nobody reported keeps the old shape and now looks
deliberate, because the fixed one is elsewhere and no longer resembles it. That is why the
search must be textual: `grep` the block, not the intent.

**What to do, concretely.** Before opening the PR, take the two or three lines you changed and
search the repository for them — the surrounding lines, not the symbol name. If the block exists
twice, fix both in the same PR and say so in the diff; splitting them leaves the second behind a
review of the first. If it exists once, say *that* in the PR, because a checked negative stops
the next person re-running the search. And where the same bound belongs in more than one place,
put it in a shared constant rather than a literal typed in three files — `event-log-limits.ts`
exists because #153 proved the alternative.

**One instance checked and excluded, so the count is evidence rather than a slogan:**
[#166](https://github.com/jonhill90/hill90-app/pull/166) (`log` where the helper is `info`) was
considered for this list and does not belong. Its diff changes exactly one line and
`revision stamp` appears once in `scripts/deploy.sh`. It was a single-occurrence defect that a
test could not see, which is a different lesson and already recorded above.

## A test that HANGS on the defect has not caught it

Design the red state to **fail**, not to hang. A failing test is read; a hanging one is
re-run, because a hang looks like infrastructure and a failure looks like a defect. The two
are treated completely differently by the person who meets them, and only one of them gets
the bug fixed.

Measured on **2026-08-04**, taking the red control for [#199](https://github.com/jonhill90/hill90-app/pull/199).
The assertion was that an SSE stream closes when the viewer's participation is revoked. With
the fix removed, the stream never closed, so the request never settled — and because the test
used `jest.useFakeTimers()`, **jest's own test timeout could not fire either**, since that
timeout is itself a timer. The run hung indefinitely and had to be killed. Nothing printed. A
cold reader would have concluded the runner was wedged.

Bounding it turned the same control into one line of evidence:

```js
const settled = await Promise.race([
  pending.then((r) => r.text),
  (async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
                 return 'STREAM NEVER CLOSED'; })(),
]);
expect(settled).toMatch(/Access revoked/);
```

```
Received string:  "STREAM NEVER CLOSED"
```

**Three things that generalise:**

- **A sentinel beats a timeout.** `'STREAM NEVER CLOSED'` names the defect in the failure
  output. A bare timeout says only that time passed, which is what a slow CI runner also says.
- **Bound it with something the test is not faking.** `setImmediate` is left real
  (`useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })`) precisely so the bound does
  not depend on the clock under test. A bound built from the faked timer cannot fire when the
  faked timer is the thing that stopped.
- **This is not the same rule as "wait on the condition, not the clock"** ([#165](https://github.com/jonhill90/hill90-app/pull/165)).
  That one is about how you wait for success. This one is about what happens when success never
  arrives — and a test can obey the first and still hang under the second.

Same family as the other instrument notes above: the run said nothing, and silence was taken
for a problem with the tooling.
