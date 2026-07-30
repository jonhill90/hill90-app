# One Keycloak, One Realm — Configuration Plan

**Status:** PLAN. Nothing here has been executed and nothing may be, without Jon's
approval. Read-only evidence gathering only.
**Date:** 2026-07-29
**Filename kept deliberately.** `scripts/_common.sh` and `scripts/deploy.sh` point a
runtime error message at this path. The name says "migration"; the content no longer
does.

---

## This is not a migration. It is a first configuration.

The previous version of this document was a migration runbook, with export, import
and rollback machinery. **That framing was wrong and is removed.**

`hill90-app` reached the VPS for the first time on 2026-07-28. Realm `hill90` contains
exactly two accounts, created hours ago with temporary passwords, and **login has
never worked** — so they have never been used. There is no accumulated state, no user
history, no data anyone would miss.

**So: configure it correctly, once.** Create the clients where they belong, point the
app at them, delete what is redundant. Do not build a process around moving things.

**Also removed:** the claim that "one Keycloak does not mean one realm". That was
argued at length in earlier revisions and it is wrong. Jon's analogy is Entra: you do
not create a second tenant for one organisation. One directory; infra-versus-app is a
matter of **role and client assignment inside `platform`**.

### The governing principle

> **The platform provides identity, data and storage. Tenants consume them.**

Every decision below follows from that sentence. Where a choice was previously made
by asking "what does the app need to own", it is re-made by asking "what does the
platform already provide, and how does the app consume it".

### The safety net, mentioned once

A verified realm export sits at
`/opt/hill90/backups/app-realm/20260729_084747/hill90-realm.json` and a restored-clean
cluster dump at `/opt/hill90/backups/app-db/20260729_065944/`. They exist so that a
mistake is recoverable. **No step below depends on them.** That is the whole of their
role in this plan.

---

## A. Which clients the app actually needs in `platform`

**Answer: one, plus one inert audience target. Not three.**

Determined from code, not from what happens to exist in realm `hill90`.

| Client | Needed? | Evidence |
|---|---|---|
| `hill90-ui` | **Yes — confidential** | `services/ui/src/auth.ts:30` is the only place in the repository that supplies a `client_secret`. It performs the authorization-code exchange and the refresh (`auth.ts:31`). |
| `hill90-api` | **As a bearer-only audience target only** | The api never acts as an OIDC client. `services/api/src/middleware/auth.ts:10-44` only *verifies* a token, and `createJwksKeyResolver` (`:48`) fetches public keys. A repository-wide search for `grant_type`, `client_credentials` and `token_endpoint` finds **one** hit — the ui's refresh. This is why `API_KEYCLOAK_SECRET` was absent from the store: not an omission, there is nothing to put there. |
| `hill90-vault` | **No. It already exists and is the platform's.** | See §B. The copy in realm `hill90` is vestigial and must not be recreated. |
| `mcp` | **No client** | `services/mcp/app/middleware/auth.py:28` decodes and verifies only. |

**Why `hill90-api` exists at all if it never authenticates:** to be a name in the
`aud` claim, so that §E's audience check has something to assert. A bearer-only client
has **no secret**, so it cannot drift the way `hill90-ui`'s did.

The alternative is an audience mapper using `included.custom.audience` with a free
string and no client object. That is fewer objects, but it hides the contract inside a
mapper's configuration. In a **shared** realm that others read, an explicit
bearer-only client is self-documenting. Recommended, but it is a genuine toss-up.

---

## B. What already exists in `platform`, and must not be clobbered

Enumerated from the platform Keycloak's own database, read-only.

### Clients

```
account                 public
account-console         public
admin-cli               public
broker                  bearer-only
grafana                 confidential, HAS SECRET      <- do not touch
hill90-vault            confidential, HAS SECRET      <- do not touch
portainer               confidential, HAS SECRET      <- do not touch
realm-management        bearer-only
security-admin-console  public
```

**Three clients hold live secrets: `grafana`, `portainer`, `hill90-vault`.** Any
realm-level import, or any "recreate the realm from a file" step, risks replacing
them. **There is no step in this plan that imports a realm.** Clients are created
individually, by name.

### Realm roles — and a collision that must be decided before anything is created

