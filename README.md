# hill90-app

An AI agent platform that runs locally in Docker and in production as a tenant of
the [Hill90](https://github.com/jonhill90/Hill90) platform, consuming its
identity, database and object storage. [hill90.com](https://hill90.com) serves the UI on a Let's Encrypt
certificate. **All eight stacks are deployed and healthy.** See
[Production](#production).

```bash
./scripts/local.sh up
```

That generates local credentials and signing keys, builds the images, starts
nine containers, and waits for them to go healthy. Then open
**http://localhost:13000** and log in as **dev / dev**.

No provider API key is needed to bring the stack up and browse it. Chat and
embeddings need a real `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env.local`.
See [Running locally](#running-locally) for the full picture.

## What it is

An AI agent platform: agents run in sandboxed containers, reach models through a
policy-gated router with BYOK and delegated scopes, and share a knowledge base
with full-text search. A Next.js UI drives it, with durable SSE streaming for
chat.

| Service | Stack | Role |
|---|---|---|
| [`services/api`](services/api) | Express / TypeScript | Control plane — agent lifecycle, Ed25519 JWT signing, provider connections, model policies, chat, usage. 65 migrations under `src/db/migrations/` |
| [`services/ai`](services/ai) | FastAPI / Python 3.12 | Model router — policy-gated inference, BYOK, delegated scopes, fronts LiteLLM. Internal-only (`traefik.enable=false`) |
| [`services/knowledge`](services/knowledge) | FastAPI / Python 3.12 | Agent Knowledge Manager — persistent memory, full-text search, journaling, context assembly. Internal-only. 12 migrations |
| [`services/agentbox`](services/agentbox) | Starlette / uvicorn | Sandboxed agent runtime — non-root `agentuser`, resource limits, network isolation, policy-gated shell and filesystem |
| [`services/mcp`](services/mcp) | Python 3.12 | Model Context Protocol gateway, Keycloak JWT authenticated |
| [`services/ui`](services/ui) | Next.js | Frontend; Auth.js v5 sessions against Keycloak |
| [`services/cli`](services/cli) | — | Terminal client. No deploy wiring |
| [`services/discord-bot`](services/discord-bot) | — | Multi-channel chat bridge. No deploy wiring |

Architecture, in the depth it was actually written:

- [docs/architecture/agent-harness.md](docs/architecture/agent-harness.md) — the
  core design: agentbox runtime contract, agent lifecycle, model-router pipeline,
  AKM knowledge system, network topology
- [docs/architecture/agent-identity-model.md](docs/architecture/agent-identity-model.md)
- [docs/architecture/trust-boundaries.md](docs/architecture/trust-boundaries.md)
- [docs/architecture/ui-components.md](docs/architecture/ui-components.md)
- [docs/architecture/overview.md](docs/architecture/overview.md) — whole-system
  view, including the infrastructure this app runs on
- The published pages live in
  [jonhill90/hill90-docs](https://github.com/jonhill90/hill90-docs) and are served at
  [docs.hill90.com/ai-app](https://docs.hill90.com/ai-app/overview). This repo no longer
  carries a copy — it was a duplicate that had already drifted.

## Running locally

### What each local path proves

`Verified 2026-08-01.` These are not interchangeable, and a green login on the wrong
one is not evidence about production.

| Path | Keycloak | Realm | Proves |
|---|---|---|---|
| **`./scripts/local.sh up`** (default, tenant) | **Hill90's** | `platform` — *the realm production uses* | **The tenancy.** Same realm, same clients, same client-role authorisation as production |
| `./scripts/local.sh up --standalone` | the fork's own | a local realm also named `platform` | **The realm design only.** It does **not** prove the tenancy |

**The standalone fork's realm is still a copy, but it is no longer drifting.** The six
divergences measured on 2026-08-01 — `hill90-ui` on `bearerOnly`,
`directAccessGrantsEnabled`, `serviceAccountsEnabled`, `fullScopeAllowed` and
`defaultClientScopes`, plus `hill90-api` on `fullScopeAllowed` — were **reconciled to
upstream**, not declared acceptable. `defaultClientScopes` was the load-bearing one: it
carries the `roles` scope that emits the claim authorisation reads, and locally it was not
set at all.

A guard now holds it there. `scripts/checks/check_vendored_realm.py` compares the
load-bearing fields against a committed extract of Hill90's realm on every pull request,
and the copy keeps its localhost redirect URIs, dev secret and seeded users because those
are declared divergences rather than accidents.

So: **a green standalone login proves the realm design, on clients that now match
production's on everything that decides authorisation. It still does not prove the
tenancy** — that needs the default path, which uses Hill90's own Keycloak.

Prove the tenant path end to end at any time:

```bash
bash scripts/checks/tenant-login-platform-test.sh
```

It completes a real authorization-code flow and asserts `resource_access.hill90-ui.roles`,
`aud` including `hill90-api`, no `admin` in `realm_access.roles`, and that `iss` is realm
`platform`.

`compose/local.yml` is a purpose-built local stack. It is not the production
topology: it creates its own Docker networks, skips Traefik entirely, and routes
by published port instead of the 37 `traefik.*` labels in `deploy/compose/prod/`.

| Command | |
|---|---|
| `./scripts/local.sh up` | generate config if needed, build, start, wait for health |
| `./scripts/local.sh up --infra` | same, but attach to a local Hill90 infra stack (see below) |
| `./scripts/local.sh status` | container and health summary |
| `./scripts/local.sh logs [service]` | follow logs |
| `./scripts/local.sh down` | stop, keep data |
| `./scripts/local.sh reset` | stop and destroy volumes, including both databases |
| `./scripts/local.sh agentbox` | build the agent runtime images (see below) |

| Service | URL |
|---|---|
| UI | http://localhost:13000 — log in as `dev` / `dev` |
| API | http://localhost:13001/health |
| AI (model router) | http://localhost:18000/health |
| MCP gateway | http://localhost:18001/health |
| Knowledge (AKM) | http://localhost:18002/health |
| Keycloak | http://localhost:18080 — admin `admin` / `admin` |
| MinIO console | http://localhost:19001 |
| Postgres | `localhost:15432` |

Ports sit in a 13000/18000 band deliberately, to avoid colliding with anything
already bound on 3000, 5432, or 8054. No band avoids every host, so
`local.sh up` checks them before it starts anything and, on a clash, names the
port, the `PORT_*` variable to change in `.env.local`, and the container holding
it.

`scripts/local.sh` generates `.env.local` and two Ed25519 keypairs on first run.
The API signs agent tokens with the private halves; the AI and knowledge
services verify against the public halves mounted at `/etc/akm`. All of it is
local-only and disposable — delete `.env.local` and `compose/local/keys/` to
regenerate.

### What needs a real credential

The stack starts, authenticates, and is fully browsable with no provider key.
Set these in `.env.local` for the features that need them:

- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` — chat, inference, embeddings
- `TAVILY_API_KEY` — the agent web-search tool

### Running alongside the Hill90 infra stack

By default the app is self-contained. If you also run the Hill90 infrastructure
repo's local path (Traefik plus the observability stack), the app can attach to
it instead of standing alone:

```bash
./scripts/local.sh up --infra
```

The overlay `compose/local.infra.yml` changes three things: the shared networks
become `external` so infra owns them, services join the same networks they join
in production, and Traefik labels make the app reachable by hostname:

| | |
|---|---|
| UI | http://app.localtest.me:8080 |
| API | http://api.localtest.me:8080/health |
| Keycloak | http://app-auth.localtest.me:8080 |
| MCP gateway | http://ai.localtest.me:8080/mcp |
| MinIO console | http://storage.localtest.me:8080 |

`localtest.me` resolves to 127.0.0.1, so no hosts file entry is needed. The
published ports keep working too — both routes reach the same containers. The
exception is Postgres: in this mode it sits on an `internal` network exactly as
in production, and Docker cannot publish a port from one, so use `docker exec`.

**Network ownership.** Infra creates `<prefix>_edge`, `<prefix>_internal` and
`<prefix>_agent_internal`; the app creates `<prefix>_agent_sandbox` and
`<prefix>_app_internal`. The sandbox split is inherited from production, where
`docker-compose.api.yml` is the sole creator of that network. The prefix comes
from `NETWORK_PREFIX` in `.env.local` and must match the infra repo's value — its
local path uses `hill90dev`. `--infra` checks all three infra networks exist
before starting anything, and names the missing ones if not.

**Why the app's Keycloak is `app-auth` and not `auth`.** Hill90's own Keycloak
already owns `auth.<domain>` and answers to the name `keycloak` on both shared
networks, and its realm is `platform`, not `hill90`. The app's Keycloak therefore
uses `${APP_AUTH_HOST:-app-auth}` for its hostname and an `app-keycloak` alias on
`<prefix>_app_internal` for internal traffic. `<prefix>_app_internal` exists for
the same reason: Compose cannot remove a service's own name as a network alias,
so the only way for the app's Postgres not to answer to `postgres` alongside
Hill90's is to keep it off the shared internal network. See
[the decision record](docs/decisions/running-the-app-on-hill90-infra.md) for the
full set of collisions and what each one looked like when it failed.

**`--infra` also requires a fix in the Hill90 repo.** Its Traefik constrains the
Docker provider to an explicit list of compose projects that omitted this app's
project, so every app hostname returned 404. Branch
`fix/local-traefik-accept-app-routers` there adds it. Without that change the
hostnames below 404 and only the published ports work.

Running standalone and `--infra` at the same time is not supported: both create
`<prefix>_agent_sandbox`. Bring one down before starting the other.

### Verified cold

> **Superseded in part, 2026-07-27.** This run is kept as the dated record it is,
> but one line of it no longer reproduces: the app's Keycloak has moved from
> `auth.localtest.me` to `app-auth.localtest.me`, because `auth.<domain>` is
> Hill90's and serves realm `platform`. Against the current tree
> `auth.localtest.me/realms/hill90` returns **404** and
> `app-auth.localtest.me/realms/hill90` returns 200. Treat the `Keycloak realm`
> row below as historical. The other rows were re-checked on 2026-07-27 and still
> hold, with the Hill90-side Traefik fix noted above applied.

Both stacks were brought up together from fresh clones of both repos, with no
reused containers, volumes or images, on 2026-07-26:

| | |
|---|---|
| `hill90-app` | `49b2b56` |
| `Hill90` | `0b40403` |

Hill90's [local-development runbook](https://github.com/jonhill90/Hill90/blob/main/docs/runbooks/local-development.md)
brought infra up (`bash scripts/local.sh up`, then `health` — all checks green),
then `./scripts/local.sh up --infra` here reached nine healthy containers and
served through Traefik by hostname, not by published port:

```
SERVICE          URL                                            CODE
UI               http://app.localtest.me:8080/                  200
API health       http://api.localtest.me:8080/health            200
Keycloak realm   http://auth.localtest.me:8080/realms/hill90    200
MCP gateway      http://ai.localtest.me:8080/mcp/health         200
MinIO console    http://storage.localtest.me:8080/              200

internal-only, correctly unrouted:
  ai.localtest.me/health         404
  knowledge.localtest.me/health  404
```

`api` was attached to `<prefix>_{edge,internal,agent_internal,agent_sandbox}`
with no `hill90_local`, confirming it used infra's networks rather than its own,
and a browser login through Traefik reached an authenticated dashboard.

This is worth re-running only after a change to `compose/`, `scripts/local.sh`,
or the infra repo's local path — it is the check that catches
works-on-my-machine breakage, and it has caught real breakage twice.

### Running agents

`services/agentbox` is not a compose service. The API creates one container per
agent from the `hill90/agentbox` image, over the Docker socket. Build the images
first with `./scripts/local.sh agentbox` — it is a slow build that installs
Node, Playwright and a shell environment.

## What is not here

The infrastructure stayed in Hill90 and is **not** reproduced: Ansible VPS
bootstrap, Traefik and its ACME configuration, the LGTM observability stack,
OpenBao, Tailscale, and `services/dns-manager` (which despite its path was
infrastructure — a DNS-01 ACME webhook Traefik depended on). That service no longer
exists anywhere: Hill90 moved DNS to Cloudflare on 2026-07-27 and deleted it, and Traefik
now solves DNS-01 with lego's built-in `cloudflare` provider. The capability is unchanged;
the component is gone.

This repo now carries its own deploy path — `scripts/deploy.sh`, a SOPS secrets
store under `infra/secrets/`, and a GitHub Actions workflow — built here rather
than inherited from Hill90. See [Production](#production).

## Production

The app runs as a **tenant** of the Hill90 platform. It does not own the host or
the edge: `hill90_edge` and `hill90_internal` are consumed as external networks
that Hill90's infra stack creates. Network, volume and container names are
parameterised through `NETWORK_PREFIX`, `VOLUME_PREFIX` and `CONTAINER_PREFIX`,
so one set of compose files serves both local and production.

Deployment is **pipeline-only**, over SSH from a GitHub Actions runner joined to
the tailnet. It is never run from a workstation.

```bash
gh workflow run "Manual Deploy App (Prod)" -f service=ui -f dry_run=true
```

`workflow_dispatch` only, with inputs `service`, `dry_run` and
`confirm_public_deploy`. `dry_run` runs every guard — secrets, tenancy contract,
host paths — and stops before deploying anything.

**Verified against the host 2026-07-29 07:34 UTC** — 23 containers running, 0
unhealthy, of which 13 are Hill90's platform baseline and 10 are this app.

| Stack | State |
|---|---|
| `db`, `auth`, `api`, `ui`, `knowledge`, `ai`, `mcp`, `minio` | deployed, healthy |

**Deployed is not the same as current.** Several changes are merged to `main` and
**not yet deployed** — as of 2026-07-29 07:34 UTC that includes #22, #25, #26 and
#28. The running containers still carry the previous configuration.

Do not read the table as a roadmap. It is the state of the host at the timestamp
above, and it goes stale — re-check before relying on it.

`knowledge` and `ai` both failed on first deploy and looked like two unrelated
problems: `knowledge` crash-looped on `FileNotFoundError: /etc/akm/public.pem`
while `ai` came up but never went healthy. **One cause.** Nothing seeded the
`prod_app-akm-keys` volume, which both services mount at `/etc/akm`; the
signing keys are generated locally by `scripts/local.sh` and there was no
equivalent step in the deploy path. Once the volume held `public.pem` and
`model-router-public.pem`, both recovered with no further change.

### Signing in — client authentication works; sign-in unproven

> **The `hill90-ui` client secret is repaired** (~23:50 UTC 2026-07-29). Keycloak
> and the store agree — both 64 characters, matching hash, verified 00:15 UTC
> 2026-07-30 — and **client authentication succeeds**.
>
> **No human has completed a sign-in.** That is a different claim and it is still
> unproven. Two distinctions cost this project a night: *reachable is not
> working*, and *authenticating is not signing in*.
>
> Diagnosing note: correct and wrong secrets **both return HTTP 401**. The correct
> one says *Client not enabled to retrieve service account* — authenticated, that
> grant simply not permitted. The wrong one says *Invalid client or Invalid client
> credentials*. Read the body, not the status.

[hill90.com](https://hill90.com) → **Sign in** redirects to
`app-auth.hill90.com`, the app's own Keycloak, using PKCE and the `hill90-ui`
client. Accounts are created by the operator in the `hill90` realm with
temporary passwords that must be changed at first login. No credentials are
published here, and none are seeded — see
[CLAUDE.md](CLAUDE.md)
for why that is a known gap rather than an oversight.

### Consolidation — decided, not yet done

**The platform provides identity, data and storage; this app consumes them.**
Every decision below follows from that.

Production currently runs both Hill90's platform services and the app's own:
Hill90 holds realm `platform` on `auth.hill90.com`, the app holds realm `hill90`
on `app-auth.hill90.com`, and each has its own Postgres with separate volumes.
That is the current state, not the target.

- **Keycloak — decided.** One Keycloak, one realm, the **existing `platform`**.
  No new `hill90` realm. You do not create a second directory for one
  organisation; infra-versus-app is role and client assignment inside it.
- **Postgres — DONE, 2026-07-31.** `app-postgres` is retired: container removed,
  volume `prod_app-postgres-data` deliberately kept, all four services on the
  platform instance as the tenant role `hill90_app`. The complication turned out to
  be solvable rather than blocking — the platform grew a NOSUPERUSER tenant role with
  per-database grants, so the "platform-only databases" health check was never the
  obstacle it looked like. See
  [retiring-app-postgres.md](docs/decisions/retiring-app-postgres.md).
- **MinIO — open**, and reversed: only `app-minio` exists, there is **no platform
  MinIO**, so the question is whether storage moves *up*.

This is **greenfield configuration, not a migration** — the app first reached the
VPS on 2026-07-29 and has no accumulated state. The realm export and database
backup are a safety net, not steps in a process.

The tenancy is detachable, and this has been **tested rather than assumed**. On
2026-07-29 the app was torn down to a single container and redeployed: Hill90
returned to exactly its 13-container baseline with all four shared networks
intact, the app came back to 10 healthy containers, `hill90.com` answered 200,
the login form was reachable, and both user accounts survived in the database.
The yank-out test passed. Note the limit: accounts surviving is a data claim, and
the login form rendering is a routing claim — neither means a user can sign in.
See [Signing in](#signing-in--client-authentication-works-sign-in-unproven).

### Backups

The app's data is backed up by **Hill90's** `scripts/backup.sh`, not by anything
in this repository:

```bash
bash scripts/backup.sh backup app-db      # run in the Hill90 checkout, on the VPS
```

That takes a real `pg_dumpall` of the app's databases plus a tar of the
`prod_app-postgres-data` volume, and refuses rather than warns if the dump cannot
be produced. `backup-all` includes it on the nightly cron.

**This `app-db` target will now FAIL every night, and that is a Hill90-side change
that has not been made.** `backup_app_db` dies when `app-postgres` is not found, and
as of 2026-07-31 it is not: the container was retired. `backup-all` isolates each
target in a subshell, so `db`, `vault`, `infra` and `observability` still complete —
but the 03:00 job exits non-zero with `app-db` named.

The app's data is not at risk in the meantime, which is the part worth being precise
about. Hill90's `db` target runs `pg_dumpall` against the platform instance, and
since the cutover that dump contains `hill90_api`, `hill90_akm` and `hill90_litellm`
— verified in `/opt/hill90/backups/db/20260730_030001/database.sql`. So the SQL half
of `app-db` is now redundant. The volume-tar half is not, and stays useful for as
long as `prod_app-postgres-data` exists.

**Verified end to end on 2026-07-29.** The dump was restored into a throwaway
Postgres container and both user accounts came back with their correct realm
roles. Artifacts from that run:

```
/opt/hill90/backups/db/20260729_065934/database.sql              322299 bytes
/opt/hill90/backups/app-db/20260729_065944/app-database.sql      532513 bytes
/opt/hill90/backups/app-db/20260729_065944/app-postgres-data.tar.gz  17347196 bytes
```

Worth knowing what this replaced: before that date the app's volume had **never
been backed up by anything**, and Hill90's own SQL dump had been failing silently
for days — the job reported success while producing only a volume tar.

## Repository layout

```
services/           the application (8 services)
platform/ai/        LiteLLM model-router config
platform/auth/      Keycloak realm, clients, and the hill90 theme
platform/data/      Postgres database bootstrap
deploy/compose/     prod compose definitions, plus the local override layer
infra/secrets/      SOPS-encrypted production secrets store
scripts/            local stack driver, tenant deploy script, database
                    provisioners
tests/e2e/          Playwright suites
docs/               architecture, decisions, app runbooks
```

`scripts/provision-akm-db.sh` and `scripts/provision-litellm-db.sh` both source
`scripts/_common.sh`, which was missing — under `set -e` they died at line 7, and
that masked three further bugs. All four are fixed: `_common.sh` now exists, both scripts resolve
`${PG_CONTAINER:-${CONTAINER_PREFIX:-}app-postgres}` rather than Hill90's
`postgres`, and they run one `psql` invocation per target database. The local
stack still does not use them — `platform/data/postgres/init.sh` runs as a
Postgres entrypoint script instead.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on **every pull
request**, on pushes to `main`, and on demand. Six suites: `services/api` (jest),
`services/ui` (vitest), and pytest for `ai`, `knowledge`, `mcp` and `agentbox`.

It gated nothing but shell tests until 2026-07-29 (#30); before that it was
`workflow_dispatch`-only, justified by a comment saying this repo had no deploy
target. It has one, and now the application tests gate a merge.

The deploy workflow remains dispatch-only, deliberately: a merge should not
deploy to production by itself.

**The suites pass** — all six jobs green, **1953 tests, zero failures**. See
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)
for the breakdown and for what it does and does not prove: these are unit tests,
and nothing in them demonstrates the services work together.
