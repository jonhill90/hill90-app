# hill90-app

An AI agent platform that runs locally in Docker. Not currently deployed
anywhere — the Hill90 VPS was rebuilt in June 2026 and this stack was not
redeployed — but the local stack is verified working as of 2026-07-26.

```bash
./scripts/local.sh up
```

That generates local credentials and signing keys, builds the images, starts
nine containers, and waits for them to go healthy. Then open
**http://localhost:13000** and log in as **dev / dev**.

No provider API key is needed to bring the stack up and browse it. Chat and
embeddings need a real `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env.local`.
See [Running locally](#running-locally) for the full picture.

This is the application extracted from
[jonhill90/Hill90](https://github.com/jonhill90/Hill90), carrying its own git
history — 542 commits reaching back to 2026-01-11. It was separated from that
repo so it could be developed independently, without dragging the VPS
infrastructure along. See
[docs/decisions/infra-app-separation.md](docs/decisions/infra-app-separation.md)
for the original decision and [docs/extraction/](docs/extraction/) for exactly
how the split was performed and verified.

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
  view; retains infrastructure context that now lives in Hill90
- The published pages live in
  [jonhill90/hill90-docs](https://github.com/jonhill90/hill90-docs) and are served at
  [docs.hill90.com/ai-app](https://docs.hill90.com/ai-app/overview). This repo no longer
  carries a copy — it was a duplicate that had already drifted.

## Running locally

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
OpenBao/SOPS secrets tooling, Tailscale, the deploy scripts and per-service
deploy workflows, and `services/dns-manager` (which despite its path was
infrastructure — a DNS-01 ACME webhook Traefik depended on). That service no longer
exists anywhere: Hill90 moved DNS to Cloudflare on 2026-07-27 and deleted it, and Traefik
now solves DNS-01 with lego's built-in `cloudflare` provider. The capability is unchanged;
the component is gone.

So there is no deployment path in this repo. `deploy/compose/prod/*.yml`
describes how the services *were* wired on the VPS and is preserved as a
specification, not as something you can run. Redeploying would mean pairing it
with an infrastructure repo again.

## History

[`RESURRECTION.md`](RESURRECTION.md) records what was broken when the app was
extracted and what has since been fixed — worth reading before changing the
compose or auth wiring, since several of those problems were subtle.

## Repository layout

```
services/           the application (8 services)
platform/ai/        LiteLLM model-router config
platform/auth/      Keycloak realm, clients, and the hill90 theme
platform/data/      Postgres database bootstrap
deploy/compose/     prod and dev compose definitions (prod is spec-only)
scripts/            local stack driver; two database provisioners that cannot
                    currently run (see below)
tests/e2e/          Playwright suites
docs/               architecture, decisions, app runbooks
docs/extraction/    provenance, verification output, Hill90 commit map
PRD.md / SPEC.md    why and how this extraction was done
```

`scripts/provision-akm-db.sh` and `scripts/provision-litellm-db.sh` **cannot run as
extracted.** Both source `scripts/_common.sh`, which was never extracted and does not
exist in this repo, so under `set -e` they die at line 7. Both also hardcode
`--username postgres`, and the Postgres they were written against has `hill90` as its only
role. The local stack does not use them — `platform/data/postgres/init.sh` runs as a
Postgres entrypoint script instead — so this blocks nothing today, but the scripts are
not usable in their current form.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs unit tests only and
is gated to `workflow_dispatch` — it never fires on its own, because this repo has no
deploy target.

**The suites pass.** Run on `main` at `e04aa6a` on 2026-07-26: all six jobs green in
2m26s, **1953 tests, zero failures**. See [`RESURRECTION.md`](RESURRECTION.md#8-ci-is-gated-off--still-gated-and-the-suites-pass)
for the breakdown and for what that does and does not prove — it is unit tests only, and
nothing there demonstrates the services work together.