```
admin                    <- ALREADY EXISTS
user                     <- ALREADY EXISTS
editor
viewer
default-roles-platform
offline_access
uma_authorization
```

`admin` and `user` are exactly the two role names the app uses. **They already exist,
and they already mean something else:**

```
Grafana    docker-compose.observability.yml:122
           contains(realm_access.roles[*],'admin') && 'Admin' || … 'editor' … 'Viewer'
OpenBao    scripts/vault.sh:420
           "bound_claims": {"realm_roles": ["admin"]}
```

**So granting a user the realm role `admin` today grants Grafana Admin and OpenBao
access.** If the app reuses that role, an app administrator silently becomes a
platform administrator. This is the sharpest consequence of one realm and it is not
addressed anywhere yet. It is resolved by §F.

### Protocol mappers on platform clients

```
grafana         realm-roles  ->  realm_access.roles     (standard)
portainer       realm-roles  ->  realm_access.roles     (standard)
hill90-vault    realm-roles  ->  realm_roles            (NON-standard)
account-console audience resolve
security-admin-console  locale
```

The realm's stock `roles` client scope already emits **both**
`realm_access.roles` and `resource_access.${client_id}.roles` to every client, with no
configuration. That fact does most of the work in §F.

### Users, groups, identity providers

```
users  0        groups  0        identityProviders  0
```

**The platform realm has no users at all.** The app's two accounts will be the first.
Worth noting rather than acting on: Grafana, Portainer and OpenBao OIDC have never had
an account to log in with either, so their SSO paths are as unproven as the app's was.

---

## C. Every consumer of the issuer or realm name

`KC_REALM` for the app becomes `platform`.

### hill90-app

| File:line | Reads | Change |
|---|---|---|
| `deploy/compose/prod/docker-compose.ui.yml:34` | `KC_REALM=${KC_REALM:-hill90}` | default → `platform` |
| `deploy/compose/prod/docker-compose.ui.yml:42` | `AUTH_KEYCLOAK_ISSUER=…/realms/${KC_REALM:-hill90}` | default → `platform`, host → `APP_AUTH_HOST` retired (§C note) |
| `deploy/compose/prod/docker-compose.api.yml:104` | `KEYCLOAK_ISSUER=…/realms/${KC_REALM:-hill90}` | same |
| `deploy/compose/prod/docker-compose.mcp.yml:30` | `KEYCLOAK_ISSUER=…/realms/${KC_REALM:-hill90}` | same |
| `deploy/compose/overrides/local.mcp.yml:25` | same, local | same |
| `services/ui/src/app/api/services/health/route.ts:9` | `process.env.KC_REALM \|\| 'hill90'` | fallback → `platform` |
| `services/api/src/middleware/keycloak-config.ts:15` | `FALLBACK_ISSUER = …/realms/hill90` | see §D |
| `services/mcp/app/main.py:17` | issuer fallback `…/realms/hill90` | see §D |
| `services/ui/src/utils/admin-services.ts:24,29,30` | `https://auth.hill90.com`, `keycloak:8080`, `/realms/hill90` | `/realms/platform`. Already broken today — probes `/realms/hill90` on the platform Keycloak and 404s |
| `deploy/compose/prod/.env.example:45` | stale `AUTH_KEYCLOAK_ISSUER` | delete |

Also: the app stops needing `app-auth.hill90.com` at all. The issuer becomes
`https://auth.hill90.com/realms/platform`. `APP_AUTH_HOST`, and the whole
`docker-compose.auth.yml` stack, are retired — see §H.

### Hill90 (do not edit without the infra lane)

| File:line | Reads |
|---|---|
| `scripts/keycloak.sh:26` | `KC_REALM="${KC_REALM:-platform}"` |
| `deploy/compose/prod/docker-compose.observability.yml:117-119` | `…/realms/${KC_REALM:-platform}` ×3 |
| `scripts/vault.sh:394` | `oidc_discovery_url=…/realms/platform` |
| `platform/vault/secrets-schema.yaml:50` | `KC_REALM` is a declared store key |

### The `KC_REALM` trap, and how to handle it

