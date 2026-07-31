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

- [`README.md`](README.md) — what it is, how to run it locally, and the
  **dated** production status table. That table is the single home for facts
  with a shelf life; this file deliberately does not repeat them.
- [`docs/extraction/PROVENANCE.md`](docs/extraction/PROVENANCE.md) — what came across
  from Hill90 and what deliberately did not, including the two services that have never
  been in an automated deploy.
- [`docs/reference/secret-layout.md`](docs/reference/secret-layout.md) — what each secret
  is for, and the two vault KV couplings that are not visible from the service code.
- [`docs/decisions/running-the-app-on-hill90-infra.md`](docs/decisions/running-the-app-on-hill90-infra.md)
  — the long-form record of the tenancy work, including retractions of its own
  earlier claims. Read it before re-litigating a naming or network decision.
- [`docs/decisions/HANDOFF-2026-07-31.md`](docs/decisions/HANDOFF-2026-07-31.md)
  — where the tenant stands after the cutover: what it consumes and how that was
  proven, what remains of its own three services, local's real state, and the open
  decisions. The estate-level companion is Hill90's handoff of the same date.
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
2. **The app is a tenant.** `hill90_edge` and `hill90_internal` are consumed as
   `external: true`. This repo must never create them. `agent_sandbox` and
   `docker_proxy` are the app's own, created by `docker-compose.api.yml`, which
   is why `api` must precede `ai` and `knowledge`.
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

- **Verify against the host, then date the claim.** Anything perishable —
  container counts, health, what is deployed — gets a `Verified <UTC timestamp>`
  next to it, or it goes in README's table and is linked. A dated claim that has
  aged is honest; an undated one is just wrong later.
- **Do not document what you have not run.** "The compose file parses" is not
  "the service starts".
- Prefer the shape already in Hill90 over inventing a second dialect;
  `scripts/deploy.sh` deliberately mirrors Hill90's.
- Never commit a credential, an age key, or a decrypted `.env`.

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
`tenant-hill90-app` credential, and `app-minio` is stopped-but-retained until
2026-08-01 01:41 UTC. This file previously listed it as *genuinely open* with
"there is no platform MinIO"; both halves are now false.

## Genuinely open

**Whether LOCAL development moves onto the platform services.** Production is a
tenant; local still runs the app's own Keycloak, Postgres and MinIO, so a local
test proves the realm design and not the tenancy. Deliberate, not drift — see
[`docs/decisions/local-parity-with-platform-services.md`](docs/decisions/local-parity-with-platform-services.md).

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
- **The api suite is not the only flaky one — measured 2026-07-31.** `services/ui`
  (vitest) failed one test on a **docs-only** tree and passed on re-run of the same
  commit. One observation in two runs is not a rate, but it does retire "only api
  flakes". Re-run once before investigating a red `services/ui`, and record it.
- CI (`ci.yml`) runs on every pull request — six suites: api (jest), ui
  (vitest), pytest for ai/knowledge/mcp/agentbox. Deploy (`deploy.yml`) stays
  `workflow_dispatch` only; a merge must not deploy.
- Backups live in **Hill90**: `bash scripts/backup.sh backup app-db`. Verified
  restorable 2026-07-29. Nothing in this repo backs anything up.
- Stacks: `api ai knowledge mcp minio ui`. **`db` and `auth` are RETIRED and
  `deploy.sh` refuses them** — identity and data are the platform's. Their compose
  files are kept on purpose because local layers on them. `api` creates the two
  agent networks, so it precedes `ai` and `knowledge`.
- **`minio` is a half-retirement and is NOT refused.** Production object storage is
  the platform's `minio`; the app's `app-minio` has been stopped since 2026-07-31
  01:40:43 UTC and its removal window opens **2026-08-01 01:41 UTC**. But `minio` is
  still in `DEPLOY_REST` with no `refuse_if_retired` branch, so **`deploy.sh minio`
  and `deploy.sh all` would recreate it in production** — and because both backends
  are MinIO, `storage.hill90.com` would answer 200 either way and look fine.
  Procedure, evidence checks and abort conditions:
  [`docs/runbooks/retiring-app-minio.md`](docs/runbooks/retiring-app-minio.md).
  **The local compose files stay regardless** — local runs `app-minio` deliberately.
- **A green api-suite run is not evidence.** 7 of 20 runs of `main` fail, measured
  2026-07-31. **Six** hypotheses are dead (this said seven), the fault is localised
  to half A's 29 files at ~23% with no necessary member and no reproducing subset,
  and the investigation has a **stop line**: the per-configuration table is the
  resume point, a deterministic environment audit is the next step, and further
  bisection is aimed at a minimal pair that probably does not exist. There is a
  **standing hypothesis**, labelled untested reasoning rather than a finding — read
  it before forming a seventh. **Nobody should restart from zero:**
  [`docs/decisions/api-suite-flakiness.md`](docs/decisions/api-suite-flakiness.md).
- **This tenant's public surface is monitored by the platform, and alerts now reach a
  human** (`Verified 2026-07-31 11:20 UTC`). `PublicSiteDown` watches `hill90.com`;
  `TenantApiDown` watches `api.hill90.com/health` — added because the first does not
  cover it, since `hill90.com/api/health` is the **UI's own** route and reports
  `service: "ui"` rather than proxying to the API. **No `app-*` container is scraped
  and none exposes `/metrics`**, so nothing sees inside this tenant; `litellm` and
  `ai/mcp` are unprobed because they return 403 and 404 in normal operation. Detail
  in the platform's `docs/decisions/tenant-monitoring-coverage.md`.
