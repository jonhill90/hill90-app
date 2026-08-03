# Deploying the 2026-08-03 hardening batch

Companion to [`hardening-batch-2026-08-03.md`](hardening-batch-2026-08-03.md), which
records *what is in the batch*. This records *how it goes out*, written before the
deploy rather than reconstructed after it.

**Status: EXECUTED 2026-08-03, in three steps rather than the two planned.**
What follows is the plan as written; the record of what actually happened is at the
end, and where the two differ the record is right.

## Recommendation, up front

**Deploy it. Two runs, standard dry-run-then-live, no special ceremony — with exactly
one exception, and the exception is the whole reason this file is longer than a
sentence.**

The pipeline already enforces the gates that matter: it refuses on a missing secret,
verifies SSH and the checkout, waits for per-container readiness, fails on any unhealthy
container, and checks Hill90's baseline afterwards. Five commits, every one a bound with
tests, all CI-green. This estate deployed seven times on 2026-08-03. Inventing a
ceremony for this batch would imply the routine path is not trusted, which is not the
finding.

**The exception is #148, the terminal relay.** Its failure mode is a terminal that
silently stops relaying while the container stays healthy and every probe stays green.
No automated gate in the pipeline can see that, and it cannot be checked from outside
because the WebSocket sits behind authentication. That is the one place where "the
deploy went green" genuinely proves nothing, and it is worth one human minute.

## Two corrections to the batch record before anything runs

The companion file was accurate when written and is not now. Both corrections were
established by checking, not by memory:

1. **#150 is still OPEN** (`mergeStateStatus: BLOCKED`), not merged. The batch table
   lists it among "the four merged, undeployed fixes". It is not in `origin/main` and
   this deploy will not ship it.
2. **#149 and #152 merged after that file was written** and are undeployed `ui` changes.
   They are not in its table.

So the real batch is five code commits, not four:

| Commit | PR | Service |
|---|---|---|
| `41ec9db` | #146 request bodies read whole | `ui` |
| `8eecb6a` | #147 upstream responses buffered | `ui` |
| `60a54cc` | #148 terminal relay queued without limit | `api` |
| `4248ca5` | #149 permission error shown as outage | `ui` |
| `98875bb` | #152 one place maps a probe to a status | `ui` |

Deployed now: `54986372f` (both services, 19:23–19:27 UTC).

**This is the drift the batching rule warned about, arriving on schedule.** The rule
said every PR must say "merged is not live"; it did not say the batch *record* stays
current on its own. It did not.

## Order: `api`, then `ui`

Not forced by dependency — nothing in the `ui` changes needs new `api` behaviour, and
nothing in `api` needs new `ui`. The invariant that `api` precedes `ai` and `knowledge`
(it creates `agent_sandbox` and `docker_proxy`) does not constrain `ui` either.

The order is chosen for **attribution**:

- `api` is **one commit** and the riskiest one in the batch. Deploying it alone means
  any misbehaviour afterwards has exactly one candidate cause.
- `ui` is four commits. Putting it second means that if something breaks there, `api` is
  already known-good rather than a second variable.

Reversing this would put four changes and one change in flight together, which is the
arrangement that makes a bisect necessary later.

## Step 1 — `api`

```bash
gh workflow run "Manual Deploy App (Prod)" -f service=api -f dry_run=true
gh workflow run "Manual Deploy App (Prod)" -f service=api -f dry_run=false
```

Ships #148 only.

### Checks between steps

| Check | Expect | Kind |
|---|---|---|
| Deploy workflow conclusion | `success` | gate |
| `app-api` readiness, no unhealthy containers | pipeline asserts both | gate |
| Hill90 baseline | 16 by name, 0 unhealthy, 0 restarting | gate |
| `api.hill90.com/health` | `200 {"status":"healthy","service":"api"}` | behavioural |
| `api.hill90.com/health/detailed` | `401` — #136 has not regressed | behavioural |
| **Open an agent terminal and type into it** | characters echo, session survives ~30s idle | **behavioural, human only** |
| #148's bound actually tripping | **not checkable** | containment only |

The last two rows are the point. #148 is *containment only* in the batch file's sense —
the deployed commit contains the fix and its surface shows no regression — and
containment says nothing about whether the bound ever engages. The terminal check does
not verify the bound either; it verifies the change did not break the ordinary path,
which is the failure this deploy could actually cause.

**I cannot perform the terminal check.** It needs an authenticated browser session.

## Step 2 — `ui`

```bash
gh workflow run "Manual Deploy App (Prod)" -f service=ui -f dry_run=true
gh workflow run "Manual Deploy App (Prod)" -f service=ui -f dry_run=false
```

Ships #146, #147, #149, #152.

### Checks after

| Check | Expect | Kind |
|---|---|---|
| Deploy conclusion, readiness, unhealthy, baseline | as above | gate |
| `hill90.com` | `200` | behavioural |
| `hill90.com/api/services/health` | `401` — #134 has not regressed | behavioural |
| **POST an oversized body to an upload route** | `413`, explicit limit named, **not** an empty `200` | **behavioural — #146** |
| #147 upstream cap | needs an upstream returning >16 MB | containment only |
| #149 grey "Not visible to your account" on `/harness/monitoring` | **needs a signed-in NON-ADMIN session** | behavioural, human only |
| #152 single mapping point | a refactor; its behaviour is #149's | containment only |

#146 is the only fix in the whole batch that this deploy can prove behaviourally from
outside. One of five. That ratio is the honest summary of what a green deploy buys here,
and it is why the batch file drew the distinction in the first place.