**The same variable name means different things in one estate:** Hill90 defaults it to
`platform`, the app defaults it to `hill90`. Both are on the same host, and
`KC_REALM` is a declared key in Hill90's secrets schema — so a shell that exports it
for one repository's tooling silently reconfigures the other.

**Handle it by making them agree, not by renaming.** Once the app's realm *is*
`platform`, one variable with one meaning and one default is correct, and the trap
disappears rather than being papered over. Renaming the app's copy to `APP_KC_REALM`
would preserve the ambiguity in a new form — two names for one concept — which is
worse.

**Verification that they agree:** a check in the spirit of the existing gates,
asserting that no compose file in this repository defaults `KC_REALM` to anything but
`platform`. Cheap, and it fails the day someone reintroduces the split.

---

## D. The hardcoded fallbacks

`services/api/src/middleware/keycloak-config.ts:15` and
`services/mcp/app/main.py:17` fall back to `https://auth.hill90.com/realms/hill90`.
After this work that realm **does not exist**.

**Recommendation: delete the fallbacks. Do not repoint them.**

- A fallback that points at a non-existent realm fails at the first request, per
  request, as a 401 — which looks like a token problem, not a configuration problem.
- A fallback repointed at `…/realms/platform` is worse: it becomes **silently
  correct**, so a service with no `KEYCLOAK_ISSUER` at all appears to work. That is
  the hazard recorded at length in earlier revisions, and pointing the fallback at the
  real realm is the one change that makes it certain rather than possible.
- With no fallback, `getIssuer()` should throw at startup. The container then fails
  its healthcheck and the deploy fails, which is the loud, early failure this estate
  keeps discovering it needs.

`KEYCLOAK_ISSUER` is set by every compose file that runs these services, so nothing
depends on the fallback today.

---

## E. Audience validation — a real defect, in scope

Neither resource server validates `aud`:

```
services/api/src/middleware/auth.ts:31   jwt.verify(token, key, { algorithms:['RS256'], issuer })
                                          ^ no `audience` option
services/mcp/app/middleware/auth.py:33   options={"verify_aud": False, "require_exp": True}
```

In separate realms this was merely sloppy. **In one realm it is a privilege boundary
failure:** the api and mcp would accept any token the `platform` realm signs — a
Grafana token, a Portainer token, an OpenBao token — because all of them carry the
right issuer and a valid signature.

**Fix, in three parts:**

1. Add an **audience mapper** to `hill90-ui` (`oidc-audience-mapper`) that includes
   `hill90-api` in `aud`.
2. `services/api`: pass `audience: 'hill90-api'` to `jwt.verify`.
3. `services/mcp`: remove `verify_aud: False` and pass `audience="hill90-api"` to
   `jose_jwt.decode`.

**Verify by trying to break it, not by trying to use it.** A token minted for
`grafana` must be rejected by the api with 401. That is the assertion worth writing —
"a valid app token still works" would pass with the fix absent.

**Order matters:** the mapper must exist before the services start requiring the
claim, or every request 401s. Mapper first, then deploy the services.

---

## F. The roles claim — and the role-name collision, resolved together

Every consumer reads a non-standard `realm_roles` claim. Thirteen runtime files:

```
services/api/src/middleware/role.ts:11          services/api/src/routes/tools.ts:21
services/api/src/helpers/scope.ts:10            services/api/src/routes/usage.ts:22
services/api/src/helpers/elevated-scope.ts:17   services/api/src/routes/user-models.ts:17
services/api/src/routes/agents.ts:1173,1673,1851
services/api/src/routes/model-policies.ts:22    services/api/src/routes/provider-connections.ts:20
services/ui/src/auth.ts:116
services/api/src/index.ts:88   (already reads realm_access.roles as a fallback)
```

Three options. The recommendation is the third, and it is not the one earlier
revisions of this document proposed.

**Option 1 — recreate the non-standard `realm_roles` mapper on `hill90-ui`.**
Zero app code change, and there is precedent: `hill90-vault` in this very realm uses
exactly that claim. **But** it leaves the §B collision intact — the app would read
realm roles named `admin` and `user`, the same objects Grafana and OpenBao read.

**Option 2 — read the standard `realm_access.roles`.** No mapper needed at all; the
stock `roles` scope emits it. But the collision remains: still realm roles, still
shared with Grafana and OpenBao.

