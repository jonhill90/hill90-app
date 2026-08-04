# Local parity: should local run against the platform services too?

**Status: OPEN — this is a scope, not a change.** Nothing here has been converted, and
nothing should be until Jon picks an option. Every claim below was measured on
2026-07-31 and is dated, because the thing that makes this decision hard is that the
local stack's real state and its documented state have already drifted apart once.

**Related:** [running-the-app-on-hill90-infra.md](running-the-app-on-hill90-infra.md),
the deploy path described in `CONTRIBUTING.md`, Hill90's
[object-store.md](https://github.com/jonhill90/Hill90/blob/main/docs/decisions/object-store.md).

---

## Read this first: local is one `up` away from broken, and that is separable

`Measured 2026-07-31 02:40 UTC.`

The three production retirements this week — `app-keycloak` (#62), `app-postgres` (#63),
`app-minio` (storage cutover) — changed `deploy/compose/prod/docker-compose.api.yml` to
name the **platform** services. The local overrides layer on those production files, and
**`.env.local.example` was never given the new keys.**

The running local stack does not show this, because it was started before the change:

```
$ docker inspect hill90dev-app-api --format '{{.Created}}'
2026-07-30T02:09:03Z                      # ~25h old — predates the cutover commits

$ docker inspect hill90dev-app-api | grep -E 'DATABASE_URL|MINIO_ENDPOINT'
DATABASE_URL=postgresql://hill90:***@app-postgres:5432/hill90_api
MINIO_ENDPOINT=http://app-minio:9000
```

But this is what a **fresh** `./scripts/local.sh up` renders today:

```
service      variable             value
api          DATABASE_URL         postgresql://<EMPTY-USER>:<EMPTY-PASSWORD>@:5432/hill90_api
api          MINIO_ENDPOINT       http://minio:9000
api          MINIO_ACCESS_KEY     <empty>
api          MINIO_SECRET_KEY     <empty>
ai           DATABASE_URL         postgresql://<EMPTY-USER>:<EMPTY-PASSWORD>@:5432/hill90_api
knowledge    AKM_DATABASE_URL     postgresql://<EMPTY-USER>:<EMPTY-PASSWORD>@:5432/hill90_akm
```

Reproduce with `docker compose <the tenant -f list> --env-file .env.local config`.

Three things are wrong at once:

1. **Empty database URLs** — no host, no user, no password. `PLATFORM_DB_HOST`,
   `PLATFORM_DB_USER` and `PLATFORM_DB_PASSWORD` are absent from `.env.local.example`
   and from `.env.local`. Since #61, `ai` **refuses to start without a database**, so
   this is a hard failure, not a degraded one.
2. **`MINIO_ENDPOINT` already points at `minio:9000`** — the platform container — because
   it inherits the production default and no local override replaces it. **There was no
   `hill90dev-minio` container on this machine.** (Corrected 2026-07-31 — see the note
   below. The cause was not what this record first said.)
3. **Empty MinIO credentials** — `MINIO_TENANT_ACCESS_KEY` / `MINIO_TENANT_SECRET_KEY`
   are not in the local env either.

Compose emitted **no** "variable is not set" warning for any of it, because
`${PLATFORM_DB_HOST}` without `:?` or `:-` interpolates silently to empty. That is the
same failure shape the platform repo spent this week fixing in `deploy.sh`, one layer
down — and it is exactly the blind spot `CLAUDE.md` invariant 6 names: *every variable an
override replaces is one the local run cannot validate.*

> **This should be fixed on its own, before and independently of the parity decision.**
> Restoring a startable local stack is not the same question as whether local should use
> the platform services, and it must not wait behind it. Whoever restarts local next
> hits this — including Jon.

---

## What local looks like today, measured

| | Production | Local (`hill90dev-`) |
|---|---|---|
| Identity | platform Keycloak, realm `platform` | **`app-keycloak`**, realm `platform` from `realm-local.json` |
| Database | platform Postgres, `PLATFORM_DB_*` | **`app-postgres`** (running container); a fresh `up` renders empty |
| Object store | platform `minio`, `tenant-hill90-app` | **`app-minio`** (running); a fresh `up` points at a `minio` that does not exist |
| Deploy verb | `deploy.sh db`/`auth` **refuse — RETIRED** | `local.sh` still starts `db auth minio` |

`scripts/local.sh` line 54: `STACKS="db auth api ai knowledge mcp minio ui"`. Production's
`scripts/deploy.sh` refuses `db` and `auth` outright. **The two lists have diverged, and
nothing checks that they agree.**

The production compose files still *define* `app-postgres`, `app-keycloak` and
`app-minio`. That was deliberate — #62 kept `docker-compose.auth.yml` precisely because
the local overrides layer on it — but the consequence is that local silently keeps
running services production no longer has.

### What the platform already provides locally

This is the good news, and it shrinks the work considerably:

- **`hill90dev-postgres` is running and already provisioned.** Databases
  `hill90_api`, `hill90_akm`, `hill90_litellm` all exist, and so does the tenant role
  `hill90_app`. Verified by querying it.
- **`hill90dev-keycloak` is running, and the app's clients already exist in realm
  `platform`.** `hill90-ui` returns `Invalid parameter: redirect_uri` — the client is
  registered, only the callback I probed with was not. Contrast a client that genuinely
  does not exist, which returns `Client not found`. Hill90's `keycloak.sh tenant-clients`
  is what reconciles them and it has evidently run here.
- **`hill90dev-minio` did not exist** — but not for the reason first recorded here.
  `scripts/local.sh up` *does* start Hill90's MinIO stack. See the correction below.

---

## Proven 2026-07-31: local auth works end to end — against the WRONG Keycloak

The whole flow was driven for the first time: a real authorization-code login as the
local `dev` user, through the app's own client, landing back in the app with roles
enforced. It works. **It does not prove tenancy**, and the distinction is the point of
this record.

**Which components were actually involved.** Local runs *two* Keycloaks, both serving a
realm named `platform`, which is precisely how this gets confused:

| Hostname | Container | Realm | Users |
|---|---|---|---|
| `app-auth.localtest.me` | `hill90dev-app-keycloak` — **the app's own** | `platform` | 4 |
| `auth.localtest.me` | `hill90dev-keycloak` — the platform's | `platform` | **0** |

The tenant points at the **first**:

```
app-api  KEYCLOAK_ISSUER=http://app-auth.localtest.me:8080/realms/platform
app-ui   AUTH_KEYCLOAK_ISSUER=http://app-auth.localtest.me:8080/realms/platform
```

Production points at the platform's: `KEYCLOAK_ISSUER=https://auth.hill90.com/realms/platform`.

**So a green local login proves the auth design, not the tenancy.** Same realm name,
different issuer, different directory.

### What the login did prove, from the token's own claims

```
iss   http://app-auth.localtest.me:8080/realms/platform
aud   hill90-api
azp   hill90-ui
resource_access.hill90-ui.roles   ['admin', 'user']
realm_access.roles                None
```

Roles arrive under **`resource_access`**, and `realm_access.roles` is empty — matching
production's model, where a realm role also named `admin` exists and must *not* grant
application access. `services/api/src/middleware/keycloak-config.ts` reads
`resource_access.<client>.roles`, which is correct.

Enforcement was proven by discrimination rather than by a single green call — two users
through the identical flow, differing only in their client role, against an admin-gated
route:

| User | client roles | `/me` | `/storage/buckets` |
|---|---|---|---|
| `dev` | `admin, user` | 200 | **200** |
| `testuser01` | `user` | 200 | **403** |

No token at all returns 401. One user passing proves a signature was accepted; the pair
proves the app resolved the role and acted on it.

## What parity would actually take

Per service, smallest coherent change first.

### Postgres — small, and mostly already done

The databases and the tenant role exist. What is missing is wiring:

- Add `PLATFORM_DB_HOST=hill90dev-postgres` (or the compose service alias `postgres`),
  `PLATFORM_DB_USER`, `PLATFORM_DB_PASSWORD` to `.env.local.example` and `.env.local`.
- Drop `db` from `local.sh`'s `STACKS`, or keep it behind the offline flag below.
- `scripts/provision-tenant-db.sh` needs to be runnable against the local platform
  Postgres so a fresh clone can get there — today the databases exist on this machine by
  history, not by a documented step.

**Risk: low.** It is the change that most closely matches production, and the failure
mode is a connection error at start, which is loud.

### Keycloak — the real work, and the real prize

This is the one Jon's parity argument is actually about: *a local test that runs against
the app's own Keycloak proves nothing about a production that uses the platform's.*

- Point `KEYCLOAK_ISSUER` / `KEYCLOAK_JWKS_URI` at `auth.localtest.me:8080` /
  `hill90dev-keycloak:8080` instead of `app-auth.localtest.me` / `app-keycloak:8080`.
  Both live in `deploy/compose/overrides/local.api.yml` and `local.ui.yml`.
- **Seed users into the local platform realm. It has none.** `Measured 2026-07-31`:
  realm `platform` on `hill90dev-keycloak` holds **0 users**, against 4 in the app's
  own Keycloak. The client and its roles are there — `hill90-ui` with client roles
  `admin` and `user` — but pointing local at it today means nobody can log in at all.
  This is the largest single cost in option C and it was not previously recorded.
  Verified with a positive control, because an empty result is exactly the kind this
  estate has misread before: the same query returns `master: 1 users`.
- The local platform realm needs the app's **routed** redirect URI. `Measured
  2026-07-31`: it already has `http://localhost:13000/api/auth/callback/keycloak` and
  `https://hill90.com/...`, but **not** `http://app.localtest.me:8080/...`, so the
  direct-port path would work and the Traefik-routed one would not. Hill90's
  `keycloak.sh tenant-clients` is the right place — this repo must not write to
  Hill90's realm directly.
  **Decided the other way, 2026-08-04 (#271).** The prediction was right and the
  routed path did fail, with `Invalid parameter: redirect_uri`. Rather than widen the
  platform's client for a tenant's convenience, the app's `AUTH_URL` now points at the
  published port the client already allows. Production has exactly one UI origin;
  adding a second one locally would have been local growing a shape production does not
  have — and `webOrigins` carries the same single value, so the redirect alone would
  have traded the 400 for a CORS failure. The cost, stated rather than hidden: a local
  login no longer traverses Traefik.
- `compose/local/keycloak/realm-local.json` becomes dead for the tenant path. It stays
  for `--standalone`. **Do not delete it**: `local.auth.yml` bind-mounts it, and a
  missing bind-mount *file* does not error — Docker creates a directory in its place and
  Keycloak silently imports no realm. That trap is already guarded by
  `tests/scripts/compose-mounts.bats`.
- The client secret: local currently uses a fixed dev secret from `realm-local.json`.
  Against the platform realm the app needs the real `hill90-ui` secret locally, which
  means a local secret-distribution story that does not exist yet. **This is the single
  biggest unknown in the whole change.**

**Risk: high.** Auth is where every previous local/prod divergence has hidden, and the
failure mode is a login loop that looks like an app bug.

## Correction, 2026-07-31: Hill90's local MinIO was never the blocker

This record originally said *"Hill90's local `up` does not start its MinIO stack"* and
used that to mark option D blocked on a change in the platform repo. **That was wrong,
and the error was mine.** I inferred a cause from an absence: there was no
`hill90dev-minio` container, and I concluded the platform's `up` did not start one.

What was actually true, established by tearing Hill90's local platform stack down
completely — volumes included — and bringing it up from nothing:

- `scripts/local.sh up` **does** start the MinIO stack, and it came up healthy.
- The container was missing because the developer's `.env.local` **predated the MinIO
  keys**. Hill90's `.env.local.example` gained `MINIO_HOST`, `MINIO_PUBLIC_URL`,
  `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_OIDC_CLIENT_SECRET`,
  `MINIO_OIDC_CLAIM_NAME` and `MINIO_TRAEFIK_ENABLE`; the existing `.env.local` did not,
  because `require_env` only copies the template when the file is **absent**.

That is the same "existing developers are not fixed by fixing the generator" gap this
repo hit in #71 — in the other repo, and with the opposite mechanism.

**Hill90 already catches it.** `check_env_drift` in its `local.sh` compares the two files
on every `up` and `status`, and named all seven keys exactly when pointed at the stale
file:

```
! .env.local is missing 7 variable(s) present in .env.local.example:
    MINIO_HOST  MINIO_OIDC_CLAIM_NAME  MINIO_OIDC_CLIENT_SECRET
    MINIO_PUBLIC_URL  MINIO_ROOT_PASSWORD  MINIO_ROOT_USER  MINIO_TRAEFIK_ENABLE
  Compose substitutes these as empty strings rather than failing, so the
  stack may start with those features silently unconfigured.
```

The mechanism works; the content lagged. It is a warning rather than a failure, and the
likely reason nobody saw it is simply that `up` had not been re-run since MinIO landed.

**What this changes for the decision.** Option D is *not* blocked on a platform change.
Bringing local storage onto the platform MinIO needs a local `tenant-hill90-app`
credential, which is work in this repo. It does not raise D above C in priority — auth is
still the question that matters — but "blocked elsewhere" was the wrong reason to defer
it, and deferring for a wrong reason is how something stays deferred after the reason
expires.

### MinIO — needs a local tenant credential, and nothing else

**Corrected above.** Hill90's local MinIO starts fine; it needs only a complete
`.env.local`. What parity here actually requires is a local `tenant-hill90-app`
credential scoped to the three buckets — the local equivalent of the production one —
and that is **this repo's work, not Hill90's**.

Both halves of that sentence have since changed: #71 set `MINIO_ENDPOINT` explicitly to
`http://app-minio:9000`, and `hill90dev-minio` now exists and is healthy. So local no
longer points at a container that is not there — it points, deliberately, at the app's
own store until this decision is made.

**Risk: medium. The dependency is internal — this repo mints the credential.**

---

## What a developer loses

Worth stating plainly, because this is the cost side:

- **A one-command start.** Today `./scripts/local.sh up` is self-sufficient. Under full
  parity it requires Hill90's local stack running first, with Postgres, Keycloak *and*
  MinIO up. That is a second repo, a second `up`, and a longer cold start.
- **Offline work.** The tenant path already needs Hill90's networks, but the app's own
  Postgres and Keycloak mean a developer can currently work with Hill90's identity stack
  down. Parity removes that.
- **Cheap resets.** `docker volume rm` on the app's own Postgres is currently a local
  concern. Against the shared local platform Postgres, a reset touches a database other
  local services use.
- **Realm editing.** `realm-local.json` is editable, diffable and in this repo. The
  platform realm is Hill90's, reconciled by Hill90's script — a developer wanting a new
  test user or client changes a different repo.

### Should the app's own services stay behind a flag?

**Yes — recommended.** The inverse of today's default:

```
./scripts/local.sh up                  # tenant: platform Keycloak, Postgres, MinIO
./scripts/local.sh up --own-services   # app-keycloak, app-postgres, app-minio
```

`--standalone` already exists and covers most of this. The honest framing is that
`--standalone` becomes the supported offline mode and the tenant path becomes the one
that resembles production — which is what `local.sh`'s own header already claims the
tenant default is for.

The trap to avoid: **two paths that both exist but only one of which is exercised is how
`compose/local.yml` drifted in the first place.** If the app's own services stay behind a
flag, CI has to start that path too, or it will rot exactly as the fork did.

---

## Options

| | Option | Effort | Risk | Parity gained |
|---|---|---|---|---|
| **A** | Fix the empty-variable breakage only. Local keeps its own services | Hours | Low | None — but local starts again |
| **B** | A, plus Postgres parity | ~½ day | Low | Database path matches |
| **C** | B, plus Keycloak parity | 2–3 days | **High** | The one that matters — auth |
| **D** | C, plus MinIO | +1 day | Medium | Full |

**Recommendation: A now, separately and immediately. Then B. Hold C until the local
secret-distribution question is answered. D is no longer blocked on Hill90 — it needs a
local `tenant-hill90-app` credential, which is this repo's work.**

A is not really an option, it is a bug fix that A/B/C/D all need — it is listed only so
the sequencing is explicit. B is cheap and low-risk because the local platform Postgres
is already provisioned. C is where the value is and also where the danger is: it should
be its own change, with its own decision record, and it should not be started in the same
week as three production retirements.

## What would make C safe to attempt

Not blockers, but they should exist first:

1. **A local secret-distribution story.** The app needs the platform realm's `hill90-ui`
   secret locally. Today there is no answer that is not "paste it into `.env.local`".
2. **A check that `local.sh`'s `STACKS` and `deploy.sh`'s live stacks agree**, or at
   least that a stack retired in production is named as retired locally. The two lists
   diverged silently and nothing noticed.
3. **`.env.local.example` validated against what the compose files actually read.**
   Hill90 has `scripts/checks/check_env_surface.py` for exactly this; this repo has no
   equivalent, which is why the missing `PLATFORM_DB_*` keys went unnoticed through
   three merges.

Item 3 would have caught this week's breakage on the PR that introduced it. It is
cheap, it is independent of the parity decision, and it is the highest-value thing on
this page after fixing the breakage itself.
