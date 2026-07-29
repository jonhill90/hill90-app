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
- [`RESURRECTION.md`](RESURRECTION.md) — what was broken at extraction and what
  was done about it. §2 is the deploy path; §10 is the missing-users gap.
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

## Open decisions — do not write these as settled

**One Keycloak is the decision; two are running.** Today the platform runs
`keycloak` (realms `master`, `platform`) and the app runs `app-keycloak` (realms
`master`, `hill90`) — verified 2026-07-29 05:55 UTC. **Decided:** there will be
one Keycloak, and the app will stop shipping its own. **Not decided:** whether
the app's clients land in a new `hill90` realm on the platform Keycloak or in
the existing `platform` realm — one Keycloak does not mean one realm. **Not
started:** no migration has happened, and the platform Keycloak has no `hill90`
realm to consolidate into. Export before delete, never the reverse.

**Postgres is still two instances** — Hill90's `postgres` and the app's
`app-postgres`, on separate volumes. **No decision has been recorded.** Note
that consolidating data is not obviously the same move as consolidating
identity: Hill90's health check asserts platform-only databases, which is a
designed boundary.

**Users.** The app's realm import ships **zero** users while the local realm
bakes in a `dev` account. Production accounts are created by an operator with
temporary passwords changed at first login, and they exist only in the app's
database. No credential belongs in this repo. See `RESURRECTION.md` §10.

**Tenancy detachment.** The yank-out test has been run in part: teardown left
Hill90 at its 13-container baseline with all shared networks intact, and
application data survived. **The redeploy half is not finished, so the test is
not yet passed** (checked 2026-07-29 05:57 UTC).

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
- CI (`ci.yml`) and deploy (`deploy.yml`) are both `workflow_dispatch` only.
  Neither fires on push.
- Eight stacks: `db auth api ai knowledge mcp minio ui`. `api` creates the two
  agent networks, so it precedes `ai` and `knowledge`.
