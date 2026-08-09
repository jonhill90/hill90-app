# hill90-app — Spec

**Status:** Living document — describes the system as built and verified, dated per claim. Not a design proposal.
**Date:** 2026-08-07
**Companion:** [PRD.md](PRD.md) — what the product is and who uses it

## Why every claim here is dated and cited

This repository and the platform it runs on have a recurring, documented failure mode: a written claim outlives the state it described, and gets reasoned over as if still true. Three concrete instances, found within days of each other, motivate the discipline this document tries to hold to — the third is inside this very repository, found while writing this document:

1. **A seeded database row was treated as a real example of what a route produces, and wasn't.** `agents-create-matches-seed.test.ts` (app#607, 2026-08-06) ran `POST /agents` for real against a throwaway Postgres and found the route's actual default `tools_config` does not match the `platform-guide` row's shape — that row had been inserted by hand, mirroring the route's SQL by inspection, and the mirroring was wrong.
2. **An alert allowlist entry asserted a metric was absent when it was, by then, present.** (Hill90#841/#855 area — the check script itself was extended to detect exactly this: a selector declared "legitimately absent" that later comes back with real series is now a hard failure, not a silent pass, because nothing had been re-checking the claim as time moved past it.)
3. **This repository's own README contradicts its own CLAUDE.md, both currently checked in.** `README.md`'s opening line states *"All eight stacks are deployed and healthy."* `CLAUDE.md` line 385 states, dated `Verified 2026-08-04`: *"Stacks: `api ai knowledge mcp ui` — five, not six."* Both files are in this repository, at HEAD, as this document is written. This SPEC does not resolve which is right (see §4) — it names the contradiction so a reader of this document does not inherit either claim uncritically.

Every load-bearing claim below is tagged with how it was established: **(test)** — an automated test, cited by file; **(live)** — a check run against a real system (production or a throwaway instance) on the date given; **(code)** — read directly from source, not run; **(doc, dated)** — taken from another document's own dated claim, not independently re-verified here.

## 0. Ground truth

**The governing architectural fact (code + deployment configuration, re-checked 2026-08-08): the app is a tenant, not a platform.** Production deployment configuration does not run its own identity provider, database, or object store. For object storage specifically, the API compose file supplies `MINIO_ENDPOINT` (default `http://minio:9000`) and injects `MINIO_TENANT_ACCESS_KEY` / `MINIO_TENANT_SECRET_KEY`; `scripts/deploy.sh` refuses the retired `minio` stack. Those are **code/configuration facts**, not proof of a live storage operation. The exact production credential identity and scope — `tenant-hill90-app` — are instead a **doc, dated 2026-07-31** operational claim in [HANDOFF-2026-07-31.md](../decisions/HANDOFF-2026-07-31.md); this document does not infer them from variable names or compose comments. Local development deliberately still runs `app-minio`.

**Retired, do not resurrect (doc, dated 2026-07-31, CLAUDE.md):** `app-postgres` (container removed, volume `prod_app-postgres-data` deliberately kept as a safety net) and the app's own Keycloak realm `hill90` at `app-auth.hill90.com` (now 404s).

**Deployable stacks (doc, dated 2026-08-04, CLAUDE.md, contradicting README's own opening line — see §4): `api`, `ai`, `knowledge`, `mcp`, `ui`. Five, not the "eight" the README currently states.** `db`, `auth` and `minio` targets exist in `scripts/deploy.sh` but are refused — they are retired stacks, not deployable ones.

**Container state, live, 2026-08-07:** seven `app-*` containers running and healthy on the production host — `app-api`, `app-ai`, `app-litellm`, `app-ui`, `app-knowledge`, `app-mcp`, `app-docker-proxy`. No `app-postgres`, no `app-minio` — consistent with the retirement above.

**Data state, live, 2026-08-07:**
- `agents` table (database `hill90_api`): **2 rows** — `platform-guide` (`status='stopped'`) and `chat-path-proof-502` (`status='stopped'`, created for a separate live investigation into the chat path, app#502).
- `chat_threads` table: **0 rows.** No human-initiated chat conversation has ever completed, or even been created, in production. This is a live re-confirmation of the same read the 2026-08-06 test files (§2) cite from the day before.

**Deployment discipline (code, `scripts/deploy.sh`, `CONTRIBUTING.md`): pipeline-only.** Deploys run over SSH from a GitHub Actions runner joined to the tailnet, dispatched via `gh workflow run "Manual Deploy App (Prod)"`. There is no deploy path from a workstation, and a merge to `main` does not itself deploy.

## 1. Services

| Service | Stack | Boundary | Deployed? |
|---|---|---|---|
| `services/api` | Express / TypeScript | Control plane: agent lifecycle, Ed25519 JWT issuance for agents, provider connections, model policies, chat orchestration, usage. 65 migrations. Owns the `hill90_api` database. **Public**, on `edge` + `internal` + `agent_internal` + `agent_sandbox` + `docker_proxy`. | Yes |
| `services/ai` | FastAPI / Python 3.12 | Model router: policy-gated LLM inference, BYOK, delegated scopes, fronts LiteLLM. **Internal-only** (`traefik.enable=false`, code: `deploy/compose/prod/docker-compose.ai.yml`). | Yes |
| `services/knowledge` | FastAPI / Python 3.12 | Agent Knowledge Manager (AKM): persistent agent memory, full-text search, journaling, context assembly. 12 migrations. **Internal-only.** | Yes |
| `services/agentbox` | Starlette / uvicorn | Sandboxed agent runtime. Non-root `agentuser`, resource limits, network isolation. **Sole assembler of an agent's system prompt** (PRD §"What is actually built", claim 4). Runs as short-lived per-agent containers on `agent_sandbox` / `agent_internal`, not as one of the seven long-running `app-*` containers listed in §0. | Yes, per-agent |
| `services/mcp` | Python 3.12 | Model Context Protocol gateway, Keycloak JWT authenticated. | Yes |
| `services/ui` | Next.js | Frontend. Auth.js v5 sessions against Keycloak; server-side proxy routes forward to `services/api` with the session's bearer token (e.g. `services/ui/src/app/api/admin/users/route.ts` → `services/api`'s `/admin/users`). | Yes |
| `services/cli` | — | Terminal client. | **No deploy wiring** (code, README) — not part of the running product |
| `services/discord-bot` | — | Multi-channel chat bridge. | **No deploy wiring** — not part of the running product |

**Network topology (code, `deploy/compose/prod/docker-compose.api.yml`):** three networks are consumed as `external: true` from Hill90's platform — `hill90_edge`, `hill90_internal`, `hill90_agent_internal` — and two are created by this app itself — `hill90_agent_sandbox` (internal, bridge) and `hill90_docker_proxy` (internal, bridge). `services/api`'s own compose file creates the two app-owned networks, which is why `api` must deploy before `ai` and `knowledge` in `scripts/deploy.sh`'s `DEPLOY_ORDER`.

## 2. Contracts between services — what is proven, and how

**Human → API, via Keycloak (code: `docs/architecture/trust-boundaries.md`, current as far as re-checked below).** Authorization is by Keycloak **client role** on `hill90-ui` (`admin`/`user`), not realm role — the platform realm's own `admin`/`user` realm roles mean something else entirely (Grafana Admin, OpenBao) and must not be conflated with this app's roles. `middleware/role.ts`'s `ROLE_IMPLIES` map encodes `admin ⊃ user` as a one-level, test-pinned hierarchy (`role-hierarchy.test.ts`) — not a general RBAC graph.

**API user-token verification limitation (code, `services/api/src/middleware/auth.ts`, re-checked 2026-08-08):** `jwt.verify` is passed the configured issuer and `RS256` algorithm constraint, but no `audience` option. Therefore the current API user-token verification does not apply an audience constraint. This is a statement of present behavior only; this document does not decide whether it should change.

**Agent → internal services, via API-issued Ed25519 JWT, never Keycloak (code: `trust-boundaries.md`, `workload-claims.ts`).** Agents have no Keycloak representation by deliberate decision ("Option C" in that document) — the API service is the sole identity authority for agent principals, issuing short-lived (1-hour TTL), revocable, `WorkloadClaims`-shaped tokens whose scope is the intersection of the owning human's current Keycloak roles and the agent's assigned skill scopes, computed once at issuance. **Re-verified 2026-08-07 (live/code): the `WORKLOAD_PRINCIPAL_V2` migration this document describes is still gated behind an environment flag that is unset — and therefore `false` — in both `deploy/compose/prod/docker-compose.api.yml` and `compose/local.yml`.** The "migration window" trust-boundaries.md describes is not underway anywhere this app actually runs; V1 (slug-based `sub`) is the only behavior in effect today.

**The chat callback boundary (test, `chat-callback-contract.test.ts`, app#608, 2026-08-06).** `POST /internal/chat/callback` is proven against a real Postgres: correct-token happy path persists a message and advances the SSE cursor; a second callback for an already-terminal message is a no-op (the guarded `UPDATE` only matches `pending`/`thinking`); and all four ways an attacker-controlled token can be wrong are individually proven rejected with `401` and a verified-untouched row — absent header, same-length-wrong token, different-length-wrong token, malformed `Bearer` prefix. A fifth case, no token configured server-side at all, is `503`, not `401`.

**What that test explicitly does NOT prove, stated in its own header comment and repeated here so it isn't quietly assumed elsewhere:** what agentbox does *before* calling back — reading `SOUL.md`/`RULES.md`, assembling the real prompt, actually running the model. That is `services/agentbox`'s own Python code and its own test surface, a different service and a different language.

**Agent creation, `POST /agents` (test, `agents-create-matches-seed.test.ts`, app#607, 2026-08-06).** Proven end to end against a real Postgres, including the JSONB round-tripping and `COALESCE` fallback for `model_policy_id` that a mocked pool cannot exercise. Identity/time columns (`id`, `created_at`, `updated_at`, `created_by`) are deliberately not compared to the historical seed, since they must differ by construction.

**First-message chat create, `POST /chat/threads` (test, `chat-first-message-reachable.test.ts`, 2026-08-06).** Reachable against a real Postgres, with one stated scaffold: the dispatchable-agent precondition (`status='running'` + `work_token`) is set directly via SQL rather than by driving the full container-start path, because that path is different, already-proven-elsewhere machinery, not the thing under test here.

## 3. What is proven vs. what is assumed — the honest inventory

| Claim | Status | Evidence |
|---|---|---|
| `POST /agents` produces a valid row | **Proven** | test, app#607 |
| `platform-guide`'s row matches what the route actually produces | **False — proven false** | same test; `tools_config` and `container_profile_id` diverge |
| `POST /chat/threads` is reachable | **Proven** | test, 2026-08-06 |
| The chat callback boundary rejects a bad/missing token correctly, in all four attacker-reachable shapes | **Proven** | test, app#608 |
| Agentbox degrades loudly (not silently) on missing identity files | **Proven** | code + commit, app#609 |
| A full agent lifecycle — human signs in, creates agent, agent replies via chat — has completed end to end | **Not proven. Not claimed.** | `chat_threads` = 0, live, 2026-08-07 |
| A human has ever signed in to production | **Asserted, dated, not re-verified here** | CLAUDE.md, 2026-07-31 |
| `WORKLOAD_PRINCIPAL_V2` migration is underway | **False as of this document** | flag unset in both compose files, checked 2026-08-07 |
| Production object storage is configured for platform MinIO | **Code/configuration, not live-verified here** | API compose defaults `MINIO_ENDPOINT` to `http://minio:9000` and injects `MINIO_TENANT_*`; `scripts/deploy.sh` refuses retired `minio`. The exact `tenant-hill90-app` identity/scope is a separate dated handoff claim. |
| Eight stacks are deployed | **Contradicted within this repo** | README says eight; CLAUDE.md says five, dated 2026-08-04 |
| Invitation email works | **Unverified — real, open dependency** | app#500 design note: realm SMTP password is blank in the checked-in export |

## 4. Known documentation drift

This section exists because Hill90#797 and this document's own opening argument require it: naming drift, rather than quietly fixing it, is what keeps a document honest about its own history.

1. **`platform-guide`'s seeded row vs. what `POST /agents` actually writes.** Corrected by app#607 (§2, §3). The row remains in production (`agents` table) as a real, if imperfect, example agent — its divergence from the route's real defaults is now a documented, tested fact rather than a silent assumption.
2. **`README.md`'s "All eight stacks are deployed and healthy" vs. `CLAUDE.md`'s "five, not six," dated 2026-08-04.** Both are currently checked into this repository. This document does not resolve which is current — that is `README.md`'s own maintenance debt, out of scope for a PRD/SPEC pair — but names it so a reader of *this* document does not carry either number forward as settled.
3. **`README.md`'s "Production" and "Consolidation" sections are dated 2026-07-29 and describe a topology since superseded** — the app's own Keycloak realm and Postgres, both retired 2026-07-30/31 per `CLAUDE.md`. `README.md` still frames Postgres consolidation as "decided, not yet done" and describes sign-in as unproven; both are stale. This document relies on `CLAUDE.md`'s later, corrected record in §0 rather than on `README.md`'s dated sections.
4. **`docs/architecture/overview.md`, inside this repository, opens with "This document describes the high-level architecture of the Hill90 VPS platform"** and describes a single, undivided platform with no tenancy boundary at all — no `agent_sandbox`/`docker_proxy` networks, no distinction between what Hill90 owns and what this app owns. It predates the tenancy cutover (2026-07-29 onward) entirely and describes Hill90's own architecture, not this app's. **Treat it as historical, not current** — §0/§1 of this document are the corrected, dated replacement for the tenancy-relevant parts of its content.
5. **`CLAUDE.md` itself asserts README's production table is actively maintained, and it is not.** `CLAUDE.md`'s own "Where to look" section describes README's status table as "the single home for facts with a shelf life" — language implying it is kept current — while, per item 3 above, that table is dated 2026-07-29 and describes a topology retired the following day. The claim that a document is being kept current is itself a claim with a shelf life, and this one has expired without anything saying so until this document.

## 5. Open questions, not resolved by this document

- Whether Keycloak's realm SMTP configuration can actually deliver an execute-actions email — structurally configured, password blank in the checked-in export, never confirmed to send (app#500).
- Whether local development should move from its deliberate `app-minio` to platform MinIO. Production consolidation is settled; this is only a local-parity decision ([local-parity-with-platform-services.md](../decisions/local-parity-with-platform-services.md)).
- Which of README's stack-count claims is current, and whether README should be corrected or whether CLAUDE.md's dated table should be treated as the sole source of truth for that fact going forward.
- Whether the `WORKLOAD_PRINCIPAL_V2` migration is still intended, abandoned, or simply not yet scheduled — the flag exists in code, is documented as an active migration in `trust-boundaries.md`, and is enabled nowhere.
