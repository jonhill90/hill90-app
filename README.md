# hill90-app

**Shelved — not verified runnable since June 2026.** Nothing in this repository
has been started, built, or health-checked since the Hill90 VPS was rebuilt.
Assume it is broken until proven otherwise; `RESURRECTION.md` lists what is
known to be broken and where.

This is the AI agent application extracted from
[jonhill90/Hill90](https://github.com/jonhill90/Hill90), carrying its own git
history — 542 commits reaching back to 2026-01-11. It was separated from that
repo so the application could be preserved and resumed independently, without
dragging the VPS infrastructure along. See
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

## What is not here

The infrastructure stayed in Hill90 and is **not** reproduced: Ansible VPS
bootstrap, Traefik and its ACME configuration, the LGTM observability stack,
OpenBao/SOPS secrets tooling, Tailscale, the deploy scripts and per-service
deploy workflows, and `services/dns-manager` (which despite its path is
infrastructure — a DNS-01 ACME webhook that Traefik depends on).

This means there is no deployment path in this repo. `deploy/compose/prod/*.yml`
describes how the services *were* wired, and is preserved as a specification
rather than as something you can run.

## If you are resuming this

Read [`RESURRECTION.md`](RESURRECTION.md) first. It is the whole point of
extracting rather than deleting.

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
