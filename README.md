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
- [docs/site/](docs/site/) — the Mintlify public docs source

## Running locally

`compose/local.yml` is a purpose-built local stack. It is not the production
topology: it creates its own Docker networks, skips Traefik entirely, and routes
by published port instead of the 37 `traefik.*` labels in `deploy/compose/prod/`.

| Command | |
|---|---|
| `./scripts/local.sh up` | generate config if needed, build, start, wait for health |
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
already bound on 3000, 5432, or 8054. Override them in `.env.local`.

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

### Running agents

`services/agentbox` is not a compose service. The API creates one container per
agent from the `hill90/agentbox` image, over the Docker socket. Build the images
first with `./scripts/local.sh agentbox` — it is a slow build that installs
Node, Playwright and a shell environment.

## What is not here

The infrastructure stayed in Hill90 and is **not** reproduced: Ansible VPS
bootstrap, Traefik and its ACME configuration, the LGTM observability stack,
OpenBao/SOPS secrets tooling, Tailscale, the deploy scripts and per-service
deploy workflows, and `services/dns-manager` (which despite its path is
infrastructure — a DNS-01 ACME webhook that Traefik depends on).

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
scripts/            the two app database provisioners
tests/e2e/          Playwright suites
docs/               architecture, app runbooks, Mintlify site
docs/extraction/    provenance, verification output, Hill90 commit map
PRD.md / SPEC.md    why and how this extraction was done
```

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs unit tests only and
is gated to `workflow_dispatch` — it never fires on its own. It has not been run
since extraction and is not expected to pass without work.
