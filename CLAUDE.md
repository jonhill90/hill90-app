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
time on 2026-07-29. Realm `hill90` holds two accounts created hours earlier
which, since login never worked, have never been used. There is no accumulated
state. Export, import, rollback and cutover are the wrong frame — the realm
export and the database backup are a **safety net**, not steps in a process.

**Keycloak: one Keycloak, one realm, the existing `platform`.** This app's
clients go into `platform`; there is no new `hill90` realm. The reasoning is an
Entra analogy — you do not create a second tenant for one organisation; one
directory, controlled with roles and groups, and infra-versus-app is role and
client assignment inside it. An earlier version of this file said *"one Keycloak
does not mean one realm"*; that was wrong and framed a settled question as open.

**Postgres: `app-postgres` goes.** This app consumes the platform's Postgres. The
complication is real and is not the Keycloak steps repeated: Hill90's health check
asserts *platform-only databases*, so that boundary needs revisiting deliberately.

## Genuinely open

**MinIO, and the state is reversed.** Only `app-minio` exists; there is **no
platform MinIO**. The question is whether storage moves *up* into the platform,
which the governing principle suggests it should. Never addressed.

## Auth — what is true right now

**The `hill90-ui` client secret is repaired** (~23:50 UTC 2026-07-29; Keycloak and
the store agree, both 64 chars, matching hash, verified 00:15 UTC 2026-07-30), and
**client authentication succeeds**.

**That is not login working.** No human has completed a sign-in. Do not write
anything implying one has. Two distinctions cost this estate a night: *reachable
is not working*, and *authenticating is not signing in*.

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
survived in the database.

## Fast facts

```bash
./scripts/local.sh up                 # local stack; tenant path is the default
./scripts/local.sh up --standalone    # self-contained fork, no Hill90 needed
gh workflow run "Manual Deploy App (Prod)" -f service=ui -f dry_run=true
```

- Production: `hill90.com` (UI), `app-auth.hill90.com` (the app's Keycloak,
  realm `hill90`). `auth.hill90.com` is **Hill90's**, realm `platform`.
- Local: UI `http://localhost:13000`, API `:13001`, Keycloak `:18080` — full
  port table in the README.
- CI (`ci.yml`) runs on every pull request — six suites: api (jest), ui
  (vitest), pytest for ai/knowledge/mcp/agentbox. Deploy (`deploy.yml`) stays
  `workflow_dispatch` only; a merge must not deploy.
- Backups live in **Hill90**: `bash scripts/backup.sh backup app-db`. Verified
  restorable 2026-07-29. Nothing in this repo backs anything up.
- Eight stacks: `db auth api ai knowledge mcp minio ui`. `api` creates the two
  agent networks, so it precedes `ai` and `knowledge`.
