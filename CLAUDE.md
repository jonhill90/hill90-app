# hill90-app — agent orientation

*(`AGENTS.md` and `CLAUDE.md` are the same file — one is a symlink, so there is
no second copy to drift.)*

Read this first. It is deliberately short; follow the links only when you need
them.

**What this is:** an AI agent platform — agents in sandboxed containers, a
policy-gated model router, a shared knowledge base, a Next.js UI. It runs as a
**tenant** of the [Hill90](https://github.com/jonhill90/Hill90) homelab on a
shared VPS, and locally against the same compose files.

## Where to look

- [`docs/product/PRD.md`](docs/product/PRD.md) and
  [`docs/product/SPEC.md`](docs/product/SPEC.md) (app#503) — what this app is, who
  actually uses it, and what is proven versus aspirational, every claim dated and
  cited to a test, a commit, or a live check rather than asserted. Read SPEC.md §4
  before trusting any dated claim elsewhere in this repo, including in this file —
  it names a live contradiction between this file and README.md that neither
  document currently resolves.
- [`README.md`](README.md) — what it is, how to run it locally, and the
  **dated** production status table. That table is the single home for facts
  with a shelf life; this file deliberately does not repeat them.
- [`docs/reference/secret-layout.md`](docs/reference/secret-layout.md) — what each secret
  is for, and the two vault KV couplings that are not visible from the service code.
- [`docs/decisions/running-the-app-on-hill90-infra.md`](docs/decisions/running-the-app-on-hill90-infra.md)
  — the long-form record of the tenancy work, including retractions of its own
  earlier claims. Read it before re-litigating a naming or network decision.
- [`docs/decisions/HANDOFF-2026-07-31.md`](docs/decisions/HANDOFF-2026-07-31.md)
  — where the tenant stands after the cutover: what it consumes and how that was
  proven, what remains of its own three services, local's real state, and the open
  decisions. The estate-level companion is Hill90's handoff of the same date.
- [`docs/decisions/HANDOFF-2026-08-04.md`](docs/decisions/HANDOFF-2026-08-04.md)
  — **read this first, and its sections 0A–0D before touching anything.** The bounds a
  green run does not cover (nothing is tested past the WebSocket handshake against a real
  agentbox; the SQL gate proves parsing and not correctness; 56 interpolated statements
  are uncheckable and counted on every run); that `process.exit()` does not wait for a
  pending write, so a fix that logs and exits loses the log — three separate designs
  turned on it today; **the realm hazard that runs backwards**, where importing the
  committed `platform-realm.json` strips `sub` and makes the API refuse every user; and
  the three standing decisions that are Jon's rather than a lane's. Then the
  instrument-side seam the day was about, and what happened when the fixes were exercised
  rather than reasoned about.
- [`docs/decisions/HANDOFF-2026-08-03.md`](docs/decisions/HANDOFF-2026-08-03.md)
  — the silent-success seam and the rules that came out of it: the two questions that
  found every defect that session, the twin rule, why a positive control's two numbers
  must disagree, and the one thing nothing can alert on. Read it before picking up
  #184 or #185, which are the same shape left parked.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — deploy verbs and conventions.
- Published pages: [docs.hill90.com/ai-app](https://docs.hill90.com/ai-app/overview).

## Layout

```
services/               the application (8 services)
platform/               Keycloak realm + theme, LiteLLM config, Postgres bootstrap
deploy/compose/prod/    the production compose files — deployed, not a spec
deploy/compose/overrides/  local overrides that LAYER on the prod files
compose/local.yml       the standalone local stack (own networks, published ports)
infra/secrets/          SOPS-encrypted store; the age key is never committed
scripts/                local.sh, deploy.sh, _common.sh, db provisioners
docs/                   architecture, decisions, runbooks, extraction record
```

## Invariants — do not break these without an explicit decision

Most of these were bought with a real bug. They are not style preferences.

1. **Deploys are pipeline-only.** `gh workflow run "Manual Deploy App (Prod)"`,
   `workflow_dispatch`, over SSH from a GitHub Actions runner on the tailnet.
   **Never deploy from a workstation** — the guards do not run there. Use
   `dry_run=true` first; it exercises every guard and stops before touching the
   host.
2. **The app is a tenant.** `hill90_edge`, `hill90_internal`, and
   `hill90_agent_internal` are consumed as `external: true` — three platform
   networks, not two; `Verified 2026-08-04` directly against
   `deploy/compose/prod/docker-compose.api.yml`, `.ai.yml` and `.knowledge.yml`,
   none of which create `agent_internal`. This repo must never create any of
   the three. `agent_sandbox` and `docker_proxy` are the app's own, created by
   `docker-compose.api.yml`, which is why `api` must precede `ai` and
   `knowledge`. *(This item omitted `agent_internal` since at least the
   tenancy-cutover rewrite of this file — the network itself dates to #95,
   well before that rewrite, so this was an omission carried forward, not new
   drift. Per Hill90's own record — `docs/runbooks/tenant-app-deployment.md`
   in `jonhill90/Hill90`, undated within that file, read 2026-08-04 — their
   framing is "three are Hill90's ... two are the app's," which is what this
   item now states; that framing is theirs, cited with its source, not
   independently measured against their host from here.)*
3. **Names are parameterised.** `NETWORK_PREFIX`, `VOLUME_PREFIX`,
   `CONTAINER_PREFIX`. Never hardcode a name that appears on the shared host.
4. **A rename must be checked across five namespaces**, not three:
   `container_name`, Traefik router name, hostname, the compose **service key**
   (Compose derives a network DNS alias from it), and the **volume name**.
   Volumes are the one that nearly caused data loss — the app declared
   `prod_postgres-data`, byte-identical to Hill90's, which would have mounted
   the platform's live database into a second Postgres with no error.
5. **Secret values in the SOPS store are single-line.** Inline PEMs with `\n`
   escapes. The loader refuses a multi-line value rather than silently
   truncating it — do not "fix" that by loosening the parser.
6. **Overrides layer, they never fork.** Every file in
   `deploy/compose/overrides/` must use the same service keys as the prod file
   it overlays; a mismatched key silently *adds* a service instead of overriding
   one. And note the blind spot: every variable an override replaces is one the
   local run cannot validate.
7. **Do not add a push trigger to a deploy workflow.** A merge must not deploy.

## Ground rules for changing this repo

- **State what becomes true at a date, not that the date is coming.** A future-tense
  sentence reads as *not yet due* forever, so it fails silently the moment it passes —
  and a `Verified` stamp on one is misleading in both directions at once: recently
  checked, and describing a moment that has since arrived. Write "expired 2026-08-01;
  after that it is an untaken decision" rather than "expires 2026-08-01". The first is
  true before and after; the second is only true before.
- **Verify against the host, then date the claim.** Anything perishable —
  container counts, health, what is deployed — gets a `Verified <UTC timestamp>`
  next to it, or it goes in README's table and is linked. A dated claim that has
  aged is honest; an undated one is just wrong later.
- **Do not document what you have not run.** "The compose file parses" is not
  "the service starts".
- **Decision records preserve; status trackers expire.** A record explaining why
  something was decided, built, or diagnosed — a `docs/decisions/*.md` entry, a
  root-cause writeup, the retracted-and-corrected paragraphs already scattered
  through this file — stays even where its language has aged, because the
  reasoning is the value. A tracker whose whole content is "here is the current
  state" does not survive its own timestamp, and updating it is fine. The two
  read alike ("X is true") and are opposite documents: rewriting a decision
  record to match what later happened destroys the record of what was intended
  or diagnosed at the time; leaving a status tracker unedited just makes it
  wrong. When in doubt which kind a document is, ask what a reader loses if it's
  rewritten to match today — nothing, or the reasoning. This is not a hypothetical:
  `PROVENANCE.md` once carried this exact rule and was deleted along with the
  extraction record it was written for (#225, 2026-08-04), taking the rule with
  it — restated here so the next repo-wide cleanup has somewhere to find it
  again.
- Prefer the shape already in Hill90 over inventing a second dialect;
  `scripts/deploy.sh` deliberately mirrors Hill90's.
- Never commit a credential, an age key, or a decrypted `.env`.

## Finding defects by shape, not by symptom

Ten defects in `services/api` were found on 2026-08-03 by grepping for a *shape* and then
checking reachability. None was found by something failing. The shapes are the part that
transfers.

**What it covered.** *Process death:* a `void`ed promise chain whose inner query could
reject (#133), and async handler rejections that Express 4 drops on the floor (#135 — fixed
at the boundary, so the next handler written inherits it). *Unbounded memory:*
caller-controlled sizes with a floor and no ceiling (#141, #153), reads with no byte cap
(#143, #153), a WebSocket relay and SSE writes that never consulted backpressure (#148,
#150). *Credential lifetime:* a terminal session outliving its token (#145), and the same on all
four SSE endpoints (#156). *Anonymous exposure:* `/health/detailed` served the runtime and
the tenant inventory (#136).

**The greps that earned their keep:**

```bash
grep -rn "void [a-z]" src/                     # fire-and-forget chains
grep -rn "chunks.push\|buffer +=" src/         # accumulation with no ceiling
grep -rnE "parseInt\(\s*req\.(query|params)"   # caller-controlled sizes
grep -rnE "(=|if \()\s*res\.write\("          # is backpressure consulted at all?
grep -rnE "\.on\('(data|message)'" src/        # producer-driven writes
```

**A hit is not a defect until two questions are answered**, and skipping either wastes the
sweep. *Who can reach it* — role, ownership, preconditions: #141's answer narrowed it from
"any signed-in user" to "needs an admin to have started the agent". *What does it cost* —
usually the parameter removes a cap rather than inventing data, so the cost is bounded by
data the caller's own agent produced.

**Looked for and NOT found**, so nobody repeats the search: ReDoS from request input (the
only `new RegExp` is a constant), SQL built by concatenation, `.then()` without `.catch()`,
`forEach(async)`, and unawaited `pool.query` outside `await Promise.all` — two exist, both
unreachable from the affected paths. `services/ai`'s single `asyncio.create_task` is
guarded, and Python does not exit on an un-retrieved task exception, so this seam is
**Node-specific**.

### Where the search stopped, and on what basis

Stated so the next lane can act on it rather than re-run it. Each row is a method, not a
recollection — rerun any of them.

| Shape | How it was searched | Found |
|---|---|---|
| fire-and-forget chains | `grep "void [a-z]"`, then read each | #133; rest guarded |
| async handler rejections | fixed at the boundary | #135 — structural, no twins possible |
| accumulation with no ceiling | `chunks.push` / `buffer +=` | #143, #153 |
| caller-controlled sizes | `parseInt(req.query…)`, every route | #141, #153; rest clamped |
| backpressure consulted? | `res.write` result, `drain`, `writableLength` | **zero consulted** → #148, #150. Rerunning today returns **one** — `sse-writer.ts`, which is the fix |
| authenticated once, long-lived | WebSocket, then every `text/event-stream` | #145, then all **four** SSE routes → #156. The grep also returns four `openapi.yaml` matches, which are spec, not code |
| reachable without auth | every route registered before `requireAuth` | #136; rest are `/health` by design and four service-token `/internal/*` |
| unbounded query results | 104 `SELECT`s without `LIMIT`, triaged | **nothing material** — nearly all single-row lookups; the thread-load query returns a whole thread by design, with no caller-controlled multiplier |
| ui body / upstream reads | every `src/app/api/**/route.ts` | **zero unguarded** (covered by #146, #147) |

**Counts move as fixes land, and that is expected** — the accumulation grep returned three
before #153 and two after. A number here is a measurement of a state, not a constant. Rerun
the method; do not trust the figure.

**Found nothing of:** ReDoS from request input (the only `new RegExp` is a constant), SQL by
string concatenation, `.then()` without `.catch()`, `forEach(async)`, and unawaited
`pool.query` outside `await Promise.all` — two exist, both unreachable from the affected
paths.

**What the claim does NOT cover**, so it is not read wider than it is: `services/mcp`,
`services/knowledge` and `services/agentbox` were not swept for their own families. They are
FastAPI, which catches handler exceptions, and both carry existing limits — but that is an
argument from framework, not a search that was run.

**The first exhaustion call here was premature, and what corrected it was continuing to
look.** It was made after #150; writing the summary then produced #153, and carrying on
produced #156 — the twin of #145, on four endpoints. No new technique was involved: the same
greps, run once more. Treat a confident "dry" from a lane that has just stopped finding
things as a hypothesis, not a result.

**The recurring cause was drift, not ignorance.** #141 existed because the clamp sat on the
export endpoint and not its twin; #153 because that fix went to one route and not the other.
The bound belongs in a shared constant, never a literal typed in three files.

**Merged is not deployed.** Deploy state for this work lives in
[`docs/decisions/hardening-batch-2026-08-03.md`](docs/decisions/hardening-batch-2026-08-03.md),
including which fixes can be verified behaviourally after a deploy and which only by
containment.

## The governing principle

**The platform provides identity, data and storage. This app consumes them.**
Every consolidation decision follows from it. Check a new question against this
before treating it as open.

## Settled — do not reopen or re-describe as open

**This is greenfield, not a migration.** The app reached the VPS for the first
time on 2026-07-29. Realm `hill90` held two accounts created hours earlier which,
since login did not then work, were never used; that realm is **gone from the live
directory** as of 2026-07-31, surviving only in an export and the retained tenant
volume. There is no accumulated
state. Export, import, rollback and cutover are the wrong frame — the realm
export and the database backup are a **safety net**, not steps in a process.

**Keycloak: one Keycloak, one realm, the existing `platform`.** This app's
clients go into `platform`; there is no new `hill90` realm. The reasoning is an
Entra analogy — you do not create a second tenant for one organisation; one
directory, controlled with roles and groups, and infra-versus-app is role and
client assignment inside it. An earlier version of this file said *"one Keycloak
does not mean one realm"*; that was wrong and framed a settled question as open.

**Postgres: `app-postgres` is gone** (2026-07-31). The app's data lives on the
platform Postgres as `hill90_api`, `hill90_akm` and `hill90_litellm`, owned by
`hill90_app`, which is `superuser=false`. The volume and per-table-verified dumps
were kept.

**MinIO: storage moved up, and this section used to say the opposite.** As of
2026-07-31 the platform runs `minio`, the app consumes it through the scoped
`tenant-hill90-app` credential, and `app-minio` is stopped. Its retention window
**expired 2026-08-01 01:41 UTC**; `Verified 2026-08-03` the container is still
present as `Exited (0)` and the volume `prod_app-minio-data` still exists, so the
removal is an untaken decision rather than a pending one — see the `minio` entry
under Fast facts. This file previously listed it as *genuinely open* with
"there is no platform MinIO"; both halves are now false.

*(This paragraph read "stopped-but-retained **until** 2026-08-01 01:41 UTC" for
two days after that moment passed, while the Fast-facts entry had already been
corrected to say the window opened and nothing was done. One file, two sections,
opposite claims about the same container — and "until" is the more dangerous of
the two, because a reader who stops at the Settled section never reaches the
correction.)*

## Genuinely open

**Local now runs on the platform's Keycloak — this entry used to say it did not.**
`Verified 2026-08-01` by a completed authorization-code login: the default local path
(`./scripts/local.sh up`) authenticates against **Hill90's** Keycloak, realm `platform`,
and the token carries `resource_access.hill90-ui.roles`, `aud` including `hill90-api`, and
no `admin` in `realm_access.roles`. `bash scripts/checks/tenant-login-platform-test.sh`
re-proves **that** — and since 2026-08-04 it runs the flow with the parameters the UI
container actually holds, so it now also fails when a browser could not complete the
login. The `auth` stack is gone from `local.sh`'s `STACKS`.

**A human can now sign in locally — `Verified 2026-08-04`** by a browser completing
`dev`/`dev` against realm `platform` and landing on `/agents` with a session carrying
`roles: ["admin"]`. It could not the same morning (#271), and **two independent defects
had to be fixed, not one**: `AUTH_URL` was the Traefik host while the `hill90-ui` client
allows `localhost:13000` (HTTP 400, `Invalid parameter: redirect_uri`), and behind it
`KEYCLOAK_INTERNAL_ISSUER` was *also* the browser-facing host, which inside the container
is `127.0.0.1` — so the token exchange died on `ECONNREFUSED` and NextAuth reported
`error=Configuration`, naming nothing. Fixing the redirect alone moved the failure one
step later. Both are in `deploy/compose/overrides/local.ui.yml`; Hill90's realm was not
touched.

**The instrument lesson outlives the bug.** `tenant-login-platform-test.sh:32` hardcoded
the `localhost:13000` redirect and grepped the client secret out of `.env.local`, so it
printed four green assertions on a stack where nobody could sign in: **a check that
hardcodes a parameter can never fail on that parameter being wrong.** It now reads
`redirect_uri`, `client_id`, secret and issuer from the running UI container and asserts
the client accepts that redirect. `tests/scripts/login-check-sees-redirect.bats` holds
that shape — 8 of its 9 tests fail against the pre-fix files.

**What is still open is the rest of it:** local Postgres and MinIO are still the app's own.
**The realm-drift half is now fixed, `Verified 2026-08-04`:** `--standalone`'s vendored
realm (`compose/local/keycloak/realm-local.json`) was missing the `basic` client scope —
found and fixed in #345, after #306 and #313 made a sub-less token a hard 401 and turned
what had been a silent local ownership bug into a full standalone lockout. `check_vendored_realm.py`
now reports no drift against Hill90's realm, confirmed by importing the fixed file into a
real Keycloak container and reading the client's scopes back, not by inference. *(This
paragraph previously said `--standalone` "still runs the fork's Keycloak against a copy of
the platform realm that has measurably drifted," unqualified. That was true of the tree
before #345 and is not true of it now.)*

## Auth — what is true right now

**The `hill90-ui` client secret is repaired** (~23:50 UTC 2026-07-29; Keycloak and
the store agree, both 64 chars, matching hash, verified 00:15 UTC 2026-07-30), and
**client authentication succeeds**.

**Login now works, and that is a change from what this file said for days.** On
2026-07-31 `testuser01` completed a real **authorization-code** login against realm
`platform`, and the `LOGIN` row is readable from the platform Postgres. The two
distinctions that cost this estate a night still stand as habits — *reachable is not
working*, and *authenticating is not signing in* — but the specific claim "no human
has completed a sign-in" is now false and should not be repeated.

Login **events are stored** since 2026-07-31, 30-day retention, so "did this user log
in, and when" is answerable from the host. Nothing exists before that timestamp:
Keycloak does not backfill, so for an earlier date the honest answer is *not
recorded*, never *did not happen*.

Note when diagnosing: the correct and the wrong secret **both return HTTP 401**.
The correct one says *Client not enabled to retrieve service account* — the client
authenticated and that grant is simply not permitted. The wrong one says *Invalid
client or Invalid client credentials*. Read the body, not the status.

**Users.** The realm import ships **zero** users. `jon` and `hill90admin` were
created by hand with temporary passwords; `testuser01` has a non-temporary one,
encrypted at `infra/secrets/test-accounts.enc.env`. No credential belongs in this
repo in plaintext. The realm imports ship **zero** users, so a directory rebuild locks
everyone out; that is a known gap, not an oversight.

**Tenancy detachment — proven.** The yank-out test passed on 2026-07-29: teardown
left Hill90 at exactly its 13-container baseline with all shared networks intact,
the redeploy brought the app back to 10 healthy containers, and both accounts
survived in the database. **That 13 is the baseline as it was on 2026-07-29 and is
not the number to check against today** — the platform is now **16 by name**
(`Verified 2026-07-31 11:20 UTC`; `minio`, then `alertmanager` and
`blackbox-exporter` arrived after that test). The tenant runs 7, for 23 in total.

## Fast facts

```bash
./scripts/local.sh up                 # local stack; tenant path is the default
./scripts/local.sh up --standalone    # self-contained fork, no Hill90 needed
gh workflow run "Manual Deploy App (Prod)" -f service=ui -f dry_run=true
```

- Production: `hill90.com` (UI). Identity is `auth.hill90.com`, **Hill90's**
  Keycloak, realm `platform` — authorization by **client** roles on `hill90-ui`,
  not realm roles. `app-auth.hill90.com` was the app's own Keycloak and now
  **404s**; `app-keycloak` was retired 2026-07-30.
- Local: UI `http://localhost:13000`, API `:13001`, Keycloak `:18080` — full
  port table in the README.
- **`services/ui` (vitest) is flaky too, and is now characterised —
  [issue #117](https://github.com/jonhill90/hill90-app/issues/117).**
  `DashboardClient › renders active agents widget with running agents` fails in CI
  only: 3 CI failures against ~40 local runs across four emulated CI conditions.
  Unresolved. **Do not make it green by re-running** — a retry that passes tells you
  it is flaky and nothing more.
- **`services/knowledge/tests/integration` DOES run in CI** — this is corrected, not
  aged. `Verified 2026-08-04`: the `knowledge` matrix leg in `ci.yml` runs against a
  real `pgvector/pgvector:pg16` service container with an extension-enable step, wired
  in by commit `c81865c` on **2026-08-03** — a full day before this file's own previous
  edit, so the claim below was already false when it was last written here, not merely
  stale since. The deletion-leaves-SEARCH regression test added in #84 is gated. The
  file/test counts in the superseded text were also wrong independent of the CI
  question: **21** test files exist today, not 19, with **135** test functions, not 98
  — counted directly from the directory, not carried over from `ci.yml`'s own comment,
  which repeats the same wrong 19/98 figures for the same reason this file did.
  *(Superseded, kept for the record: "`services/knowledge/tests/integration` does not
  run in CI — 19 files, 98 tests, excluded because they need a live pgvector Postgres
  on `localhost:5432`... Giving that job a Postgres service container is the fix and
  has not been done." That fix had already happened.)*
- CI (`ci.yml`) runs on every pull request — eight jobs, `Verified 2026-08-05`
  against the workflow file directly: api (jest), ui (vitest), a pytest matrix
  for ai/knowledge/mcp/agentbox, lint (eslint + ruff across api/ui/python),
  services/cli (go) and services/cli (node), sql-identifiers, and scripts
  (bats). "Six suites" undercounted this from the day `lint`, `cli`,
  `cli-node` and `sql-identifiers` were added and never folded into the
  count. Deploy (`deploy.yml`) stays `workflow_dispatch` only; a merge must
  not deploy.
- Backups live in **Hill90**: `bash scripts/backup.sh backup app-db`. Verified
  restorable 2026-07-29. Nothing in this repo backs anything up.
- Stacks: `api ai knowledge mcp ui` — five, not six; `Verified 2026-08-04` against
  `scripts/deploy.sh`'s own `DEPLOY_ORDER` (`ui api ai knowledge mcp`). **`db`, `auth`
  and `minio` are RETIRED and `deploy.sh` refuses them** — identity, data and object
  storage are the platform's. Their compose files are kept on purpose because local
  layers on them (`minio`'s local compose stays for the same reason — local runs
  `app-minio` deliberately, see below). `api` creates the two agent networks
  (`agent_sandbox`, `docker_proxy`), so it precedes `ai` and `knowledge`. *(This line
  previously read "Stacks: `api ai knowledge mcp minio ui`," listing `minio`
  undistinguished from the five deployable stacks even though the very next bullet
  already said it was retired — same shape as the MinIO paragraph's own
  two-places-disagreeing note further down this file.)*
- **`minio` is retired and `deploy.sh` refuses it**, like `db` and `auth` — since #91.
  Production object storage is the platform's `minio`; the app's `app-minio` has been
  stopped since 2026-07-31 01:40:43 UTC. **That removal window OPENED on 2026-08-01
  01:41 UTC and nothing has been done — `Verified 2026-08-03`:** the container still
  exists (`app-minio  Exited (0) 3 days ago`) and so does `prod_app-minio-data`.
  This entry read "the window opens" for two days after it had opened, which invited
  a cold reader to treat a decision that is due as one that is pending. **Deleting
  the volume is still a deliberate, irreversible decision nobody has taken**, and
  this note is not an argument for taking it. *(This entry said the opposite for about an hour: written
  when `minio` was still in `DEPLOY_REST`, and left standing when #91 removed it.)*
  Redeploying this stack is the hardest of the three to notice: both backends are
  MinIO, so `storage.hill90.com` answers 200 either way and looks fine.
  Procedure, evidence checks and abort conditions:
  [`docs/runbooks/retiring-app-minio.md`](docs/runbooks/retiring-app-minio.md).
  **The local compose files stay regardless** — local runs `app-minio` deliberately.
- **A green api-suite run is still not evidence.** Partly explained, not fixed.
  **Explained and closed: the 501s** — a third-party daemon (Logitech's
  `LogiPluginService`, serving `websocket-sharp`) listens in the ephemeral port range
  supertest binds from and answers 501. **Still open: 400/401/404 and timeouts**,
  established by measurement as a *separate* defect — do not assume the 501 finding
  covers them, and do not re-litigate the 501. Sixteen hypotheses are dead, each with
  what killed it. **Rates quoted before round seventeen are contaminated**, because
  about a third of the failures counted were the foreign 501s; mechanism-level
  conclusions survive, rate-based ones do not. **Nobody should restart from zero:**
  [`docs/decisions/api-suite-flakiness.md`](docs/decisions/api-suite-flakiness.md).
  **A recent data point, not a resolution — `2026-08-04`:** three full-suite runs
  (119 suites, 1145 tests, run for unrelated work that session) came back completely
  clean. Recorded because it happened, not because it settles anything: this
  document's own bar is sixteen dead hypotheses and mechanism-level analysis, and
  three clean runs don't meet that bar. A flake that hasn't appeared in three runs is
  not the same claim as a flake that's been explained — treat this as one more data
  point for whoever picks this up next.
- **Two cheap diagnostics, both decisive here — try them before theorising.**
  **Does it pass alone?** One run. Passes alone → the defect needs company and every
  single-file theory is dead; fails alone → the cross-file search is unnecessary.
  **Is the response ours?** `services/api/jest.identityguard.js` is on by default and
  fails loudly when a response carries no identity stamp (a process outside this repo
  answered) or the wrong one (a sibling jest worker did). A status code can be a
  legitimate answer; an identity stamp cannot.
- **This tenant's public surface is monitored by the platform, and alerts now reach a
  human** (`Verified 2026-07-31 11:20 UTC`). `PublicSiteDown` watches `hill90.com`;
  `TenantApiDown` watches `api.hill90.com/health` — added because the first does not
  cover it, since `hill90.com/api/health` is the **UI's own** route and reports
  `service: "ui"` rather than proxying to the API. **No `app-*` container is scraped
  and none exposes `/metrics`**, so nothing sees inside this tenant; `litellm` and
  `ai/mcp` are unprobed because they return 403 and 404 in normal operation. Detail
  in the platform's `docs/decisions/tenant-monitoring-coverage.md`.
