# Retiring app-keycloak

**Status:** done in production 2026-07-30 07:15–07:25 UTC. **Local still runs it.**
Authorised by Jon.

## What was actually removed, and what was not

**Removed:** the `app-keycloak` *container* on the VPS. `docker stop` then `docker rm`,
precise commands rather than `compose down`, so nothing else in the project was touched.

**Not removed, and this matters:**

- **Realm `hill90` still exists.** It lives in the `keycloak` database inside
  `app-postgres`, and removing the container did not delete a single row. Verified
  immediately after removal: realm `hill90`, 3 users, still there. The realm disappears
  when **`app-postgres`** goes — which is a separate retirement, and `app-postgres` is
  currently being **kept deliberately as the rollback target** for the platform-Postgres
  cutover (`scripts/deploy.sh:155`). Anyone reading "we retired the realm" should read
  this paragraph instead.

  **Correction, 2026-07-31.** `app-postgres` has since been retired, and the realm did
  NOT disappear with it — the prediction above was wrong in the direction that matters.
  Only the container was removed; the volume `prod_app-postgres-data` was deliberately
  kept and still holds the `keycloak` database, and the five databases were dumped to
  `/opt/hill90/backups/app-postgres-final/` with the restore proven (realm `hill90`,
  3 users, confirmed inside the restored copy). Realm `hill90` therefore still exists
  in two places. See [retiring-app-postgres.md](retiring-app-postgres.md).
- **No volume was destroyed, because there was none.** `app-keycloak` had only two
  read-only bind mounts — the realm JSON and the theme directory — both from the
  checkout. Its entire persistent state was in `app-postgres`.
- **`docker-compose.auth.yml` is kept.** See "Local still depends on this" below.
- **Nothing in Hill90 was touched.** The platform Keycloak, its `master` and `platform`
  realms, and all 13 platform containers are unchanged.

## The backup, taken before anything was removed

The order was forced: realm `hill90` lives in `app-postgres`, `app-postgres` is being
retired concurrently in another lane, so the export had to come first or the realm would
have become unrecoverable.

```
/opt/hill90/backups/app-realm-final/20260730_071522/hill90-realm.json   84970 bytes
/opt/hill90/backups/app-realm/20260730_071522_final/hill90-realm.json   (identical copy)
```

Both on the **host** filesystem, so they survive any container removal. `0600` in `0700`
directories, because the file contains password hashes and client secrets. Checksums
match. It was **not** copied off the box — it holds credential material.

Taken with a **sidecar** rather than in the live container: `kc.sh export` binds the
management interface on `:9000` and fails with `Address already in use` inside a running
Keycloak. The sidecar runs the same image against the same database with the server left
up — the pattern already proven in this estate for the earlier export.

```bash
docker run --rm --network hill90_internal \
  -e KC_DB=postgres -e KC_DB_URL="jdbc:postgresql://app-postgres:5432/keycloak" \
  -e KC_DB_USERNAME -e KC_DB_PASSWORD \
  -v "$DEST:/export" quay.io/keycloak/keycloak:26.4.0 \
  export --dir /export --realm hill90 --users realm_file
```

Credentials passed as `-e NAME` with no value, inheriting from the environment, so they
never appear in `argv`.

**The export was opened and read, not just produced.** An export nobody has opened is not
a backup:

```
parses as JSON      : yes
realm               : hill90 (enabled)
users               : 3 -> ['hill90admin', 'jon', 'testuser01']
users WITH creds    : 3 -> all three          <- makes it a RESTORE, not a re-creation
clients             : 9 -> account, account-console, admin-cli, broker, hill90-api,
                           hill90-ui, hill90-vault, realm-management,
                           security-admin-console
clients WITH secret : 3 -> hill90-api, hill90-ui, hill90-vault   (values not printed)
realm roles         : admin, default-roles-hill90, offline_access, uma_authorization, user
```

## Why removal was safe: the dependency check

Verified **before** removing, not asserted:

- **Every app service points at the platform Keycloak.** `app-ui`
  `AUTH_KEYCLOAK_ISSUER`, `app-api` and `app-mcp` `KEYCLOAK_ISSUER` all read
  `https://auth.hill90.com/realms/platform`.
- **No running container referenced `app-auth` or `app-keycloak`** except
  `app-keycloak` itself (its own `KC_HOSTNAME`).
- **In the deployed compose tree, every remaining mention was a comment** — with one
  exception, recorded below as a finding.

## Findings

**1. `.env.example` still pointed a fresh deployment at the retired Keycloak.**
`AUTH_KEYCLOAK_ISSUER=https://app-auth.hill90.com/realms/hill90`. Not consumed at
runtime, so it broke nothing — but anyone copying the example to stand up a new
deployment would have aimed it at a Keycloak that no longer exists, and the failure would
have read as a credentials problem. Corrected to
`https://auth.hill90.com/realms/platform`.

**2. Local still depends on app-keycloak, so this retirement is production-only.**
`deploy/compose/overrides/local.{auth,api,ui}.yml` all still resolve
`${APP_AUTH_HOST:-app-auth}.${BASE_DOMAIN}`. Local development runs the app's own
Keycloak and still needs it. That is why `docker-compose.auth.yml` and the local
overrides are kept and only the production path was closed. It also means the
"local parity before retirement" rule is satisfied in the direction that matters: local
retains a working identity provider; production is the side that no longer has a
fallback, which is the intended end state.

## What stops it coming back

`scripts/deploy.sh`:

- `auth` is **removed from `DEPLOY_REST`**, so `deploy all` cannot recreate it. That was
  the live risk: the stack was still in the deploy order after the container was gone.
- `deploy auth` now **refuses** with a message naming the retirement, this record, and
  the export location — rather than quietly rebuilding a retired container.
- The usage text and the per-stack summary say RETIRED.

## Reversing it

The realm is *not* gone, so reversal today is standing a Keycloak back up against
`app-postgres` — which still holds the rows. Once `app-postgres` is retired, reversal
means importing the export above into a fresh Keycloak. Either way `deploy auth` will
refuse until this record is read, which is deliberate.

## Verified after removal

`Verified 2026-07-30 07:22 UTC.` All 13 platform containers present **by name**
(`cadvisor grafana keycloak loki node-exporter openbao portainer postgres
postgres-exporter prometheus promtail tempo traefik`), 0 unhealthy. `hill90.com` 200.
Platform Keycloak untouched — `master` and `platform` realms intact, discovery 200.
Login still goes to the platform Keycloak: a proper Auth.js flow (GET csrf, POST signin)
redirects to
`https://auth.hill90.com/realms/platform/protocol/openid-connect/auth` with
`client_id=hill90-ui`, and that authorize endpoint answers 200.
`app-auth.hill90.com` now returns **404**, unrouted, as intended.
