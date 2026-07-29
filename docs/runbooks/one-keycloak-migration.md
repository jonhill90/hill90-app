# One Keycloak: Migration Runbook

**Status:** STEP 1 IS DONE. Steps 2 onwards are unexecuted.
**Date:** 2026-07-29

**Step 1 — the realm export — was performed on 2026-07-29 at 08:48 UTC.** It was
chosen as the one executable step because it only *adds* an artifact: it stops
nothing, changes nothing and deletes nothing. The artifact is on the VPS at

```
/opt/hill90/backups/app-realm/20260729_084747/hill90-realm.json
  -rw------- deploy:deploy  83970 bytes   (directory and parent both 700 deploy:deploy)
```

**Jon can start at step 2.** What was verified in it is in §1.

Jon decided there should be **one Keycloak**. Today there are two: Hill90's
platform Keycloak at `auth.hill90.com` (realm `platform`) and the app's at
`app-auth.hill90.com` (realm `hill90`).

`<VPS_HOST>` below is the VPS's Tailscale address, or your `~/.ssh/config` alias
for it. It is in SOPS at `infra/secrets/prod.enc.env`, key `TAILSCALE_IP`.

---

## Pre-migration checklist — every line must be true before you start

Each item has the command that proves it. Do not accept a remembered answer for any
of them; the point of the command is that it is cheap to re-run on the box at 6am.

**Read the second table first. Several prerequisites are MERGED BUT NOT DEPLOYED,
which means the code in the checkout is not the code that is running.**

| # | Must be true | Prove it |
|---|---|---|
| 1 | The backup exists | `ssh <VPS_HOST> 'ls -la /opt/hill90/backups/app-db/'` — newest directory holds `app-database.sql` and `app-postgres-data.tar.gz` |
| 2 | The backup restores | Done 2026-07-29, evidence in §0. To redo: restore into `pgvector/pgvector:pg16` and expect **exit 0 with empty stderr**, then compare table counts against the table in §0 |
| 3 | You have a verified realm export | **DONE 2026-07-29 08:48 UTC** — `/opt/hill90/backups/app-realm/20260729_084747/hill90-realm.json`, verified property by property in §1. To re-check: `docs/runbooks/scripts/verify-realm-export.sh <file> hill90` prints `EXPORT_LOOKS_COMPLETE`. **Note the verifier is not on the VPS checkout yet** — the box is 15 commits behind, so copy the file off or update the checkout first |
| 4 | The import has been rehearsed | Import the artifact into a throwaway stack, export it again, and confirm the password hashes and all three client secrets come back **identical** (§1) |
| 5 | Both Keycloaks are healthy | `ssh <VPS_HOST> 'docker ps --filter name=keycloak --format "{{.Names}} {{.Status}}"'` — `keycloak` and `app-keycloak` both `(healthy)` |
| 6 | You know which realms exist where | `ssh <VPS_HOST> 'docker exec postgres psql -U hill90 -d keycloak -tAc "select name from realm"'` → expect `master`, `platform`. Same against `app-postgres` → expect `master`, `hill90`. **If `hill90` already exists on the platform side, stop** — the no-collision assumption in §"The realm choice" no longer holds |
| 7 | **The realm decision is made and written down** | Not a command. §"The realm choice is OPEN and is Jon's" lists both arguments with the counts. Nothing below is safe to start while this is open, because it decides whether `KC_REALM` is in the change set |
| 8 | The test user exists, and it is not `jon` | §2. Every token test uses `testuser01` |
| 9 | You know the current claim shape | `docs/runbooks/scripts/token-claims.sh` against `testuser01`, output kept. §7 — the roles claim is the failure that passes every other check |
| 0 | **LOGIN WORKS AT ALL.** Blocking, and currently FAILING — see the box at the top of §5 | Browser-login `testuser01` at `https://hill90.com`. It must reach a signed-in page, not `/api/auth/error?error=Configuration`. Until this passes there is no baseline to migrate against |
| 10 | A rollback path is written for each step you will run | Each numbered section has one. Read them **before** starting, not after a failure |

### Prerequisites that are on `main` but NOT RUNNING

As of 2026-07-29 the running containers still carry the pre-merge configuration.
**Reading the checkout tells you what will run after the next deploy, not what is
running now.** Confirm each against the live container, not the file.