**Option 3, RECOMMENDED — use client roles on `hill90-ui`, read
`resource_access.hill90-ui.roles`.**

- The stock `roles` client scope **already emits `resource_access.${client_id}.roles`**
  to every client. So, like option 2, **there is no custom mapper to create — and
  therefore no mapper to forget.** The failure mode where authorisation silently
  empties cannot occur, because nothing bespoke has to be right.
- It **resolves the collision by construction.** `admin` on `hill90-ui` is a different
  object from realm role `admin`. Granting someone app admin cannot grant Grafana
  Admin or OpenBao access, and no naming convention has to be remembered.
- It is the textbook Keycloak answer to "several applications, one realm", which is
  precisely the shape being adopted.

Cost: the same thirteen files change as option 2, plus creating two client roles
instead of reusing two realm roles. Both are mechanical, and CI now runs the api and
ui suites on every pull request.

**Whichever is chosen, assert on a real token.** The check is that a token for
`testuser01` carries the expected roles in the expected path — not that a mapper
exists in a config listing.

---

## G. The two accounts

`jon` and `hill90admin` are **recreated** in `platform`, not moved. They were created
hours ago with temporary passwords and have never been used, so there is nothing to
preserve.

- The realm rejects incomplete profiles: each needs `firstName`, `lastName`, `email`.
- Set `emailVerified` so the browser flow does not interrupt.
- Assign whatever §F decides — client roles on `hill90-ui` if option 3.
- `testuser01` already exists in realm `hill90` with a non-temporary password in
  `infra/secrets/test-accounts.enc.env`; recreate it in `platform` the same way, since
  it is the account the acceptance test uses.
- **Jon sets his own password.** Do not generate one for his account.

---

## H. What gets deleted, once the app works against `platform`

Redundant, not migrated:

- **`app-keycloak`** — the container, its `docker-compose.auth.yml` stack, and
  `platform/auth/keycloak/hill90-realm.json`.
- **`app-auth.hill90.com`** — DNS record, Traefik router, certificate.
- **`AUTH_KEYCLOAK_SECRET`'s sibling variables** that only the auth stack read:
  `KC_ADMIN_USERNAME`, `KC_ADMIN_PASSWORD`, `APP_AUTH_HOST`.
- **`hill90-vault` in realm `hill90`** — vestigial; the platform's copy is the live
  one.
- The `prod_app-postgres-data` volume and `prod_app-keycloak-*` volumes, **after**
  §I.

**Nothing is deleted until the replacement is verified working.** Deletion is the last
phase, not an early one.

---

## I. Postgres — and the assertion that must be planned around

Jon has decided `app-postgres` goes too. **This does not mirror the Keycloak steps,
because Hill90's Postgres actively refuses to own application databases.**

The assertion, found in code:

```
platform/data/postgres/init.sh        creates ONLY `keycloak`, and says so:
  "It creates only databases that platform services own. The previous version of
   this file also created hill90_api, hill90_akm and hill90_litellm — application
   databases — which is a large part of why Postgres looked like an application
   dependency and was deleted in #495."

tests/scripts/platform-services.bats:35
  asserts hill90_api / hill90_akm / hill90_litellm are ABSENT from init.sh
```

**So the app's databases cannot be added to Hill90's init script — a Hill90 test
forbids it, deliberately, and that test is right.** The platform provides the
*server*; the tenant creates its *own* databases inside it.

What the app needs to create, currently in `app-postgres`:

```
hill90_api        32 tables
hill90_akm        14 tables      requires uuid-ossp and vector
hill90_litellm    55 tables
hill90             0 tables      role default, nothing in it
```

**Good news, verified:** the platform Postgres is already `pgvector/pgvector:pg16`,
the same image, and `vector` is available in it. No image change, and the `knowledge`
service's requirements are already met.

Plan shape:

1. The app's `db` stack stops running a Postgres and becomes a **bootstrap** step: it
   connects to the platform Postgres and creates its three databases and extensions if
   absent. Idempotent, and owned by the app.
2. It needs credentials with `CREATEDB` on the platform server. That is a platform
   grant and a Hill90-side decision — **the one thing here that is not the app's to
   settle.**
