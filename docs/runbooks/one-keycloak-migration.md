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

**One input for that decision that argues against naming the new realm `hill90`:**

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

### The roles claim will break silently — see §6

This is the failure this runbook exists to prevent. Read §6 before §4.

---

## 1. Export the app realm before anything else

```bash
ssh deploy@<VPS_HOST> '
  docker exec app-keycloak /opt/keycloak/bin/kc.sh export \
    --dir /tmp/realm-export --realm hill90 --users realm_file
  docker exec app-keycloak ls -la /tmp/realm-export
'
mkdir -p ~/hill90-realm-backup
ssh deploy@<VPS_HOST> 'docker exec app-keycloak tar -cC /tmp/realm-export .' \
  > ~/hill90-realm-backup/realm-hill90-$(date +%Y%m%d-%H%M).tar
```

Also snapshot the database volume, which is the authoritative copy:

```bash
ssh deploy@<VPS_HOST> '
  docker run --rm -v prod_app-postgres-data:/v -v /tmp:/out alpine:3 \
    tar -czf /out/app-postgres-data-$(date +%Y%m%d-%H%M).tgz -C /v .
  ls -la /tmp/app-postgres-data-*.tgz
'
```

**Verify:** the tar is non-empty, and `hill90-realm.json` inside it contains both
usernames.

```bash
tar -tvf ~/hill90-realm-backup/realm-hill90-*.tar
tar -xOf ~/hill90-realm-backup/realm-hill90-*.tar ./hill90-realm.json \
  | grep -oE '"username" *: *"[^"]+"' | sort -u
```

Expect `jon` and `hill90admin`.

**Rollback:** nothing has changed. If the export is empty or missing a user, **stop
here** — every later step assumes a good export.

---

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

**Verify — and this is the important part:** do **not** accept a discovery document
or a healthcheck as proof. Both pass while roles are empty. Assert on the claim in
a real token (§6):

```bash
bash docs/runbooks/scripts/token-claims.sh testuser01 '<PASSWORD>'
```

Expect a non-empty roles array **from the claim the app actually reads**.

**Rollback:** set `APP_AUTH_HOST` and `KC_REALM` back, redeploy the same three
stacks. The app's Keycloak is still running and still holds the realm, so this is a
configuration rollback, not a restore.

---

## 5. Do not delete anything until §4 has been verified for a full day

`app-keycloak`, `app-postgres` and every `prod_app-*` volume stay. Removal is a
separate, later decision and needs its own runbook.

When that day comes, `deploy.sh teardown auth prod` keeps the volume. Only
`docker volume rm prod_app-postgres-data` is irreversible, and it destroys the only
copy of both user accounts.

---

## 6. The roles claim — the failure that passes every other check

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

## 7. What this runbook does not cover

- **Which realm to use.** Open, and Jon's call. §Read-this lists the argument
  against naming it `hill90`.
- **Deleting the app's Keycloak.** Deliberately excluded; see §5.
- **Migrating password hashes.** A realm export with `--users realm_file` includes
  credentials, but whether they import cleanly across Keycloak versions is
  unverified here.
- **`hill90admin` vs the platform realm's own admin.** Two accounts named for the
  same purpose may collide; not investigated.
- **The `auth.hill90.com` hostname collision.** Hill90's Keycloak owns that host
  and router today. Pointing the app at it is a configuration change, not a routing
  change — but if the app's `auth` stack is ever redeployed while `APP_AUTH_HOST=auth`,
  two containers would claim the same Traefik router name. Not exercised.
