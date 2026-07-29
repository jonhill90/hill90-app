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

### The dump has NOT been test-restored

**A backup nobody has restored is a hypothesis.** Nothing above proves the dump
restores — only that it contains the right rows. The specific things an untested
`pg_dumpall` output can still get wrong are ownership and role grants, extension
availability in the target image (`pgvector` here), and the order of `CREATE
DATABASE` against a non-empty cluster.

**Do not describe this as a proven recovery path until someone has restored it into
a throwaway Postgres and logged in.** If that has been done since this was written,
update this section with the date and who did it.

### The dump does NOT make the realm export optional

This is worth being precise about, because it is tempting. The reasoning is:

- **What the dump is good for:** recreating **`app-keycloak`'s own database**. That
  is a rollback and disaster-recovery artifact, and a good one.
- **Why it cannot carry the migration:** the migration puts realm `hill90` into the
  **platform** Keycloak, which has its own `keycloak` database holding `master` and
  `platform` (verified live). Restoring the app's `keycloak` database over the
  platform's would **replace the platform's realms wholesale and destroy platform
  SSO.** They are two different databases that happen to share a schema.
- Extracting one realm from the SQL by hand means untangling a realm's rows across
  roughly ninety foreign-keyed tables. That is not a supported operation and not one
  to attempt during a migration.

**The dump is the safety net. The realm export is the vehicle. You need both, and
they are not substitutes.**

## 1. Export the app realm — no downtime required

**The earlier version of this section was wrong, and it mattered.** It said
`kc.sh export` requires stopping `app-keycloak`, and told you to accept a login
outage. That premise has been tested and is false for this image.

`kc.sh export` does not need *this* server stopped — it needs *an* exporter with
access to the database. Run it as a **throwaway sidecar container on the same
image, pointed at the same database, while `app-keycloak` keeps serving.**

**Verified locally against `quay.io/keycloak/keycloak:26.4.0`** — the exact prod
image — with the live Keycloak up throughout:

```
export of realm 'hill90' requested          KC-SERVICES0034
export finished successfully                KC-SERVICES0035
live keycloak during and after:             Up (healthy)
```

### The exact command

```bash
ssh deploy@<VPS_HOST> '
  set -euo pipefail
  cd /opt/hill90-app
  export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt
  DB_USER=$(sops -d --extract "[\"DB_USER\"]" infra/secrets/prod.enc.env)
  DB_PASSWORD=$(sops -d --extract "[\"DB_PASSWORD\"]" infra/secrets/prod.enc.env)

  mkdir -p /tmp/realm-export && chmod 777 /tmp/realm-export

  docker run --rm \
    --network hill90_internal \
    --user root \
    -v /tmp/realm-export:/out \
    -e KC_DB=postgres \
    -e KC_DB_URL=jdbc:postgresql://app-postgres:5432/keycloak \
    -e KC_DB_USERNAME="$DB_USER" \
    -e KC_DB_PASSWORD="$DB_PASSWORD" \
    quay.io/keycloak/keycloak:26.4.0 \
    export --realm hill90 --users same_file --file /out/hill90-realm.json
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
