# One Keycloak: Migration Runbook

**Status:** PREPARATION ONLY — nothing in this runbook has been executed
**Date:** 2026-07-29

Jon decided there should be **one Keycloak**. Today there are two: Hill90's
platform Keycloak at `auth.hill90.com` (realm `platform`) and the app's at
`app-auth.hill90.com` (realm `hill90`).

`<VPS_HOST>` below is the VPS's Tailscale address, or your `~/.ssh/config` alias
for it. It is in SOPS at `infra/secrets/prod.enc.env`, key `TAILSCALE_IP`.

---

## Read this before you touch anything

### `app-keycloak` holds the only copy of realm `hill90`

Realm `hill90`, its 16 clients, and **both user accounts (`jon`, `hill90admin`)
exist only inside `prod_app-postgres-data`**. There is no export, no backup, and no
second copy. Deleting `app-keycloak` or that volume destroys them.

The yank-out test on 2026-07-29 proved the volume survives a full teardown and
redeploy — `deploy.sh teardown` keeps volumes, and both users came back with
identical row counts (`user_entity=3`, `realm=2`, `client=16`). **That is survival
across teardown, not a backup.** Take an export before any migration step (§1).

### Changing `AUTH_KEYCLOAK_ISSUER` is NOT how you repoint the app

This is the single most likely way to waste a maintenance window.

`AUTH_KEYCLOAK_ISSUER` **was** in the SOPS store and nothing read it. The compose
files recompose the issuer from parts:

```
AUTH_KEYCLOAK_ISSUER=https://${APP_AUTH_HOST:-app-auth}.${BASE_DOMAIN:-hill90.com}/realms/${KC_REALM:-hill90}
```

All three parts carry `:-` defaults, so `require_compose_interpolation` cannot warn
about them. Editing the issuer in SOPS produced **no effect and no warning**, and
the deploy went green against the old issuer.

**The knobs are `APP_AUTH_HOST` and `KC_REALM`.** PR #22 removes the inert
`AUTH_KEYCLOAK_ISSUER` and `AUTH_URL` entries from the store so the trap cannot
fire, and adds a check that fails when any store key is read by nothing. If #22 is
not yet merged when you run this, **do not edit `AUTH_KEYCLOAK_ISSUER`** — it will
silently do nothing.

Three services derive the issuer, and all three must agree:

| Service | Reads |
|---|---|
| `ui` | `AUTH_KEYCLOAK_ISSUER` (browser-facing) + `KEYCLOAK_INTERNAL_ISSUER` (back-channel) |
| `api` | `KEYCLOAK_ISSUER` + `KEYCLOAK_JWKS_URI` |
| `mcp` | `KEYCLOAK_ISSUER` + `KEYCLOAK_JWKS_URI` |

### The realm choice is OPEN and is Jon's

Two options, and this runbook works either way:

- **A — new realm on the platform Keycloak.** Recreate clients and users there.
- **B — reuse the existing `platform` realm.** Add the app's clients to it.

**Two arguments, and they point in opposite directions. Jon should weigh both.**

