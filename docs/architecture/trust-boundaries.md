# Trust Boundaries — Principal Identity Model

This document defines the identity authorities, principal types, and token exchange rules for Hill90.

## Principal Types

| Principal type | Identity authority | Auth method | Token format | Max privilege ceiling |
|---------------|-------------------|-------------|-------------|---------------------|
| **Human** | Keycloak | OIDC (RS256) | Keycloak access token | Keycloak realm roles |
| **Agent** | API service | Ed25519 JWT | `WorkloadClaims` | Owner's role ceiling ∩ assigned skill scopes |
| **Service** | Environment | HMAC token | Bearer shared secret | Endpoint-specific (hardcoded per internal route) |

## Authority Boundaries

- **Keycloak** is authoritative for human principals. All human identity flows (login, session, role assignment) go through Keycloak.
- **API service** is authoritative for agent principals. Agent JWTs are issued by the API service using Ed25519 signing keys. Keycloak has no representation of agents (Option C — see design decision below).
- **Service tokens** are environment-scoped shared secrets for internal service-to-service calls. They are not issued dynamically.

## Token Exchange Rules

**Hard prohibition**: No cross-authority token exchange.

- An agent token cannot be exchanged for a Keycloak (human) token.
- A human token cannot be exchanged for an Ed25519 (agent) token.
- A service token cannot be exchanged for either.

Agents act **as themselves**. The `owner` claim in agent JWTs is for audit attribution only — it does not grant the agent the owner's privileges. Agent privilege is derived from the intersection of the owner's current roles and the agent's assigned skill scopes, computed at token issuance time.

## Agent Token Contract (WorkloadClaims)

All agent tokens conform to the `WorkloadClaims` interface (defined in `services/api/src/types/workload-claims.ts`):

**Required claims:**

| Claim | Type | Description |
|-------|------|-------------|
| `sub` | string | Principal ID — agent UUID (V2) or slug (V1) |
| `principal_type` | `'agent'` | Formal principal type |
| `iss` | string | Always `hill90-api` |
| `aud` | string | Target audience (e.g., `hill90-akm`, `hill90-model-router`) |
| `exp` | number | Expiration (epoch seconds) |
| `iat` | number | Issued-at (epoch seconds) |
| `jti` | string | Unique token ID (revocation handle) |
| `owner` | string | Keycloak sub of owning human |
| `scopes` | string[] | Flat colon-namespaced scopes (e.g., `['akm:read', 'inference:chat']`) |

**Optional claims:**

| Claim | Type | Description |
|-------|------|-------------|
| `correlation_id` | string | Request-scoped tracing ID |
| `agent_slug` | string | Human-readable agent_id (V2 only, for log correlation) |

## RBAC Scope Boundaries

- Agent scopes = intersection of (owner's current Keycloak roles) ∩ (assigned skill scopes).
- Agent cannot escalate beyond owner's ceiling.
- If owner loses `admin` role, agent start with elevated skills is rejected (403).
- Elevated scope assignment (`host_docker`, `vps_system`) requires admin role.
- Scope is computed at token issuance (start time). Mid-flight changes require agent restart.

## `WORKLOAD_PRINCIPAL_V2` — not an active migration. Verified 2026-08-07.

This section previously described a "Migration Window (V1 → V2)" as if underway, with downstream services accepting both `sub` formats during a rolling deadline. **That was false, and worse than no claim at all: a reader concluded the boundary below held when it did not.** Corrected here rather than softened, per app#614.

**The flag is unset in the environment of all five production containers (`app-api`, `app-ai`, `app-knowledge`, `app-mcp`, `app-ui`) and unset in both `deploy/compose/prod/docker-compose.api.yml` and `compose/local.yml`.** It has never been turned on anywhere this app runs. There is no migration in progress, rolling or otherwise, and no deadline mechanism has ever fired — `WORKLOAD_PRINCIPAL_MIGRATION_DEADLINE` is dead configuration for a state that has never existed.

**Unset selects the pre-V2 branch, not the safer one.** `services/api/src/services/akm-token.ts:37,83` and `services/api/src/services/model-router-token.ts:37,90` both read `process.env.WORKLOAD_PRINCIPAL_V2 === 'true'` and use a ternary that defaults to `agentSlug` — the caller-chosen, hard-deletable, globally-reusable agent slug — whenever the flag is absent. `sub` in every agent JWT issued in production today is that slug, never the immutable, database-generated agent UUID `WORKLOAD_PRINCIPAL_V2=true` would select instead.

**This is a real, currently-unenforced trust boundary, not a wording problem to fix and move on from.** `services/knowledge` (AKM) trusts `sub` as a durable, private per-agent namespace — every memory, task and file is scoped by it — with no live check against `services/api`'s own agents table for current existence or ownership. Because agent slugs are caller-supplied and freely reusable after a hard delete, a new agent that happens to claim a previously-used slug inherits full read/write access to whatever the earlier agent stored under that name, regardless of who owns either agent. Traced in full, including a concrete scenario and a real-Postgres reproduction that fails today on purpose, in **app#614** — read that issue before changing this flag's default or writing code that assumes this boundary is enforced. `services/knowledge/tests/integration/test_slug_reuse_leaks_deleted_agent_memories.py` is the executable form of this section: it goes green only once one of app#614's fixes actually lands.

## Keycloak Strategy Decision

**Chosen: Option C — No Keycloak representation for agents.**

Agents remain API-issued Ed25519 principals. Keycloak is not the identity provider for agents.

Rationale:
- Hill90 has <100 agents; Keycloak service account overhead is not justified.
- Agent tokens are short-lived (1h), infrastructure-scoped, and revocable.
- Adding Keycloak service accounts creates a management surface with no current consumer.

Upgrade path: If OIDC federation is needed in the future, migrate to Option A (service account per agent) in a new work item.

## Threat Assumptions

- Ed25519 signing keys are stored in SOPS/Vault, not in application code.
- Agent tokens have 1-hour TTL to limit blast radius of key compromise.
- JTI-based revocation is DB-backed and survives service restart.
- Clock skew tolerance is 30 seconds.
- No token reuse across agent restarts (new JTI per start).
