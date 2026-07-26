# hill90-app — Product Requirements

**Status:** planned, not executed. This document and `SPEC.md` are written into an
empty directory; no extraction has run yet.

**Source of record:** `github.com/jonhill90/Hill90` at `f03f12d` (858 commits,
2026-07-26). Note: the lane brief cited `1b9394c` as the tip. `main` advanced to
`f03f12d` (#493) during planning; that commit touches only
`infra/secrets/prod.enc.env`, so it is invisible to this extraction. The real
extraction SHA must be captured at run time, not copied from here.

## What this repo is

A preserved, standalone copy of the Hill90 AI agent application, carrying its own
git history, currently **shelved**.

Hill90 grew into a combined repository — infrastructure automation (Ansible
bootstrap, Traefik, SOPS/OpenBao secrets, Tailscale, LGTM observability) sitting
alongside an application stack under `services/`. In June 2026 the prod VPS was
destroyed and rebuilt on AlmaLinux 10 as a deliberate scope reduction; only the
infra and observability stacks were redeployed. The application has not run
since. `docs/decisions/infra-app-separation.md` in Hill90 records the decision to
separate the two, dated 2026-07-11, with status "decided, not implemented."

This repo implements the application half of that decision.

### What the application is

Per `docs/architecture/agent-harness.md` in the source repo, the app is four
cooperating services plus a UI:

| Service | Stack | Role |
|---|---|---|
| `services/api` | Express / TypeScript | Control plane — agent lifecycle, Ed25519 JWT signing, provider connections, model policies, chat, usage |
| `services/ai` | FastAPI / Python | Model router — policy-gated LLM inference for agents, BYOK, delegated scopes, fronts LiteLLM; `traefik.enable=false` |
| `services/knowledge` | FastAPI / Python | Agent Knowledge Manager — persistent memory with full-text search, journaling, context assembly; internal-only |
| `services/agentbox` | Starlette / uvicorn | Sandboxed agent runtime — non-root, resource-limited, network-isolated, policy-gated shell and filesystem functions |
| `services/mcp` | Python | Model Context Protocol gateway, Keycloak JWT authenticated |
| `services/ui` | Next.js | Frontend, Auth.js v5 sessions against Keycloak |
| `services/cli` | — | Terminal client (`815e41a`); no deploy wiring |
| `services/discord-bot` | — | Multi-channel chat bridge (`5943259`); no deploy wiring |

Schema lives entirely inside the services: 65 migrations in
`services/api/src/db/migrations/` and 12 in `services/knowledge/app/db/migrations/`.
There are no `.sql` files anywhere else in the source repo.

## Who it is for

Jon, cold, some months or years from now, deciding whether to resume this. There
is no second audience. Every requirement below follows from that: the repo is
optimized for **resumability**, not for running today.

## Goals

1. **Lossless preservation of the application tree.** Every app file that exists
   in Hill90 at the extraction SHA exists here, byte-identical, provable by
   content-addressed git object hashes rather than by inspection.
2. **Real git history, not a snapshot.** The development record — the model
   router, the agentbox runtime, the knowledge base, the chat system — is the
   substantive value being preserved. ~542 of 858 commits carry over, traversing
   the `src/services/` → `services/` rename intact.
3. **Coherent standalone.** The repo explains itself without Hill90 present: what
   it is, where it came from, what each service does, and how the pieces relate.
4. **Honest about its own state.** The repo states plainly that it has not been
   verified runnable since June 2026, and records exactly what is known broken.
5. **Zero risk to Hill90.** The source repository is read-only to this lane, in
   every branch of the procedure, including failure and rollback.

## Non-goals

- **Running it.** No attempt to boot the stack, provision databases, or prove a
  health check. The app is shelved; making it run is unbounded work on code with
  no current consumer.
- **Fixing it.** Known breakage is *documented*, not repaired.
- **Deploying it.** No VPS, no Traefik routing, no secrets provisioning. The
  deploy tooling (`scripts/deploy.sh`, the workflows, SOPS/OpenBao) stays in
  Hill90 and is not reproduced here.
- **Redesigning the app/infra boundary.** The boundary is settled by the
  `refactor/strip-app` lane's inventory. This lane consumes it.
- **Deleting anything from Hill90.** Not this lane's job, and gated on this
  lane's verification besides.
- **Carrying every branch.** `main` only.

## End state: shelved, with a resurrection checklist

The repo ships as an archive, not a working project:

- `README.md` states in its first paragraph: *shelved — not verified runnable
  since June 2026.*
- `RESURRECTION.md` lists every known-broken thing, each with its file path and
  what would have to change. This is the deliberate middle path: no time spent
  fixing, but the diagnostic knowledge gathered during extraction is written down
  while it is cheap rather than rediscovered later at high cost. Seed contents:
  - `deploy/compose/dev/docker-compose.yml:55` builds
    `context: ../../../services/auth` — a directory deleted long ago. The dev
    compose cannot build as written.
  - The Keycloak realm (`platform/auth/keycloak/hill90-realm.json`) hardcodes
    `hill90.com` hostnames, the `hill90-ui` / `hill90-api` clients, and a
    redirect to `https://hill90.com/api/auth/callback/keycloak`. Any new host
    needs the realm re-pointed.
  - Database provisioning is split across `platform/data/postgres/init.sh`
    (creates `keycloak`, `hill90_api`, `hill90_akm`, `hill90_litellm`) and
    `scripts/provision-{akm,litellm}-db.sh`. Migrations are applied by the
    services themselves.
  - Secrets came from OpenBao with a SOPS fallback, neither of which comes with
    the app. `deploy/compose/prod/.env.example` is the only remaining
    description of the required variables, and it still carries infra keys.
  - `services/cli` and `services/discord-bot` have no deploy wiring at all.
- CI exists but is gated to `workflow_dispatch` — present and one click away,
  never firing unbidden on an archived repo.

## What "successfully extracted" means

Not "it looks right." Eight gates, defined in `SPEC.md` §6, all passing, with
actual command output pasted into `docs/extraction/VERIFICATION.md`:

| Gate | Proves |
|---|---|
| V1 | Tree/blob hash equality against the source for every extracted path |
| V2 | File manifest is exactly the 669 expected files, no more, no fewer |
| V3 | Commit count reconciles with the source's per-path history |
| V4 | `git log --follow` traverses the `src/services/` rename — history is continuous, not truncated at 2026 |
| V5 | Zero excluded paths survive anywhere in history |
| V6 | No secrets anywhere in the rewritten history |
| V7 | Object-count/size sanity |
| V8 | All of the above recorded in-repo, reproducible by a cold reader |

## Ordering constraint

This extraction must be complete and verified **before** `refactor/strip-app`
deletes anything from Hill90. Deleting first risks a gap that nothing would
detect. The strip lane's plan already encodes this as a gate; `SPEC.md` §7
defines the handshake and what gets relayed.

## Open questions

1. **`deploy/compose/prod/.env.example` is mixed** (~60% app / 40% infra). It is
   extracted whole to preserve history, then pruned in a follow-up commit so the
   pruning itself is reviewable. Which keys are app-only should be confirmed
   against the strip lane's inventory.
2. **Keycloak's second consumer.** `scripts/vault.sh cmd_setup_oidc` configures
   OpenBao UI SSO against the `hill90-vault` client in this realm. Extracting the
   realm here is safe; Hill90 *deleting* it is not, until vault OIDC is re-pointed
   or downgraded to token auth. Flagged to the strip lane; not this lane's call.
3. **Postgres / MinIO / Keycloak / OpenBao** — the four ambiguous components. See
   `SPEC.md` §3 for the evidence and how each is handled. If the strip lane's
   inventory resolves any of them differently, only the addendum section of the
   manifest changes.