#149 deserves its own note: it is behaviourally checkable *in principle* and not by
anyone holding only an admin account, because an admin sees the vault panel exactly as
before. Checking it requires a non-admin session, and confirming with an admin account
proves nothing.

## Step 3 — the drift alarm closes the loop

```bash
gh workflow run "Deploy Drift Alarm"
```

Expect `PASS: what is running is what was merged.`

This is the first time it would say that against production. Every previous run has
returned either actionable drift or *"inside the grace window"* — the second is a
suppression, not a match. A run that still reports undeployed commits after both steps
means a deploy did not land what it claimed to.

## Rollback

**Revert and redeploy. Never edit on the host.** A deploy runs `git reset --hard
origin/main`, so a hand-fix on the VPS is destroyed by the next deploy and is
simultaneously live and doomed.

| Step | Rollback |
|---|---|
| `api` | `git revert -m 1 60a54cc` → push → redeploy `api` |
| `ui` | revert `98875bb`, `4248ca5`, `8eecb6a`, `41ec9db` **in that order** → push → redeploy `ui` |

The `ui` order is load-bearing: #152 refactors the helper #149 introduced, so reverting
#149 first conflicts. Reverse chronological is the only order that applies cleanly.

Each rollback is one more pipeline run, roughly four minutes.

### Abort conditions

Stop and roll back rather than continuing to the next step:

- the deploy workflow fails at any guard (it stops itself; do not re-run to "get past" it)
- any container unhealthy after readiness
- Hill90's baseline is not 16 by name, or shows anything unhealthy or restarting
- `hill90.com` or `api.hill90.com/health` non-200
- `api.hill90.com/health/detailed` returns anything other than `401`
- `hill90.com/api/services/health` returns anything other than `401`

The last two are regression tripwires for already-deployed fixes, not for this batch.
They are here because a deploy is the moment an old fix is most likely to be undone.

## What this deploy does not address

[#144](https://github.com/jonhill90/hill90-app/issues/144): `api`, `ui` and `mcp` declare
no `mem_limit`, on a VPS shared with the platform. Every fix in this batch narrows what
can be *consumed*; none puts a ceiling on the *container*. Until that lands, a member of
this class that nobody has found yet is still a host-level event rather than one
container restarting.

---

# What actually happened

Written after the fact, and kept separate from the plan above so the plan is not
quietly edited into agreement with the outcome.

## Three steps, not two

| Step | Run | `origin/main` before | Host after | Shipped |
|---|---|---|---|---|
| 1. `api` | `30849633039` | `435f87a` | **`435f87a`** | #148, #153 |
| 2. `ui` | `30849952163` | `542676f` | **`542676f`** | #146, #147, #149, #152 |
| 3. `api` follow-up | `30850428930` | `b9c6a27` | **`b9c6a27`** | #150, #156 |

All three green, all gates passed, Hill90's baseline unchanged each time.

## The cut did not hold, and step 3 is the consequence

`origin/main` moved during **every** step:

```
step 1:  435f87a -> b479e2c   (#156 landed mid-run)
step 2:  542676f -> 542676f   (steady)
step 3:  b9c6a27 -> 8f6dfab   (#159 landed mid-run)
```

In step 1 the host reset before #156 landed, so the declared cut held — **by winning a
race, not because anything enforced it**. See
[#158](https://github.com/jonhill90/hill90-app/issues/158): the workflow takes no ref
input, so a deploy ships whatever `origin/main` is when the reset runs and no artifact of
the run records which commit that was.

**#150 and #156 shipped in a follow-up deploy, not in the cut.** They were explicitly
excluded — #150 was open and dirty on another lane's branch, #156 was open — and both
merged afterwards. Rather than leaving merged api code sitting in the checkout unrun,
which is precisely the drift the alarm exists to catch, they were deployed as step 3.
The record says follow-up because that is what happened.

## Verification: what was actually proved

| Fix | Result | Kind |
|---|---|---|
| #148, #153, #150, #156 (`api`) | commits present, no surface regression | **Containment only** |
| #146, #147, #149, #152 (`ui`) | commits present, no surface regression | **Containment only** |

```
api.hill90.com/health          200  {"status":"healthy","service":"api"}
api.hill90.com/health/detailed 401   #136 tripwire intact
hill90.com                     200
hill90.com/api/services/health 401   #134 tripwire intact
hill90.com/api/agents          401   cache-control: private, no-store
```

**Nothing in this batch was verified behaviourally, and the plan was wrong to say
otherwise.** It claimed #146 could be proved from outside by posting an oversized body.
It cannot:

```
POST 3MB to /api/profile, anonymous  ->  401 {"error":"Not authenticated"}
```

The session gate fires before the body is read — correct design, and deliberate — so an
anonymous caller never reaches the cap. The same is true of #150 and #156: an anonymous
SSE request returns 401 and never reaches either bound. **Every bound in this batch sits
behind authentication, so no external check can reach any of them.** That is not a gap in
the deploy; it is what "containment only" always meant, and the plan overstated it by one.

Still unverified and human-only: the terminal path (#148), and #149's rendering, which
needs a **non-admin** session because an admin sees the old view either way.

## The alarm's verdict, and its blind spot

After step 3 it reports `PASS`, with one docs-only commit outstanding (#159, merged
mid-run) correctly classified as not actionable.

But after step 2 it printed `PASS: what is running is what was merged` while two merged
api fixes were in the checkout and **not in the running api image** — it reads
`git rev-parse HEAD`, which is the checkout, and every deploy resets the whole checkout
while rebuilding one stack. The instrument built to catch this family could not see it.
Recorded in [#158](https://github.com/jonhill90/hill90-app/issues/158); the smallest fix
is to narrow the sentence it prints, which is a claim it cannot support.