3. Every app service's `*_DATABASE_URL` / `DB_HOST` repoints from `app-postgres` to
   `postgres`.
4. Schema is created by the services' existing migrations. **No data is copied** —
   there is none worth keeping.
5. `app-postgres` and its volume are deleted last.

**Do not reuse the `hill90` database name.** Both servers already have an empty
`hill90` database; adding app tables to it would collide with the platform's own
role-default database.

---

## J. MinIO — options, no recommendation

**The state is the reverse of everything else, and it has never been addressed.**
There is **no platform MinIO**. Only `app-minio` exists, defined in
`deploy/compose/prod/docker-compose.minio.yml` and consumed by
`docker-compose.api.yml`. No Hill90 compose file mentions MinIO at all.

So this is not "move the tenant's copy up into the platform" — it is "decide whether
object storage becomes a platform primitive".

**Option 1 — MinIO becomes a platform primitive.** Consistent with the governing
principle: storage is named in it explicitly, alongside identity and data. The app
consumes a bucket and credentials. Cost: a Hill90-side change, a new platform service
to own, and the app's only current use is user avatars.

**Option 2 — MinIO stays with the app.** Honest about the fact that exactly one tenant
uses it, for one feature. Cost: the principle says "the platform provides storage" and
this leaves it not doing so, which is the kind of drift that made Postgres and
Keycloak look like application dependencies in the first place.

**Option 3 — defer.** Leave `app-minio` where it is, and revisit when a second
consumer appears. Cheapest now; the risk is that "revisit later" is how the previous
shape happened.

**This is Jon's to decide.** It is stated here so it stops being invisible, and it
does not block anything else in this plan.

---

## K. Ordered plan, with what to verify at each step

Nothing here runs without approval. Steps are ordered so that each is verifiable
before the next, and so that nothing is deleted before its replacement works.

| # | Step | Verify |
|---|---|---|
| 1 | **Decide §F** (client roles vs realm roles) and **§J** | Written down. Everything after 3 depends on §F |
| 2 | Repair `hill90-ui`'s secret mismatch **or** skip it — if the app is moving to `platform`, the broken client in realm `hill90` is being deleted anyway | If skipped, say so explicitly, because the guard will refuse a `ui` deploy until the store matches whichever client it points at |
| 3 | Create `hill90-ui` (confidential) and `hill90-api` (bearer-only) in `platform`, individually, by name | `kcadm get clients -r platform` shows 11, and `grafana`/`portainer`/`hill90-vault` secrets are **unchanged** — compare hashes before and after |
| 4 | Set `hill90-ui`'s secret from SOPS, and add the audience mapper (§E) | `require_client_secret_matches` prints `CLIENT_SECRET_AGREES` |
| 5 | Create the roles chosen in §F and the three accounts (§G) | Roles resolve on each account; no realm role was created or altered if option 3 |
| 6 | Repoint the app: `KC_REALM=platform`, issuer host `auth.hill90.com`, delete the fallbacks (§D), audience checks (§E), roles claim (§F) | `docker compose config` resolves; unit tests green |
| 7 | Deploy `ui`, `api`, `mcp` | Browser-login `testuser01` reaches a signed-in page. **A token minted for `grafana` is rejected by the api with 401** |
| 8 | Postgres bootstrap and repoint (§I) | Three databases exist with extensions; services migrate and pass their own healthchecks |
| 9 | Delete `app-keycloak`, `app-postgres`, the auth stack, `app-auth` DNS/router/cert, and the vestigial vault client (§H) | Hill90's container count is unchanged; nothing in the platform realm changed except the app's own objects |

**The verification that matters most is step 7's second assertion.** Everything else
confirms something was created. That one confirms a boundary exists.

---

## L. Open questions that are Jon's, not mine

1. **§F** — client roles (recommended) or shared realm roles. Decides whether app
   admin implies Grafana Admin.
2. **§J** — whether MinIO becomes a platform primitive.
3. **§I step 2** — what credentials the platform grants the tenant on Postgres.
4. Whether to repair `hill90-ui`'s secret in realm `hill90` at all, given the realm is
   being retired.
5. Repo visibility, and when the docs site publishes — noted only because they were
   raised; nothing here depends on them.