**FOR a new realm named `hill90`** (the reviewer's argument): it keeps
`KC_REALM=hill90`, which **removes `KC_REALM` from the change set entirely** — the
migration becomes a single-variable change to `APP_AUTH_HOST`, and every step
below gets shorter and more reversible. It also avoids importing into the existing
`platform` realm, which would risk overwriting that realm's own `hill90-vault`
client — the one OpenBao SSO depends on.

**AGAINST naming it `hill90`:**

`services/api/src/app.ts:105` and `services/mcp/app/main.py:17` hardcode a
fallback:

```
https://auth.hill90.com/realms/hill90
```

Today that realm **404s** (verified: `platform` → 200, `hill90` → 404), so a blank
`KEYCLOAK_ISSUER` fails loudly and immediately. **If the new realm is named
`hill90` on `auth.hill90.com`, that fallback becomes correct** — and from then on a
blank or misconfigured issuer is indistinguishable from correct configuration,
permanently. Naming the target realm anything else keeps the loud failure.

### `APP_AUTH_HOST` used to move `app-keycloak` itself — the worst hazard

**Fixed by PR #25 before this runbook was revised. If #25 is not merged, do not
proceed at all.**

`docker-compose.auth.yml` built `app-keycloak`'s **own** Traefik router rule and
`KC_HOSTNAME` from `APP_AUTH_HOST`. Flipping it to `auth` would have given
`app-keycloak` the rule ``Host(`auth.hill90.com`)`` — identical rule, identical
entrypoint, same Traefik, both Keycloaks on `hill90_edge`. Traefik picks between
them non-deterministically, and `app-keycloak` has **no `platform` realm**, so
**Grafana, Portainer and OpenBao SSO break** with nothing deployed to them.

It was **latent**: Traefik labels bake at container creation, so it would not fail
at migration time. It would fail on some later unrelated `deploy.sh auth`, long
after step 4 said verified — the rollback target taking out the platform.

Both uses are now pinned to the literal `app-auth`, so `APP_AUTH_HOST` cannot move
the container you depend on as your rollback.

### `APP_AUTH_HOST` alone used to move only the FRONT channel

**Fixed by PR #26.** `KEYCLOAK_JWKS_URI` was hardcoded to `app-keycloak` in `api`
and `mcp`, so flipping `APP_AUTH_HOST` left the back channel asking the old
Keycloak for a realm it does not have — **every authenticated API and MCP call
401s** while the login page looks fine. And reverting `APP_AUTH_HOST` alone would
restore the login page while leaving authenticated calls broken: **a revert that
looks like it worked.**

Both overrides are deleted, so both channels derive from `KEYCLOAK_ISSUER` and
`APP_AUTH_HOST` is one knob. If #26 is not merged, step 4 is not single-revert
reversible.

### Token validation now depends on the edge — a deliberate tradeoff

**PR #26 changed the network path of token validation.** It is worth understanding
before the migration, not during an outage.

```
before  KEYCLOAK_JWKS_URI=http://app-keycloak:8080/realms/hill90/...
        internal, direct, plain HTTP, inside the Docker network

after   derived from KEYCLOAK_ISSUER = https://app-auth.hill90.com/realms/hill90/...
        public, out through Traefik and back, TLS
```

**Why it was done.** OIDC expects the JWKS to correspond to the issuer. Two
independently-settable values for one relationship is a latent inconsistency, and it
is the specific inconsistency that made step 4 non-reversible in a single revert:
flipping `APP_AUTH_HOST` moved only the front channel, and reverting it restored the
login page while leaving every authenticated call 401ing.

**What it costs.** **The edge is now a dependency of authentication.** Token
validation requires Traefik to be up, public DNS to resolve, and the certificate to
be valid. Before, it required none of those. If Traefik is down, token validation now
fails where it previously kept working — so an edge problem becomes an auth problem.

Verified before merging: from inside both running containers the public path resolves
and returns the same key set as the internal one (2 keys, `app-api` and `app-mcp`).
So it is safe today, but it is a real coupling and not a cleanup.

**Operational consequence for this runbook:** if step 4's verification fails with
401s, check Traefik and the certificate for `app-auth.<domain>` *before* suspecting
the realm or the mapper.

Locally the split is retained on purpose — app containers cannot resolve the
browser-facing Traefik hostname, which is why `local.api.yml` carries a
`DIVERGENCE-INTENTIONAL` marker. `tests/scripts/issuer-jwks-agree-check.sh` enforces
that production cannot diverge while a marked local override may.

### The roles claim will break silently — see §7

This is the failure this runbook exists to prevent. Read §7 before §4.

---

## 1. Export the app realm — and accept the downtime

**The two export paths disagree, and you must pick one deliberately.**

| Path | Users | Client secrets | Live instance? |
|---|---|---|---|
| REST partial-export | **never** — structurally excluded | no | yes, safe |
| `kc.sh export` | yes | yes | **upstream says stop the server first** |

So *"export while `app-keycloak` keeps running"* and *"the export is a real backup"*
**cannot both be true.** A REST partial-export can never return password hashes, so
it is not a backup of the accounts.

**This runbook takes the `kc.sh export` path and accepts a brief outage.** Say so
out loud before you start: logins via the app's Keycloak stop for the duration.

```bash
# 1a. stop accepting logins, then export
ssh deploy@<VPS_HOST> '
  docker stop app-keycloak
  docker run --rm     -v prod_app-postgres-data:/dev/null:ro     --network hill90_internal     --entrypoint /opt/keycloak/bin/kc.sh     -e KC_DB=postgres     -e KC_DB_URL=jdbc:postgresql://app-postgres:5432/keycloak     -e KC_DB_USERNAME="$DB_USER" -e KC_DB_PASSWORD="$DB_PASSWORD"     -v /tmp/realm-export:/export     quay.io/keycloak/keycloak:26.4.0     export --dir /export --realm hill90 --users realm_file
  docker start app-keycloak
'
```

**The volume snapshot is the backup that does not depend on any of this**, and it
is the one to trust:

```bash
ssh deploy@<VPS_HOST> '
  docker stop app-postgres
  docker run --rm -v prod_app-postgres-data:/v -v /tmp:/out alpine:3     tar -czf /out/app-postgres-data-$(date +%Y%m%d-%H%M).tgz -C /v .
  docker start app-postgres
  ls -la /tmp/app-postgres-data-*.tgz
'
```

Stopping `app-postgres` also stops `api`, `ai`, `knowledge` and `litellm` from
serving. **That is the downtime. Plan it.** A snapshot of a running Postgres volume
is not crash-consistent, which is why this stops it rather than pretending.

**Verify:** the archive is non-empty and the realm JSON names both users.

```bash
ssh deploy@<VPS_HOST> 'ls -la /tmp/realm-export/'
ssh deploy@<VPS_HOST> 'grep -oE "\"username\" *: *\"[^\"]+\"" /tmp/realm-export/hill90-realm.json | sort -u'
```

Expect `jon` and `hill90admin`.

**Rollback:** nothing has changed except two restarts. If the export is empty or
missing a user, **stop** — every later step assumes a good one.

## 2. Create a test user, and never use `jon` for testing

`jon` is a real account. Token tests lock accounts, consume OTP counters, and
create audit noise. Use `testuser01` throughout.

```bash
ssh deploy@<VPS_HOST> '
  docker exec app-keycloak /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 --realm master \
    --user "$KC_ADMIN_USERNAME" --password "$KC_ADMIN_PASSWORD"
  docker exec app-keycloak /opt/keycloak/bin/kcadm.sh create users -r hill90 \
    -s username=testuser01 -s enabled=true -s email=testuser01@hill90.com
  docker exec app-keycloak /opt/keycloak/bin/kcadm.sh set-password -r hill90 \
    --username testuser01 --new-password "<CHOOSE_ONE>"
  docker exec app-keycloak /opt/keycloak/bin/kcadm.sh add-roles -r hill90 \
    --uusername testuser01 --rolename user
'
```

**Verify:** `testuser01` appears and holds the `user` role.

```bash
ssh deploy@<VPS_HOST> 'docker exec app-postgres psql -U hill90 -d keycloak -tAc \
  "SELECT u.username FROM user_entity u JOIN realm r ON u.realm_id=r.id WHERE r.name='"'"'hill90'"'"'"'
```

**Rollback:** delete the user. Nothing else is affected.

```bash
ssh deploy@<VPS_HOST> 'docker exec app-keycloak /opt/keycloak/bin/kcadm.sh delete \
  users/$(docker exec app-keycloak /opt/keycloak/bin/kcadm.sh get users -r hill90 \
  -q username=testuser01 --fields id --format csv --noquotes) -r hill90'
```

---

## 3. Capture the baseline you will compare against

Run this **before** any change and keep the output.

```bash
ssh deploy@<VPS_HOST> '
  echo "--- containers"; docker ps --format "{{.Names}}\t{{.Status}}" | sort
  echo "--- hill90 infra count"; docker ps --format "{{.Names}}" | grep -vc "^app-"
  echo "--- realms/users"; docker exec app-postgres psql -U hill90 -d keycloak -tAc \
    "SELECT r.name,u.username FROM user_entity u JOIN realm r ON u.realm_id=r.id ORDER BY 1,2"
  echo "--- clients"; docker exec app-postgres psql -U hill90 -d keycloak -tAc \
    "SELECT count(*) FROM client"
'
```

Then capture a **real token** and its claims (see §6 for why the claim matters):

```bash
bash docs/runbooks/scripts/token-claims.sh testuser01 '<PASSWORD>'
```

**Verify:** Hill90 infra is exactly **13**. If it is not, stop and fix that first.

**Rollback:** n/a — read-only.

---

## 4. Repoint the app (the actual migration)

Only `APP_AUTH_HOST` and `KC_REALM` move the app. Set them in the SOPS store:

```bash
SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt \
  sops infra/secrets/prod.enc.env
#   APP_AUTH_HOST=auth          <- the platform Keycloak's host
#   KC_REALM=<TARGET_REALM>     <- see the naming argument above
```

Then deploy the consumers **one at a time**, through the pipeline only:

```bash
for s in api mcp ui; do
  gh workflow run "Manual Deploy App (Prod)" --repo jonhill90/hill90-app \
    --ref main -f service=$s -f dry_run=false
done
```

**Verify — and this is the important part.** Three things can each make this step
false-pass:

1. **A discovery document or healthcheck.** Both stay 200 while roles are empty.
2. **Your own browser session.** The Auth.js session cookie is signed with
   `AUTH_SECRET`, which nothing in this migration changes — so an
   already-logged-in browser **keeps working across the switch**. Verification must
   be a **fresh private window**, logging in from scratch.
3. **A cached JWKS.** `services/api/src/middleware/auth.ts:52` sets
   `cacheMaxAge: 3600000` — a **one-hour** stale window. The API can keep
   validating against the old Keycloak's keys for up to an hour after the switch,
   so a pass inside that window proves nothing. Either wait it out or restart
   `api`.

So: fresh private window, log in, **and** exercise an authenticated API call,
asserting a non-empty `realm_roles` claim (§7):

```bash
bash docs/runbooks/scripts/token-claims.sh testuser01 '<PASSWORD>'
```

Expect a non-empty roles array **from the claim the app actually reads**.

**Rollback — and read the condition, because it is what a review rejected:**

Set `APP_AUTH_HOST` and `KC_REALM` back and redeploy the same three stacks. The
app's Keycloak is still running and still holds the realm, so this is a
configuration rollback, not a restore.

**This is single-revert reversible ONLY IF both #25 and #26 are merged.**

- Without **#26**, reverting `APP_AUTH_HOST` restores the login page and leaves
  every authenticated call 401ing, because the back channel is pinned separately. A
  review returned a verdict of **NO** on reversibility for exactly this reason.
- Without **#25**, `app-keycloak` — your rollback target — has itself moved onto
  Hill90's hostname, so reverting restores the app and leaves the platform's SSO
  broken.
- If you imported `hill90-realm.json` rather than the §1 export, add
  `AUTH_KEYCLOAK_SECRET` to the revert set (§5).

Confirm all three conditions before starting, not during the rollback.

---

## 5. Importing the realm MINTS NEW CLIENT SECRETS

`platform/auth/keycloak/hill90-realm.json` declares all three clients
`publicClient: false` with **no `secret` field**:

```
hill90-ui        publicClient=False  hasSecret=False
hill90-api       publicClient=False  hasSecret=False
hill90-vault     publicClient=False  hasSecret=False
```

A confidential client with no secret in the import artifact gets a **freshly minted
secret**. `AUTH_KEYCLOAK_SECRET` in SOPS then stops matching, and the UI fails at
token exchange with `invalid_client` — after the login form has already rendered,
so it looks like a credential problem rather than an import problem.

**Only a `kc.sh export` artifact carries `clients[].secret`.** So:

- If you import **`hill90-realm.json`** (the committed file): secrets are new. You
  must read each one back from the new Keycloak and write it into SOPS, then
  redeploy `ui`. **That adds a step to the revert count**: rolling back now means
  reverting `APP_AUTH_HOST`, `KC_REALM`, *and* `AUTH_KEYCLOAK_SECRET`.
- If you import the **§1 `kc.sh export`**: secrets come across intact and
  `AUTH_KEYCLOAK_SECRET` keeps matching. **This is the reason §1 takes the
  `kc.sh export` path.**

**State which artifact you are importing before you start.** The two have different
revert counts.

## 6. Do not delete anything — and what "delete" would mean

`app-keycloak`, `app-postgres` and every `prod_app-*` volume stay.

When removal is eventually considered, it is safe **only as a container removal**.
Say it in these words: **remove the container, keep the database.**

The realm lives in the `keycloak` database inside `prod_app-postgres-data`, and that
volume is **shared**:

```
hill90  hill90_akm  hill90_api  hill90_litellm  keycloak  postgres
```

So AKM, the API and LiteLLM all live in the same volume. `deploy.sh teardown auth`
removes only the container and keeps the volume — that is the safe operation.
**`docker compose down -v` on that stack, or `docker volume rm
prod_app-postgres-data`, is the irreversible act**, and it destroys the app's
knowledge base and chat history along with the realm.

## 7. The roles claim — the failure that passes every other check

**Every consumer reads a NON-STANDARD claim:**

| File | Reads |
|---|---|
| `services/ui/src/auth.ts:116` | `decoded.realm_roles` |
| `services/api/src/middleware/role.ts:11` | `user.realm_roles` |

That claim exists **only** because of a per-client protocol mapper in the app's
realm. It is not a Keycloak default.

**Hill90's own helper defaults to the other name.** `scripts/keycloak.sh:154`:

```bash
ensure_realm_roles_mapper() {
    local uuid="$1" claim="${2:-realm_access.roles}"
```

`realm_access.roles` is also the Keycloak console default. Hill90's own comment at
`keycloak.sh:156-158` describes this hazard already:

> Match on the mapper's CLAIM, not just its name. A mapper called "realm-roles"
> pointing at the wrong claim is worse than a missing one: the client looks
> configured, tokens look populated, and the consumer's claim binding silently
> never matches.

**What happens if the app's clients are recreated with the default mapper:**

- tokens verify — signature is valid
- `iss` matches — the issuer is correct
- `requireAuth` passes — there is a valid subject
- **roles arrive as an empty array**
- the admin nav silently does not render
- every `requireRole` route returns **403**
- **every healthcheck stays green**

So the mapper must emit the claim named `realm_roles`, or every consumer must be
changed to read `realm_access.roles`. Pick one deliberately; do not discover it.

### Assert on the claim, not on discovery

```bash
# docs/runbooks/scripts/token-claims.sh
# Fetch a real token for testuser01 and print the claims that matter.
```

The script decodes the access token and prints both `realm_roles` and
`realm_access.roles`, so you can see which one is populated. A discovery document
being 200 tells you nothing about either.

---

## 8. Inventory: every hardcoded realm name and issuer host

Hand this list to whoever does the migration. **"Env change"** means it follows
`APP_AUTH_HOST`/`KC_REALM` and needs no code edit. **"Code change"** means a literal
that must be edited, or consciously accepted.

### hill90-app — runtime code

| File:line | What reads it | Migration action |
|---|---|---|
| `services/api/src/app.ts:105` | fallback issuer when `KEYCLOAK_ISSUER` unset | **Code change if the target realm is named `hill90`.** Today `auth.hill90.com/realms/hill90` 404s, so a blank issuer fails loudly. Name the realm `hill90` there and this fallback silently becomes *correct* — a blank issuer then looks like working config forever |
| `services/api/src/index.ts:72` | same fallback, WebSocket terminal proxy path | Same. **Not previously reported** — a second copy of the same literal |
| `services/api/src/routes/profile.ts:28` | same fallback, profile route | Same. **Third copy** |
| `services/mcp/app/main.py:17` | fallback issuer for MCP | Same |
| `services/ui/src/utils/admin-services.ts:24,29,30` | admin UI service list — hardcodes `url: 'https://auth.hill90.com'`, `internalUrl: 'http://keycloak:8080'` and `path: '/realms/hill90'` | **Code change, and it is already wrong today.** None of it is env-driven, and `internalUrl` names **`keycloak`** — Hill90's container — not `app-keycloak`. So the admin page's Keycloak health check already probes the platform's Keycloak, not the app's. **Not previously reported** |
| `services/ui/src/app/api/services/health/route.ts:6` | health panel probes `/realms/hill90/.well-known/openid-configuration` against `KEYCLOAK_INTERNAL_URL` | **Code change if the realm is renamed.** Host is env-driven; the realm path is a literal, so a renamed realm makes the health panel report Keycloak down while it is fine |
| `services/ui/src/auth.ts:116` | `decoded.realm_roles` | **Mapper decision, not a host/realm one** — see §7 |
| `services/api/src/middleware/role.ts:11` | `user.realm_roles` | Same |
| `services/api/src/middleware/auth.ts:52` | `cacheMaxAge: 3600000` | No change, but it is the **one-hour stale JWKS window** that can make step 4 false-pass |

### hill90-app — compose and config

| File:line | What reads it | Migration action |
|---|---|---|
| `deploy/compose/prod/docker-compose.api.yml` | `KEYCLOAK_ISSUER` from `${APP_AUTH_HOST}`/`${KC_REALM}` | **Env change** |
| `deploy/compose/prod/docker-compose.mcp.yml` | same | **Env change** |
| `deploy/compose/prod/docker-compose.ui.yml` | `AUTH_KEYCLOAK_ISSUER` from the same parts | **Env change** |
| `deploy/compose/prod/docker-compose.auth.yml:32,68` | `KC_HOSTNAME` + router rule, **pinned to literal `app-auth`** by #25 | **No change, and must stay pinned.** This is the rollback target |
| `deploy/compose/prod/.env.example:45` | `AUTH_KEYCLOAK_ISSUER=…` | **Stale — remove.** #22 removed it from the store; the example still carries it |
| `deploy/compose/overrides/local.api.yml:20,21` | local issuer + marked internal JWKS | Local only. **No migration action** |
| `deploy/compose/overrides/local.ui.yml:20,23` | local issuer + `KEYCLOAK_INTERNAL_ISSUER` | Local only |
| `platform/auth/keycloak/setup-realm.sh:31` | `KC_BASE_URL` defaults to `https://auth.hill90.com` | **Env change** — override `KC_BASE_URL`, or it targets the platform Keycloak by accident |
| `platform/auth/keycloak/hill90-realm.json` | the import artifact; 3 clients, **no secrets** | See §5 — minting |

### Hill90 (platform repo) — do not edit without the infra lane

| File:line | What reads it | Migration action |
|---|---|---|
| `scripts/vault.sh:394` | OpenBao OIDC discovery, `https://auth.hill90.com/realms/platform` | **Leave alone.** This is platform SSO. If the app's clients are added to the `platform` realm, confirm this still resolves and that the `hill90-vault` client was not overwritten |
| `scripts/keycloak.sh:154` | `claim="${2:-realm_access.roles}"` | **Decision, not an edit** — see §7 |
| `scripts/local.sh:307,310` | relaxes `sslRequired` on the `platform` realm locally | Local only |

### Not code, but worth checking

- **Test fixtures** in `services/{api,mcp,ai}` hardcode
  `https://auth.hill90.com/realms/hill90` as `TEST_ISSUER`. They are self-consistent
  literals fed to a mocked verifier — **no change needed**, and rewriting them would
  be churn with fixture-breaking risk.
- `services/api/src/services/keycloak-account.ts` mentions the issuer **in comments
  only**.

### The count that matters

**Three** separate copies of the `auth.hill90.com/realms/hill90` fallback in `api`
alone (`app.ts:105`, `index.ts:72`, `profile.ts:28`), plus one in `mcp`. If the realm
is named `hill90`, all four become silently correct at once. That is the strongest
form of the argument against that name.

## 9. What this runbook does not cover

- **Which realm to use.** Open, and Jon's call. §Read-this lists both arguments.
- **Deleting the app's Keycloak.** Deliberately excluded; see §6.
- **Migrating password hashes.** A realm export with `--users realm_file` includes
  credentials, but whether they import cleanly across Keycloak versions is
  unverified here.
- **`hill90admin` vs the platform realm's own admin.** Two accounts named for the
  same purpose may collide; not investigated.
- **The `auth.hill90.com` hostname collision.** Hill90's Keycloak owns that host
  and router today. Pointing the app at it is a configuration change, not a routing
  change — but if the app's `auth` stack is ever redeployed while `APP_AUTH_HOST=auth`,
  two containers would claim the same Traefik router name. Not exercised.
