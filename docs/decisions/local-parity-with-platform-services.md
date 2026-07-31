# Local parity: should local run against the platform services too?

**Status: OPEN — this is a scope, not a change.** Nothing here has been converted, and
nothing should be until Jon picks an option. Every claim below was measured on
2026-07-31 and is dated, because the thing that makes this decision hard is that the
local stack's real state and its documented state have already drifted apart once.

**Related:** [running-the-app-on-hill90-infra.md](running-the-app-on-hill90-infra.md),
`RESURRECTION.md` §2, Hill90's
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
   it inherits the production default and no local override replaces it. **There is no
   `hill90dev-minio` container on this machine at all.** Hill90's local `up` does not
   start its MinIO stack.
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
- **`hill90dev-minio` does not exist.** Hill90's local `up` does not start its MinIO
  stack. This is the only platform dependency with nothing behind it locally.

---

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
- The local platform realm needs the app's redirect URIs (`http://localhost:13000/...`,
  `http://app.localtest.me:8080/...`). Hill90's `keycloak.sh tenant-clients` is the right
  place — this repo must not write to Hill90's realm directly.
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

### MinIO — blocked on something outside this repo

Nothing to point at: **Hill90's local stack does not run MinIO.** Parity here needs
Hill90's `local.sh` to start its MinIO stack by default, plus a local
`tenant-hill90-app` credential. Both are Hill90 changes, not this repo's.

Note this is *already* half-done by accident and in the wrong direction:
`MINIO_ENDPOINT` renders as `http://minio:9000` locally today, pointing at a container
that does not exist, because no local override replaces the production default.

**Risk: medium, and the dependency is external.**

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
| **D** | C, plus MinIO (needs a Hill90 change first) | +1 day, blocked | Medium | Full |

**Recommendation: A now, separately and immediately. Then B. Hold C until the local
secret-distribution question is answered, and D until Hill90's local stack runs MinIO.**

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