**Measured, not assumed:** the VPS checkout at `/opt/hill90-app` is at `f882158`
(#20) and `origin/main` is at `fb90223` (#35) — **15 commits behind**, and the gap
includes both #25 and #26. So *none* of the prerequisites below are live. The first
deploy will also be the first run of the new checkout preflight (#35), which by
design does not yet exist on the box; it prints the command that fixes that.

| PR | What it changes | Verify it is actually live |
|---|---|---|
| #25 | Pins `app-keycloak`'s own hostname and router rule to the literal `app-auth`, so `APP_AUTH_HOST` no longer moves `app-keycloak` itself — the worst hazard in this migration | `ssh <VPS_HOST> 'docker inspect app-keycloak --format "{{range .Config.Env}}{{println .}}{{end}}" \| grep KC_HOSTNAME'` and `docker inspect app-keycloak --format '{{index .Config.Labels "traefik.http.routers.app-keycloak.rule"}}'`. Both must name `app-auth`, **not** `${APP_AUTH_HOST}` |
| #26 | Removes the hardcoded `KEYCLOAK_JWKS_URI` from `api` and `mcp`, so the JWKS derives from the issuer and cannot disagree with it | `ssh <VPS_HOST> 'docker inspect app-api app-mcp --format "{{.Name}} {{range .Config.Env}}{{println .}}{{end}}" \| grep -i jwks'`. **Empty output means it is live.** Any `app-keycloak:8080` still there means the old config is running |
| #28 | Makes the ui health probe's realm read `KC_REALM` instead of a baked-in `hill90` | `ssh <VPS_HOST> 'docker inspect app-ui --format "{{range .Config.Env}}{{println .}}{{end}}" \| grep KC_REALM'` — present means live |

**Labels bake at container creation.** A router rule or hostname is fixed when the
container is created, so a container started before #25 keeps the old rule no
matter what the file says. This is why #25 must be *deployed*, not merely merged,
before step 4 flips anything.

**If #25 is not live, do not run step 4.** Flipping `APP_AUTH_HOST` while
`app-keycloak`'s own rule still derives from it moves the Keycloak *and* the app
that points at it in the same action, and the rollback is not symmetric.

---

## Read this before you touch anything

### `app-keycloak` holds the only copy of realm `hill90`

Realm `hill90`, its 16 clients, and **both user accounts (`jon`, `hill90admin`)
live inside `prod_app-postgres-data`.** Deleting `app-keycloak` or that volume
still destroys the live copy.

**This is no longer the only copy — see §0.** A cluster dump taken on 2026-07-29
contains the realm and both accounts, verified by reading the rows out of it. That
was the largest single risk in this consolidation and it is materially reduced.
Two caveats keep it from being a green light: **the dump has not been
test-restored**, and it is a copy of the *app's* Keycloak database, which is a
rollback artifact rather than something that can carry the migration (§0).

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

**A collision was the other worry, and there is none.** Verified live: the platform
Keycloak holds realms `master` and `platform` only — **there is no realm named
`hill90` on it.** So importing the app's realm under its existing name is not
blocked by a name clash, and the `hill90-vault` client the reviewer worried about
belongs to `platform`, which an import of a *separate* realm named `hill90` never
touches. That removes the strongest practical objection to option A and makes
`KC_REALM=hill90` genuinely available.

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

**And it is not two copies of that fallback, it is four** — §8 found two more in
`api` (`index.ts:72`, `routes/profile.ts:28`) beyond `app.ts:105`, plus `mcp`. Name
the realm `hill90` and all four go silently correct at once. **This is the decision's
real shape: option A buys a shorter, more reversible migration, and pays for it by
permanently disarming four loud failures.** Both halves are now quantified; the
choice is still Jon's.

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

## 0. The backup exists now — this changed the risk picture

When this runbook was written, **no copy of the two accounts existed anywhere but
the live volume.** That was the single largest risk in the consolidation. It is
fixed. Verified on the host on 2026-07-29, by listing the files rather than
trusting the job that made them:

```
/opt/hill90/backups/app-db/20260729_065944/
  app-database.sql          532513 bytes   deploy:deploy
  app-postgres-data.tar.gz   17347196 bytes   root:root

/opt/hill90/backups/db/20260729_065934/          <- the PLATFORM database, not the app's
  database.sql              322299 bytes
  postgres-data.tar.gz     10282251 bytes
```

**What `app-database.sql` actually contains.** It is a **cluster-wide** dump
(`CREATE DATABASE` for five databases, with `\connect` between them), not a
single-database dump:

```
hill90   hill90_akm   hill90_api   hill90_litellm   keycloak
```

The `keycloak` database in it carries the realm and the accounts. Confirmed by
reading the `COPY` blocks out of the dump:

```
realms in the dump:  master, hill90
users in the dump:   jon         (Jon Hill,     email jon@hill90.com)
                     hill90admin (Hill90 Admin, email admin@hill90.com)
                     -- the dump's user_entity rows lead with EMAIL, not username
tables present:      realm, user_entity, credential, client, keycloak_role,
                     protocol_mapper
```

**So there is now a recovery path for both accounts that does not depend on the
live volume.** That is real and it is the reason the rest of this runbook is less
frightening than it was.

### The dump HAS been test-restored — 2026-07-29

The earlier version of this section said it had not been, and told you not to call
it a proven recovery path until someone restored it. Someone has. Restored into a
throwaway Postgres on the same image the app runs (`pgvector/pgvector:pg16`), from
the exact file listed above:

```
psql -v ON_ERROR_STOP=0 -U postgres < app-database.sql
  exit 0        zero lines on stderr        no errors, no warnings
```

The four things an untested `pg_dumpall` can get wrong were each checked rather
than assumed. Role and ownership: the dump carries `CREATE ROLE hill90` with its
SCRAM verifier, and applied cleanly. Extensions: it requires `uuid-ossp` and
`vector`, both present in that image — **restoring into plain `postgres:16` would
fail on `CREATE EXTENSION vector`.** Ordering against a non-empty cluster: it is a
cluster dump with its own `CREATE DATABASE` statements, so it wants an empty
target. Contents: table counts match production **exactly**.

```
database          production   restored
hill90                     0          0     <- genuinely empty in prod too
hill90_api                32         32
hill90_akm                14         14
hill90_litellm            55         55
keycloak                  89         89
```

And the part that matters for the accounts:

```
realm hill90   jon          jon@hill90.com     password credential present
realm hill90   hill90admin  admin@hill90.com   password credential present
confidential clients with a secret: hill90-api, hill90-ui, hill90-vault
```

**What is still not proven:** nobody has logged into a Keycloak backed by the
restored database with either account's real password. The argon2 hash material is
present and byte-identical round-tripping was demonstrated separately (§1), which
is strong, but it is inference rather than a login. Treat the accounts as
recoverable; do not tell anyone the passwords are *verified*.

### Does the dump make the `kc.sh` export unnecessary? Partly — and the useful part is yes

This was the open question. The answer has two halves and they point in opposite
directions, so state which one you mean.

**As an import mechanism: NO, and attempting it destroys platform SSO.**

The migration puts realm `hill90` into the **platform** Keycloak, whose own
`keycloak` database holds `master` and `platform` (verified live). Restoring the
app's `keycloak` database over it replaces those wholesale. Two different databases
that happen to share a schema. This is not a close call.

Nor can you lift one realm out of the SQL by hand. Measured from the dump itself,
not estimated:

```
tables in the keycloak schema         89
FOREIGN KEY constraints                67
tables carrying a realm_id column      37
```

and the 37 is a floor, not the total — `credential` has no `realm_id` at all, it
hangs off `user_entity`. Reconstructing one realm's closure across that graph, in
dependency order, during a migration, is not a supported operation.

**As a SOURCE for the export artifact: YES, and this is the useful answer.**

The dump does not replace the export. It replaces **running the export against the
live `app-keycloak`**. Restore the dump into a throwaway Postgres, point a `kc.sh
export` sidecar at *that*, and you get the migration artifact with **zero contact
with production** — nothing read from the live database, nothing attached to a
production network, no sidecar on the box at all.

Demonstrated end to end with the real backup file. The artifact passes the repo's
own checker and contains the real production accounts:

```
docs/runbooks/scripts/verify-realm-export.sh from-dump.json hill90

realm:  hill90
users:  2      jon (password-hash=True), hill90admin (password-hash=True)
clients: 9 total, 3 confidential — hill90-api, hill90-ui, hill90-vault all with secrets
client protocolMappers: 4
signing key providers:  4
EXPORT_LOOKS_COMPLETE
```

**So the operation's shape is:**

| | |
|---|---|
| Downtime for the export | **None**, either way — the sidecar export works against a live database (§1) |
| Contact with production to produce the artifact | **None needed** — restore the backup offline and export from that |
| Can the dump be imported into the platform Keycloak | **No.** It would destroy `master` and `platform` |
| Is the export still required | **Yes**, as the import vehicle — but it can be produced from the backup |

The practical consequence: **the entire artifact-production step can be rehearsed
and completed before anyone touches the platform, from a file that already exists.**
The only remaining reason to export from the live instance is if changes were made
after 2026-07-29 06:59 that must come across — check that before choosing.

```bash
# reproduce the offline path (nothing here touches production)
docker network create dumprestore
docker run -d --name dumprestore-db --network dumprestore \
  -e POSTGRES_PASSWORD=x pgvector/pgvector:pg16          # NOT postgres:16 — needs vector
# wait for real readiness: pg_isready returns true during bootstrap, before the
# listener exists. Poll `psql -c 'select 1'` instead.
docker exec -i dumprestore-db psql -U postgres < app-database.sql

docker run --rm --network dumprestore --user root -v "$PWD/out:/out" \
  -e KC_DB=postgres -e KC_DB_URL=jdbc:postgresql://dumprestore-db:5432/keycloak \
  -e KC_DB_USERNAME=postgres -e KC_DB_PASSWORD=x \
  quay.io/keycloak/keycloak:26.4.0 \
  export --realm hill90 --users same_file --file /out/from-dump.json

docs/runbooks/scripts/verify-realm-export.sh out/from-dump.json hill90
docker rm -f dumprestore-db && docker network rm dumprestore
```

**Handle the dump like a credential store.** It contains argon2 password hashes for
both accounts, all three client secrets, and the `hill90` role's SCRAM verifier. A
copy taken off the VPS for a restore test is a copy of every app credential; delete
it when done.

## 1. Export the app realm — DONE, and it needed no downtime

**This step has been executed. You do not need to run it again** unless the realm
has changed since 2026-07-29 08:48 UTC.

```
artifact   /opt/hill90/backups/app-realm/20260729_084747/hill90-realm.json
mode       600, deploy:deploy, 83970 bytes
directory  700 deploy:deploy, and its parent likewise
```

**The earlier version of this section was wrong, and it mattered.** It said
`kc.sh export` requires stopping `app-keycloak`, and told you to accept a login
outage. That premise was false for this image, and it is now disproved **on
production**, not just in a local rehearsal.

`kc.sh export` does not need *this* server stopped — it needs *an* exporter with
access to the database. It ran as a **throwaway `--rm` sidecar on the same image,
against the same database, while `app-keycloak` kept serving.**

### Proof that it cost no downtime

`app-keycloak` was compared before and after by container identity, not by a
health check that could have passed across a restart:

```
                    BEFORE                     AFTER
container id        0a1330bf8dd7…              0a1330bf8dd7…   (identical)
StartedAt           2026-07-29T05:52:58Z       2026-07-29T05:52:58Z (identical)
RestartCount        0                          0
State                                          running, healthy

export output       KC-SERVICES0034 Export of realm 'hill90' requested
                    KC-SERVICES0035 Export finished successfully

host afterwards     23 running containers (same as before)
                    Hill90's own 13 containers all present
                    0 unhealthy containers anywhere
                    0 sidecar containers left behind
```

An identical container id with an identical `StartedAt` and `RestartCount` still
zero is the part that matters: the process serving logins never stopped. **A
"healthy" status alone would not have proved this** — a container that restarted
would report healthy again within seconds.

### What was verified inside the artifact

Each property was checked, not assumed. **Values are never printed — presence,
counts and lengths only**, because the file contains client secrets and password
hashes.

```
realm                    hill90

users                    2 — jon, hill90admin          <- non-empty, both present
  jon                    enabled, email present, realmRoles [admin, default-roles-hill90, user]
                         credential password: hash present (44 chars), salt present, argon2
  hill90admin            enabled, email present, realmRoles [admin, default-roles-hill90]
                         credential password: hash present (44 chars), salt present, argon2

clients                  9 total
  hill90-ui              confidential, secret present (32 chars)
  hill90-api             confidential, secret present (32 chars)
  hill90-vault           confidential, secret present (32 chars)

realm_roles mapper on hill90-ui
  name                   realm-roles
  type                   oidc-usermodel-realm-role-mapper
  claim.name             realm_roles          <- NOT realm_access.roles
  multivalued            true
  access.token.claim     true
  no OTHER mapper on hill90-ui competes for the claim
  (see the correction below about realm_access.roles)

signing key providers    4 — rsa-generated, rsa-enc-generated, hmac-generated-hs512, aes-generated
realm roles              admin, default-roles-hill90, offline_access, uma_authorization, user
clientScopes             14

RESULT                   ARTIFACT_COMPLETE
```

The three properties that were the point of doing this at all:

1. **The users array is non-empty and holds both accounts** with real argon2 hash
   material. A REST partial-export could never contain this (§ table above).
2. **All three confidential clients carry a `secret`.** This is the whole reason a
   `kc.sh` export beats the `pg_dump` as a migration vehicle — had the secrets been
   absent, the export would not have done what §5 assumes it does, and
   `AUTH_KEYCLOAK_SECRET` would have stopped matching after import.
3. **The `realm_roles` mapper survived the export, on `hill90-ui`, pointing at
   `realm_roles`.** That mapper is the thing whose loss silently empties everyone's
   roles after migration (§7), and `hill90-ui` is the client that mints the claim
   the api reads.

### The import was rehearsed on 2026-07-29, and it works

**An export nobody has imported is a hypothesis, and this one carries the whole
premise of the migration**: that this file reconstitutes the realm somewhere else.
It has now been imported.

Into a **throwaway Keycloak on a throwaway database on its own network** — not the
platform Keycloak, not `app-keycloak`. Isolation was proved rather than assumed
before anything was imported:

```
from the throwaway network:   app-postgres does not resolve   (correct)
                              kcimport-db resolves            (correct)
import result:                Realm 'hill90' imported          KC-SERVICES
app-keycloak during:          id/StartedAt/RestartCount unchanged, healthy
```

Everything below was then read **out of the throwaway's own database**, not out of
the file that was imported — otherwise the check would only prove the file can be
parsed twice.

```
1. realm exists              hill90 (enabled), alongside master

2. users, enabled, roles     jon          enabled, email present,
                                          roles: admin, default-roles-hill90, user
                             hill90admin  enabled, email present,
                                          roles: admin, default-roles-hill90
   credentials survived      both: type=password, secret_data present (116 bytes),
                                   credential_data present (156 bytes)

3. clients and secrets       hill90-api    confidential, secret present (32)
                             hill90-ui     confidential, secret present (32)
                             hill90-vault  confidential, secret present (32)
   secrets MATCH the export  sha256 compared, all three identical.
                             The hash was computed INSIDE Postgres for the
                             imported copy and in python for the artifact, so
                             neither secret was ever printed or moved.

4. the roles mapper          hill90-ui    realm-roles
                                          oidc-usermodel-realm-role-mapper
                                          claim.name    = realm_roles
                                          multivalued   = true
                                          access.token.claim = true
                             hill90-vault same
```

**Point 4 is the one that mattered most.** If that mapper did not survive an
import, every path in this runbook would produce a realm where **login succeeds and
authorisation silently fails** — §7's failure, discovered by Jon rather than by a
test. It survives.

**A correction to an earlier claim in this section.** The verification of the
artifact said *"any mapper pointing at `realm_access.roles`: none"*. That was
scoped to **clients** only, and it is not the whole picture. The imported realm
does contain one such mapper:

```
clientScope: roles   mapper: realm roles   claim.name: realm_access.roles
```

That is the **Keycloak built-in** `roles` client scope, which ships with every
realm. It was checked against the artifact and is present there too, so the import
reproduced it rather than inventing it. It is not a competing mapper and it does not
break anything — the app reads `realm_roles`, which comes from the per-client
mapper, and the two claims coexist exactly as they do in production today.

The distinction matters because §7 is entirely about these two claim names, so
"none" was the wrong word in a place where precision is the point. **What is true:
nothing competes for the `realm_roles` claim, and the only `realm_access.roles`
mapper is the stock one.**

### Nothing was left behind

Confirmed by listing, not asserted, and compared against a baseline taken before
any of it:

```
                     before    after
running containers      23        23
all containers          24        24
volumes                 23        23
networks                 9         9
Hill90's own            13        13
unhealthy                0         0

kcimport-* containers / volumes / networks after teardown:  none, none, none
app-keycloak    id, StartedAt and RestartCount identical throughout
```

### What this still does NOT prove

- **Nobody logged in.** The password hashes came across byte-identically and
  Keycloak validates against exactly that material, which is why this is a restore
  rather than a re-creation — but no browser has authenticated against the imported
  realm. That would need a running throwaway Keycloak with a hostname, and it needs
  either account's real password.
- **Nothing was imported into the platform Keycloak.** That import *is* the
  migration and it is Jon's to authorise. What is proved is that the artifact
  imports faithfully into a Keycloak of the same version — not that the platform
  Keycloak will accept it alongside `master` and `platform`, which §"The realm
  choice" is still open on.



- **It lives on the same host as the Keycloak it protects.** That is where the
  brief asked for it and it is consistent with the other backups, but a single-host
  copy is not off-site. If the host is lost, so is this.
- **It is a point-in-time copy.** Any realm change after 08:48 UTC on 2026-07-29 is
  not in it. Re-run the command below if that is in doubt — it is cheap and it
  costs no downtime, which is now a measured fact rather than a claim.
- **The verifier is not on the VPS checkout.** It merged in #29 and the box is 15
  commits behind, so re-verifying on the box needs the checkout updated first.

### The exact command that was run, and how to re-run it

This is what produced the artifact above, verbatim apart from the timestamp. It
writes into `/opt/hill90/backups/`, beside the database backups, rather than
`/tmp` — the file contains client secrets and password hashes and should not sit
in a world-readable temp directory.

```bash
ssh deploy@<VPS_HOST> '
  set -euo pipefail
  cd /opt/hill90-app
  export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt

  STAMP=$(date +%Y%m%d_%H%M%S)
  DEST=/opt/hill90/backups/app-realm/$STAMP
  mkdir -p "$DEST"
  chmod 700 /opt/hill90/backups/app-realm "$DEST"

  DB_USER=$(sops -d --extract "[\"DB_USER\"]" infra/secrets/prod.enc.env)
  DB_PASSWORD=$(sops -d --extract "[\"DB_PASSWORD\"]" infra/secrets/prod.enc.env)
  # Fail closed rather than exporting with empty credentials. This is the lesson
  # from the secrets-loader incident: a loader that produces nothing must not
  # yield a green result.
  [ -n "$DB_USER" ] || { echo "FATAL: DB_USER decrypted empty"; exit 1; }
  [ -n "$DB_PASSWORD" ] || { echo "FATAL: DB_PASSWORD decrypted empty"; exit 1; }

  docker run --rm \
    --name app-realm-export-sidecar \
    --network hill90_internal \
    --user root \
    -v "$DEST:/out" \
    -e KC_DB=postgres \
    -e KC_DB_URL=jdbc:postgresql://app-postgres:5432/keycloak \
    -e KC_DB_USERNAME="$DB_USER" \
    -e KC_DB_PASSWORD="$DB_PASSWORD" \
    quay.io/keycloak/keycloak:26.4.0 \
    export --realm hill90 --users same_file --file /out/hill90-realm.json

  # The sidecar runs as root, so the file lands root:root 644. Tighten it.
  # `chown` does NOT work here: the ssh user is deploy (uid 1000) and cannot
  # chown a root-owned file. Copy to a deploy-owned file and unlink the original
  # instead — deploy owns the directory, so it can. This avoids needing sudo.
  cd "$DEST"
  umask 077
  cp hill90-realm.json hill90-realm.deploy.json
  rm -f hill90-realm.json
  mv hill90-realm.deploy.json hill90-realm.json
  chmod 600 hill90-realm.json
  ls -la hill90-realm.json
'
```

**Then confirm nothing was left behind**, because a `--rm` container is only gone
if the run actually completed:

```bash
ssh deploy@<VPS_HOST> '
  docker ps -a --filter name=app-realm-export-sidecar --format "{{.Names}}"   # expect empty
  docker ps -q | wc -l                                                        # expect 23
  docker ps --filter health=unhealthy --format "{{.Names}}"                    # expect empty
  docker inspect app-keycloak --format "{{.RestartCount}} {{.State.Health.Status}}"
'
```

**Every flag in that command was tested, and one obvious guess is wrong:**

| Flag | Why |
|---|---|
| `--users same_file` | **`--users realm_file` is REJECTED with `--file`.** The error is *"Property '--users' can be used only when exporting to a directory, or value set to 'same_file' when exporting to a file."* `realm_file` is valid only with `--dir`. |
| `--file` (not `--dir`) | Either works and both produced a byte-identical realm file here. `--file` gives one artifact to checksum. Upstream advises `--dir` above 50 000 users; this realm has two. |
| `--user root` | The image runs as uid 1000 and cannot write a host bind mount owned by someone else. Without it the export fails on permissions after doing all the work. |
| `--network hill90_internal` | Verified: `app-postgres` is attached to `hill90_internal` in prod. The hostname `app-postgres` does not resolve from anywhere else. |
| `--rm` | The sidecar must not linger. It is not part of the stack and nothing should ever restart it. |

The first run prints `Changes detected in configuration. Updating the server image.`
and takes noticeably longer — that is Keycloak rebuilding its augmented image
inside the throwaway container. It is expected, not a fault.

### Verify the artifact before trusting it

**`docs/runbooks/scripts/verify-realm-export.sh` does this. Use it.**

```bash
scp deploy@<VPS_HOST>:/tmp/realm-export/hill90-realm.json /tmp/
docs/runbooks/scripts/verify-realm-export.sh /tmp/hill90-realm.json hill90
```

It asserts, and fails loudly on each: the realm name; a **non-empty `users` array**;
that every user has a password credential with real hash material
(`secretData.value` and `.salt`); that every **confidential** client carries a
`secret`; and that realm signing keys are present.

Two traps it exists to avoid:

- **Asserting on the wrong clients.** `broker` and `realm-management` are built-in
  and `bearerOnly`, and never carry a secret. A naive "every non-public client has a
  secret" check **fails on a perfectly good export.** The script excludes
  `bearerOnly`.
- **Confusing the email for the username.** The accounts are username `jon` /
  email `jon@hill90.com`, and username `hill90admin` / email `admin@hill90.com`
  (verified live). The `user_entity` rows in the SQL dump lead with the **email**
  column, so reading a dump makes the emails look like the usernames. Grepping an
  export for `admin@hill90.com` as a *username* finds nothing and looks like a
  missing account. The original `grep` for `jon` and `hill90admin` in this section
  was right; this note exists because it was briefly "corrected" to the emails,
  which was wrong.

What a good export looks like, measured on the local realm:

```
users=1  password-hash=True
clients=8 total, 2 confidential — hill90-api secret=present, hill90-ui secret=present
client protocolMappers=3
realm roles=[offline_access, default-roles-hill90, uma_authorization, user, admin]
signing key providers=4
EXPORT_LOOKS_COMPLETE
```

### Rehearse the import — this is the part that proves it

Checking the file proves the file. It does not prove an import restores it. That
was rehearsed in a **fully isolated throwaway stack** (its own network, its own
empty Postgres, nothing existing touched, both removed afterwards): import the
export, export it back out, compare.

```
password hash value identical   True   (argon2, 44 chars)
password salt identical         True
credentialData identical        True
hill90-api  secret IDENTICAL    True
hill90-ui   secret IDENTICAL    True
signing key private material    identical (4 providers)
realm roles identical           True
clientScopes                    14 -> 14
client protocolMappers          3 -> 3
```

**Three consequences, all good:**

1. **Passwords survive.** The argon2 hash and salt come across byte-identical, so
   both accounts log in with the passwords they already have. No reset, no
   coordination with Jon about a new password.
2. **Client secrets survive**, byte-identical. This is the measured version of §5's
   second bullet — it was reasoned there and is now verified. `AUTH_KEYCLOAK_SECRET`
   in SOPS keeps matching, so it stays out of the change set.
3. **Realm signing keys survive**, which was not previously considered. The realm
   keeps its RSA keypair, so the JWKS the app fetches contains the *same* keys and
   **tokens issued before the migration keep validating after it.** That removes a
   forced-logout failure mode nobody had accounted for.

**Do this rehearsal against the real prod export too, before the migration.** The
numbers above are from the local realm, which has one user and possibly different
client secrets. The mechanism is proven; the specific artifact is not until you run
it on the artifact.

```bash
docker network create kcrehearse
docker run -d --name kcrehearse-db --network kcrehearse \
  -e POSTGRES_USER=kc -e POSTGRES_PASSWORD=rehearse -e POSTGRES_DB=keycloak \
  pgvector/pgvector:pg16
# then, same sidecar shape as above but --network kcrehearse and the kc/rehearse creds:
#   import --file /out/hill90-realm.json
#   export --realm hill90 --users same_file --file /out/roundtrip.json
docker rm -f kcrehearse-db && docker network rm kcrehearse      # leave nothing behind
```

**Rollback:** nothing to roll back. No existing container is stopped, started or
reconfigured by any of this — the only thing created is a `--rm` sidecar and, for
the rehearsal, an isolated network and database that are removed afterwards. If the
export is empty or the verifier fails, **stop** — every later step assumes a good
one.

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

> ### THIS HAS ALREADY HAPPENED. LOGIN ON `hill90.com` IS BROKEN RIGHT NOW.
>
> This section was written as a *migration* hazard. On 2026-07-29 09:15 UTC it was
> found to be a **live production defect**, discovered by attempting the first real
> end-to-end browser login anyone has performed against production.
>
> **Symptom.** Keycloak authenticates the user correctly, then Auth.js fails the
> code-for-token exchange and redirects to `/api/auth/error?error=Configuration`.
> `app-ui` logs the cause exactly:
>
> ```
> [auth][details]: { "error": "unauthorized_client",
>                    "error_description": "Invalid client or Invalid client credentials",
>                    "provider": "keycloak" }
> ```
>
> **Cause — precisely the mechanism this section describes.**
> `platform/auth/keycloak/hill90-realm.json` declares `hill90-ui`, `hill90-api` and
> `hill90-vault` as confidential with **no `secret` field** (verified). `app-keycloak`
> runs `start --import-realm`, so at first start Keycloak **minted** a fresh secret
> for each. `AUTH_KEYCLOAK_SECRET` in SOPS was never that value.
>
> **Which copies disagree — compared by sha256, values never printed:**
>
> ```
> Keycloak's actual hill90-ui secret     d3eca7b3…
> the running app-ui container           008156b6…
> the SOPS store (prod.enc.env)          008156b6…
> ```
>
> **The store and the container agree with each other and both differ from
> Keycloak. A redeploy will NOT fix this** — it would deploy the same wrong value.
>
> **This affects every user, not just the test account.** The token exchange
> authenticates the *client*, not the person, so no one can complete a login. The
> health checks cannot see it: `app-ui` is healthy, `/api/auth/signin` returns 200,
> and the failure happens one redirect later.
>
> **The correct value already exists in a form we control.** The realm export taken
> earlier tonight carries it, and its hash matches Keycloak exactly:
>
> ```
> /opt/hill90/backups/app-realm/20260729_084747/hill90-realm.json
>   hill90-ui secret sha256   d3eca7b3…   == Keycloak's
> ```
>
> **Suggested repair, NOT performed — it is a secret change plus a deploy, which is
> Jon's to authorise:**
>
> 1. Read `clients[] → hill90-ui → secret` out of that artifact (or from Keycloak's
>    admin API) — do not regenerate it, or every other copy breaks too.
> 2. Write it to `AUTH_KEYCLOAK_SECRET` in `infra/secrets/prod.enc.env`.
> 3. Deploy `ui`.
> 4. Re-run the acceptance test in §10 and confirm a token is issued.
>
> Check `hill90-api` and `hill90-vault` the same way before assuming only the ui is
> affected. `app-api` was checked and holds **no** client-secret env var at all, so
> it is not affected by this; `hill90-vault` belongs to OpenBao SSO and is the infra
> lane's.
>
> **Consequence for the migration:** §5's warning is no longer hypothetical, and the
> pre-migration checklist cannot be completed until this is fixed — there is no
> known-good token to compare against while login cannot complete.



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

  **This bullet is now measured, not reasoned.** An export/import/re-export round
  trip in a throwaway stack returned both client secrets **byte-identical**, along
  with the argon2 password hashes and the realm signing keys. Evidence in §1. The
  warning at the top of this section stands unchanged — it is about the *committed*
  `hill90-realm.json`, which genuinely has no `secret` fields, and that artifact
  still mints new secrets.

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

**Which clients carry it — read out of the real production realm, not assumed.**
From a `kc.sh` export of the restored backup (§0):

| Client | `realm-roles` mapper | `claim.name` | multivalued |
|---|---|---|---|
| `hill90-ui` | **yes** | `realm_roles` | true |
| `hill90-vault` | **yes** | `realm_roles` | true |
| `hill90-api` | **no mapper at all** | — | — |

`hill90-api` having none is not a gap. The browser obtains its token from
`hill90-ui`, and the api validates *that* token — so the claim the api reads at
`middleware/role.ts:11` is minted by the **ui** client's mapper. **`hill90-ui` is
the one that must survive the migration.** `hill90-vault` belongs to OpenBao SSO
and is the infra lane's, not this migration's.

The practical form of the check after any import: confirm the mapper exists on
`hill90-ui` **and** that its `claim.name` is `realm_roles`, then assert on a real
token (below). A mapper present with the default claim name is the failure this
section is about.

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

**PR #28 has landed the no-op parameterisation for the rows marked below.** It made
`KC_REALM` the knob for the ui health probe and collapsed `api`'s three copies of
the issuer fallback into `services/api/src/middleware/keycloak-config.ts`. The
fallback itself was deliberately left in place — removing it is a behaviour change
tied to the realm-name decision, not a refactor.


| File:line | What reads it | Migration action |
|---|---|---|
| `services/api/src/app.ts:105` | fallback issuer when `KEYCLOAK_ISSUER` unset | **Code change if the target realm is named `hill90`.** Today `auth.hill90.com/realms/hill90` 404s, so a blank issuer fails loudly. Name the realm `hill90` there and this fallback silently becomes *correct* — a blank issuer then looks like working config forever |
| `services/api/src/index.ts:72` | same fallback, WebSocket terminal proxy path | Same. **Not previously reported** — a second copy of the same literal |
| `services/api/src/routes/profile.ts:28` | same fallback, profile route | Same. **Third copy** |
| `services/mcp/app/main.py:17` | fallback issuer for MCP | Same |
| `services/ui/src/utils/admin-services.ts:24,29,30` | admin UI service list — hardcodes `url: 'https://auth.hill90.com'`, `internalUrl: 'http://keycloak:8080'` and `path: '/realms/hill90'` | **Code change — and it is already broken today, but not for the reason first reported here.** See the correction below. |
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

### Correction: the admin services page, and what is actually wrong with it

An earlier version of this table said `admin-services.ts` pointed at the wrong
container — that `internalUrl: 'http://keycloak:8080'` named Hill90's Keycloak
instead of `app-keycloak`, and was therefore a bug. **That was wrong, and the
reasoning behind it was wrong too.**

`ADMIN_SERVICES` is a registry of **platform** services. The other entries are
`openbao`, `grafana`, `portainer`, `minio`, `traefik` and `litellm` — every one an
unprefixed Hill90 platform container. So `http://keycloak:8080` and
`https://auth.hill90.com` are **correct by design**: this page is meant to show the
platform's Keycloak, not the app's.

**What is genuinely broken is the realm in the path**, and it was verified rather
than reasoned — probed from inside the running `app-ui` container in production:

```
http://keycloak:8080/realms/hill90        -> 404      <- what the page probes
http://keycloak:8080/realms/platform      -> 200      <- the platform's realm
http://app-keycloak:8080/realms/hill90    -> 200      <- the app's realm
```

The health route treats any non-`ok` response as unhealthy, so **the admin page's
Keycloak row reports unhealthy today**, and has for as long as the registry has
looked like this. The platform Keycloak holds `master` and `platform` — there is no
`hill90` realm on it.

**This is not fixed here, deliberately.** Correcting it changes what the admin page
displays, so it is a behaviour change rather than the no-op parameterisation in
PR #28, and it belongs to the platform-services registry rather than to this
migration. It needs a decision — probe `/realms/platform`, or probe something
realm-independent like the Keycloak health endpoint — which is Jon's to make.

**Why this correction is in the runbook rather than quietly amended:** the original
claim would have sent someone renaming a container reference that was right, during
a migration, to fix a symptom whose real cause is one field further along.

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
