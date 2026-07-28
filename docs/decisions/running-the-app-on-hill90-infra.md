# Running hill90-app on Hill90's Infrastructure

**Status:** local run proven; naming scheme decided (reversible); prod override layer open
**Audited:** 2026-07-27 by adversarial subagent review; corrections folded in below
**Recorded:** 2026-07-27

## Context

The app is a **tenant** of Hill90, not a peer. `deploy/compose/prod/*.yml`
declare `hill90_edge` and `hill90_internal` as `external: true`; Hill90's
`docker-compose.infra.yml` creates them. Nothing in this repo starts until
Hill90's infra is up. See [infra-app-separation](infra-app-separation.md) and
[RESURRECTION.md](../../RESURRECTION.md) §2.

The goal is: app running locally, then on the VPS, then documented. This record
captures the verification pass that preceded any change, because several
starting assumptions turned out to be wrong and the corrections are
load-bearing for the work that follows.

Everything below was verified by running a command on 2026-07-27. Where
something is inferred rather than observed, it says so.

## Phase 0 findings

### Hill90 local infra is up; one container is unhealthy by design

`scripts/local.sh health` in the Hill90 repo reports "All local checks passed"
— routed surfaces (Traefik, Portainer, Grafana, Prometheus), observability
internals, Postgres, and Keycloak OIDC discovery all pass.

But `scripts/local.sh status` shows `hill90dev-openbao (unhealthy)`. The health
script treats OpenBao's uninitialized state as informational (`i OpenBao state
— uninitialized`) while Docker's healthcheck treats it as a failure. So "13
containers, 0 unhealthy" is **not** true locally. Vault work is explicitly out
of scope (Hill90 #547/#536), so this is recorded, not fixed.

13 `hill90dev-*` containers run, plus `hill90dev-openbao-init` exited 0.

### The networks that exist locally are not the ones the app asks for

Hill90 parameterises its network names; the app hardcodes them.

```yaml
# Hill90 deploy/compose/prod/docker-compose.infra.yml
name: ${NETWORK_PREFIX:-hill90}_edge
```

```yaml
# hill90-app deploy/compose/prod/docker-compose.api.yml
external: true
name: hill90_edge
```

Locally `NETWORK_PREFIX=hill90dev` (set in Hill90's `.env.local.example:185`),
so `docker network ls` shows `hill90dev_edge`, `hill90dev_internal`,
`hill90dev_agent_internal`. There is no `hill90_edge` locally.

Nine app compose files hardcode the unparameterised names: `ai`, `api`, `auth`,
`db`, `discord-bot`, `knowledge`, `mcp`, `minio`, `ui`.

The intended fix is the **same parameterisation, not a hardcoded local name**,
so one set of files works in both places. On the VPS `NETWORK_PREFIX` is unset
and resolves to `hill90_edge`, which is confirmed to exist there — so prod is
unaffected.

**Not yet reproduced by running.** Phase 1 brings the app up on the prod
compose files and reads the actual error before this is changed.

### VPS baseline, captured before any change

Break-glass `ssh -i ~/.ssh/remote.hill90.com deploy@100.88.29.112` works
without DNS. Host `srv1264324.hstgr.cloud`.

- 13 containers, **0 unhealthy**
- networks `hill90_edge`, `hill90_internal`, `hill90_agent_internal` all present
- unlike local, `openbao` there is `Up 5 hours (healthy)`

This is the baseline to re-verify after every VPS action.

### RESURRECTION.md's "FIXED" items are genuinely fixed

Checked against the tree rather than taken on trust:

| Claim | Verified |
|---|---|
| §1 `deploy/compose/dev/` deleted | only `prod/` remains under `deploy/compose/` |
| §4 local realm derived, not edited | `compose/local/keycloak/realm-local.json` exists |
| §5 `init.sh` mode fixed | `100755` in git |
| §5 migration 046 duplicate assignment fixed | one `scope = EXCLUDED.scope` |
| §5 migration counts | 65 API, 12 knowledge |
| §8 CI gated | `.github/workflows/ci.yml` is `workflow_dispatch:` only |

## Correction: both provision scripts die before doing anything

The prior understanding was that `scripts/provision-akm-db.sh` fails silently —
that it pipes a heredoc into `docker exec` without `-i`, so it produces nothing
and no error.

That is not what happens. **`scripts/_common.sh` does not exist anywhere in the
app repo, tracked or untracked — it was never extracted.** Both provision
scripts `source` it at line 7 under `set -e`, so both die there, loudly and
non-zero:

```
$ bash scripts/provision-akm-db.sh
scripts/provision-akm-db.sh: line 7: .../scripts/_common.sh: No such file or directory
exit: 1
```

The loud failure **masks the quiet missing `-i`**, which is real but secondary
and only in that one script — `provision-litellm-db.sh:15` already has
`docker exec -i`. Fixing the `-i` alone would leave both scripts still dead at
line 7.

So: two bugs, in this order. Missing `_common.sh` (fatal, both scripts) and
missing `-i` (silent, akm only).

## Correction: Hill90's Postgres cannot host the app's databases as written

Hill90's Postgres has exactly one role, and it is not `postgres`:

```
POSTGRES_USER=hill90
roles:     hill90 (Superuser, Create role, Create DB, Replication, Bypass RLS)
databases: hill90, keycloak, postgres, template0, template1
```

Consequences, all observed:

- Both provision scripts hardcode `--username postgres`, which fails outright:
  `FATAL: role "postgres" does not exist`.
- Both hardcode `docker exec postgres`. That is the prod container name; the
  local one is `hill90dev-postgres`.
- None of `hill90_api`, `hill90_akm`, `hill90_litellm` exist there.

And the boundary is deliberate, not an oversight. Hill90's own health check
asserts:

```
✓ Platform-only databases (only postgres, keycloak and the owner role's database)
```

That check is written to **fail** if anything creates app databases in Hill90's
Postgres.

**Therefore: strong evidence the app keeps its own Postgres.** This is not the
final dedup decision — Keycloak and MinIO are being evaluated separately, and
the three do not have to move together. But the Postgres half should not be
deduplicated into Hill90 on the assumption that a shared platform Postgres is
the intent. It is not.

## Decisions taken so far

1. **Build the local override layer before bringing the app up**, then bring it
   up on the prod compose files. Phase 1 as originally scoped ("bring the app up
   locally") was incoherent: `compose/local.yml:20` declares
   `default: name: hill90_local`, not external, so the existing local path
   creates its own network and never touches Hill90's. Running it proves nothing
   about the path prod uses. There is no artifact today that brings the app up
   against Hill90's networks. Merging the two phases is the order the dependency
   actually runs in, and it means every fix lands in the file prod also uses
   rather than in a fork that will drift again.

2. **Validate Traefik and routing locally, not on the VPS.**
   `hill90dev-traefik` is running and Hill90 ships `platform/edge/traefik.local.yml`,
   so there is a local edge. The 37 `traefik.*` labels across
   `deploy/compose/prod/*.yml` (ai 7, auth 6, mcp 6, ui 6, minio 6, api 5,
   knowledge 1) can be exercised locally with the VPS untouched. Deferring this
   to the VPS phase would only mean finding the same problems somewhere far more
   expensive to fix.

3. **Record the dedup reasoning rather than forcing the dedup.** If Hill90's
   platform services cannot serve what the app needs, the app keeping its own
   copy is a legitimate outcome. Hill90's realm was provisioned for infra admin
   SSO, not for this app.

## Phase 1 findings

### The missing-network failure, reproduced

Against the prod compose files, with no override:

```
$ docker compose -f docker-compose.api.yml --env-file .env.example create --dry-run
...
network hill90_edge declared as external, but could not be found
```

Confirmed as predicted, including that the error names the network rather than
the naming mismatch that caused it.

Two things to note about that command. `--dry-run` exited **0** despite
printing the failure, so any scripted check built on it would report success —
do not gate on its exit code. And the dry run built the api image, so it is not
as cheap as the name suggests.

### Five networks need parameterising, not two

The prior understanding named `hill90_edge` and `hill90_internal`. There are
**five distinct network names across 23 literals** in nine prod compose files:

| Network | Owner | Files |
|---|---|---|
| `hill90_edge` | Hill90 infra (external) | ai, api, auth, knowledge, mcp, minio, ui |
| `hill90_internal` | Hill90 infra (external) | ai, api, auth, db, discord-bot, knowledge, mcp, minio, ui |
| `hill90_agent_internal` | Hill90 infra (external) | ai, api, knowledge |
| `hill90_agent_sandbox` | **the app** — created by api (`driver: bridge`, `internal: true`), consumed as external by ai and knowledge | ai, api, knowledge |
| `hill90_docker_proxy` | **the app** — created by api only | api |

The two app-owned networks need parameterising as well as the three external
ones. Left hardcoded, a local run creates `hill90_agent_sandbox` alongside
Hill90's `hill90dev_*` naming, and `services/api` attaches agent containers by
name — so agents would land on the wrong network. That the api stack is the
sole creator of the sandbox network also means api must start before ai and
knowledge, as [RESURRECTION.md](../../RESURRECTION.md) §2 states.

### Correction: a working override layer already exists

The prior understanding was that the app has no local overrides, only a
`compose/local*.yml` fork. That is wrong. **`compose/local.infra.yml` is an
opt-in overlay that already attaches the app to a locally-running Hill90 infra
stack**, added in `e881873` (#4) and fixed in `49b2b56` (#5). It already:

- parameterises all four networks it touches as `${NETWORK_PREFIX:-hill90}_*`
- adds Traefik labels for minio, keycloak, api, mcp and ui, and keeps `ai` and
  `knowledge` internal-only as production has them
- handles the no-egress `internal` network by also attaching to `edge`
- handles the browser-vs-container issuer split via `KEYCLOAK_INTERNAL_ISSUER`
- passes `AGENT_NETWORK_PREFIX` so `services/api` attaches agent containers
  under the infra prefix
- declares the `mcp-strip` middleware as a label, because Hill90 removed the
  file-based `mcp-strip@file` middleware as app-specific

`scripts/local.sh` supports `--infra` on any command, with a
`check_infra_networks` preflight.

So the local half is substantially further along than assumed, and the plan to
"build the minimal override layer" is wrong as stated — the layer exists.

**The structural criticism still stands, though, and is the real gap:** the
overlay layers on `compose/local.yml`, which is the fork, not on
`deploy/compose/prod/*.yml`. The prod files remain hardcoded and unexercised by
anything. Retargeting the existing overlay onto the prod files is the work, not
writing a new overlay.

### Stale `.env.local` breaks existing working directories, not fresh clones

`./scripts/local.sh up --infra` failed its preflight:

```
--infra needs the Hill90 infrastructure stack running locally, but these
networks do not exist:

  hill90local_edge
  hill90local_internal
  hill90local_agent_internal
```

Exit code 1, correctly. The preflight behaved well: it named the mismatch
rather than letting Docker emit a confusing one-network-at-a-time error.

Cause: `.env.local:57` said `NETWORK_PREFIX=hill90local`. Hill90 renamed its
local prefix to `hill90dev`, and `49b2b56` updated the generated template
accordingly — but that file's mtime is 72 minutes *before* that commit, and
`local.sh` only writes `.env.local` when it is absent. **So the fix reached
fresh clones and no existing working directory, with no warning.** This is the
inverse of the usual failure mode, and a concrete instance of the missing drift
check: Hill90's `local.sh status` catches exactly this with "structural
prefixes match the example".

Two follow-ups this implies, beyond the prefix itself:

- The app needs the drift check ported, and it needs to compare *values* of
  structural prefixes, not just presence of keys.
- `ev()` reads `.env.local` only, so a shell `NETWORK_PREFIX=...` does not
  affect the preflight, while `docker compose` *would* honour it over
  `--env-file`. Those two disagree. Not currently harmful because the preflight
  blocks first, but it is a trap.

## The name collision, which is the real form of the platform conflict

With the prefix corrected, `./scripts/local.sh up --infra` brought up eight of
nine containers. It created `hill90dev_agent_sandbox` with the correct prefix,
confirming the overlay's parameterisation works. Then:

```
Container hill90-keycloak  Error
dependency failed to start: container hill90-keycloak exited (1)
```

Keycloak's log:

```
FATAL: password authentication failed for user "hill90"
ERROR: Failed to obtain JDBC connection
```

That reads as a secrets problem. It is not. **Two containers answer to
`postgres` on the shared network:**

```
hill90-postgres     aliases=[hill90-postgres postgres]     ip=172.21.0.14
hill90dev-postgres  aliases=[hill90dev-postgres postgres]  ip=172.21.0.9

$ nslookup postgres      (from a peer on hill90dev_internal)
Name: postgres  Address: 172.21.0.9
Name: postgres  Address: 172.21.0.14
```

Both instances use role `hill90`; only the password differs. Keycloak resolved
to Hill90's instance and failed authentication. Because DNS returns **both**
addresses, this is non-deterministic — it will intermittently succeed, which is
the worst available failure mode.

This is the predicted "two Postgres instances fighting over names, ports and
networks, presenting as a dozen unrelated bugs", observed rather than predicted.

### It is worse in production, and it fails safe there

The app's prod compose sets `container_name:` on every service. Compared against
the 13 containers live on the VPS:

| App `container_name` | Collides with Hill90 on the VPS? |
|---|---|
| `keycloak` (auth) | **yes** |
| `postgres` (db) | **yes** |
| `postgres-exporter` (db) | **yes** |
| `litellm`, `ai`, `api`, `ui`, `mcp`, `minio`, `knowledge`, `docker-proxy`, `discord-bot` | no |

Docker refuses to start a second container with an existing name, so deploying
the app's `auth` or `db` stack to the VPS **cannot start at all**. That is a
blocker, but it fails safe: it cannot corrupt the running infra. Locally the
same conflict is *not* safe, because Compose only aliases rather than refusing,
and the ambiguity is silent.

Hill90's local stack stayed green throughout (`local.sh health` all passing),
because its services already held established connections. The exposure is on
restart. The app stack was taken down with `down` (volumes preserved) to stop
polluting the shared network, and `postgres` now resolves to `172.21.0.9` only.

## Decision: the app keeps its own platform services, renamed

The starting expectation was that the app should consume Hill90's platform
services and delete its copies. **The evidence points the other way for every
one of them.**

### Postgres — app keeps its own

- Hill90's Postgres has one role, `hill90`, with a different password; the app's
  `--username postgres` fails outright.
- Hill90's health check asserts *platform-only databases*. It is written to fail
  if app databases appear there. That is a designed boundary.
- `container_name: postgres` collides on the VPS; the network alias collides
  locally.

### Keycloak — app keeps its own

Hill90's Keycloak cannot serve this app as provisioned. Probed live from a
network peer:

```
realm platform  -> HTTP 200
realm hill90    -> HTTP 404
realm master    -> HTTP 200
```

Hill90 declares one realm, `platform`. Its static import
(`platform/auth/keycloak/platform-realm.json`) contains only the `hill90-vault`
client, but that is not the whole picture: `Hill90/scripts/keycloak.sh:278-290`
creates `grafana`, `portainer` and `hill90-vault` at runtime. All three are infra
admin SSO; none is an app client. An earlier version of this record said the
`platform` realm's "sole client is hill90-vault", which was read from the static
JSON and is wrong. The app requires
realm `hill90` with clients `hill90-ui` and `hill90-api`, plus its own login
theme. Adding an app realm to Hill90's Keycloak would break the same separation
boundary that the platform-only database check defends.

### MinIO — app keeps its own

No conflict at all: Hill90 runs no MinIO. Nothing to dedup.

### `postgres-exporter` — app keeps its own (this reverses an earlier call)

An earlier version of this record called this "the one genuine deletion", on the
grounds that Hill90 owns observability ([RESURRECTION.md](../../RESURRECTION.md)
§9) and already runs `postgres-exporter`.

**That was wrong,** and looking at the file before deleting it is what caught it.
Hill90's exporter is configured against Hill90's database. It cannot scrape the
app's. Deleting the app's copy would have silently ended all monitoring of the
app's Postgres — the failure would have been an absence of metrics, which nothing
alerts on.

It is kept and renamed. Two real bugs surfaced in the process, in opposite
directions:

- its `DATA_SOURCE_URI` was `postgres:5432/hill90`, the bare name, which is
  Hill90's instance on the shared network — so it was scraping the wrong database
- Hill90's Prometheus targets `postgres-exporter:9187` **by name**
  (`platform/observability/prometheus/prometheus.yml:24`), so with both stacks up
  that target was ambiguous and Hill90's own metrics could have been served by the
  app's exporter

The observability *stack* is Hill90's; an exporter for the app's own database is
the app's. Those are different things, and conflating them is what produced the
wrong call.

### LiteLLM — stays

Unchanged from the original reasoning: it is the model router, an app concern.
No collision.

### What this decision requires

Keeping its own services is not sufficient on its own — the app must stop
claiming Hill90's names. Both `container_name` and the network alias have to be
distinct, in prod as well as locally, because the VPS collision is on the prod
files. The naming scheme and whether the app's data plane should sit on its own
network rather than `<prefix>_internal` are the open design questions; they are
deliberately not settled here, because that choice affects the prod files and
should be reviewed rather than decided at 3am.

## The app runs locally on Hill90's infra, and a login works

Nine containers healthy, the UI and API reachable through Hill90's Traefik, a
real login against the app's own Keycloak, and authenticated reads out of the
app's own Postgres.

```
$ docker ps --format '{{.Names}}\t{{.Status}}' | grep '^hill90-'
hill90-ai         Up (healthy)     hill90-mcp        Up (healthy)
hill90-api        Up (healthy)     hill90-minio      Up (healthy)
hill90-keycloak   Up (healthy)     hill90-postgres   Up (healthy)
hill90-knowledge  Up (healthy)     hill90-ui         Up (healthy)
hill90-litellm    Up (healthy)
```

Routed through Hill90's Traefik:

```
app.localtest.me:8080/          -> HTTP 200
storage.localtest.me:8080/      -> HTTP 200
app-auth.localtest.me:8080/     -> HTTP 302
api.localtest.me:8080/health    -> HTTP 200
```

Login, via the password grant against the browser-facing issuer:

```
token acquired, expires_in: 300
iss  : http://app-auth.localtest.me:8080/realms/hill90
user : dev
roles: ['admin', 'user']
```

And behind the login — a page rendering is not a login, and a login is not a
working app until something behind it does work:

```
GET /me               -> 200   validated claims, iss matches
GET /agents           -> 200   []
GET /agents/templates -> 200   [{"id":"code-assistant","name":"Code Assistant",...
GET /health/detailed  -> 200   "database":{"status":"connected","latency_ms":1}

GET /me      (no token) -> 401
GET /agents  (no token) -> 401
```

`/agents/templates` is real seeded data out of the app's own Postgres, so
migrations applied and reads work. The 401s confirm auth is enforced rather than
bypassed.

Hill90 stayed green throughout, including its platform-only-databases check, so
the boundary held. The VPS was not touched in this phase and rechecked at 13
containers, 0 unhealthy.

## What it took: four naming collisions, not one

Each was found by running, and each presented as something other than a naming
problem.

| Collision | Symptom | Fix |
|---|---|---|
| `postgres` alias on `<prefix>_internal` | Keycloak died with `password authentication failed for user "hill90"` — a secrets-looking error | the app's **Postgres container** moved to a new app-owned `<prefix>_app_internal`. Its consumers stayed dual-homed — see the correction below |
| `keycloak` alias on `<prefix>_edge` | app services resolved `keycloak` to `172.18.0.6` = Hill90's Keycloak, so JWKS lookups hit realm `hill90` → 404 | app's Keycloak given an `app-keycloak` alias that exists only on `app_internal`; every app-internal URL uses it |
| `auth.<domain>` hostname | served Hill90's realm `platform` (200), app's realm `hill90` was 404 | app's Keycloak moved to `${APP_AUTH_HOST:-app-auth}` |
| Traefik router name `keycloak` | both stacks would register `keycloak@docker` | app's renamed to `app-keycloak` |

The `keycloak` edge collision is worth dwelling on: keeping the app's Keycloak
off the shared *internal* network was not sufficient, because Traefik lives on
edge and the app's Keycloak must be on edge to be routed at all. Compose cannot
remove a service-name alias, so the only fix is to stop relying on that name
internally.

`traefik.docker.network=${NETWORK_PREFIX:-hill90}_edge` was added to every routed
app service, mirroring Hill90's
`deploy/compose/overrides/local.observability.yml`. Its reasoning applies here:
the provider-wide default lives in Traefik's static config, which v2.11 cannot
interpolate, so it cannot follow `NETWORK_PREFIX`; the label can, and defaults to
`hill90_edge`, which is what production already pins.

## A fifth bug, in Hill90 rather than the app

Every app hostname returned 404 even with correct labels. Traefik's router table
held only Hill90's five routers — the app's were never registered.

`platform/edge/traefik.local.yml` constrains the Docker provider to an explicit
list of compose projects, and its own comment says:

> `hill90-local` is the app stack ... Without this clause its routers are
> dropped and every app hostname returns 404.

But the list contained `hill90-local-edge`, `hill90-local-observability`,
`hill90-local-identity`, `hill90-local-platform` and `hill90-local-db` — all
Hill90's own projects. The app's project is `hill90-local`, which was **not in
the list**. The comment asserted the app was covered; the constraint did not
cover it.

Fixed in the Hill90 repo on branch `fix/local-traefik-accept-app-routers` by
adding `hill90-local` to the constraint, which makes the code match the comment.
**That is a second repository and needs its own review** — the local stack here
depends on it, and without it every app hostname 404s again.

## Still open, for Jon

The naming scheme is a real decision and it was deliberately not settled alone.
The local overlay now uses `app_internal`, the `app-keycloak` alias and
`APP_AUTH_HOST`, which works, but:

- Production has the same collisions and they are *harder* there: `container_name`
  is set to `keycloak`, `postgres` and `postgres-exporter`, all of which exist on
  the VPS, and Docker refuses duplicate container names outright.
- `auth.hill90.com` is already Hill90's Keycloak in production, so the app needs
  its own public auth hostname there too — which affects the certificate work,
  since that hostname will need an HTTP-01 certificate of its own.

Whether the app's services should be prefixed (`app-*`), moved to a separate
namespace, or something else is a call worth making deliberately rather than
inferring from what made local go green.

## Retarget onto the prod files: networks done, override layer blocked

All 23 network literals across the nine prod compose files now use
`${NETWORK_PREFIX:-hill90}_*`, covering all five networks — including the two the
app owns (`agent_sandbox`, `docker_proxy`), which the original plan missed.

Verified to resolve correctly in both environments:

```
NETWORK_PREFIX unset (production)     NETWORK_PREFIX=hill90dev (local)
  edge   -> hill90_edge   [external]    edge   -> hill90dev_edge   [external]
  internal -> hill90_internal [ext]     internal -> hill90dev_internal [ext]
  agent_internal -> hill90_...  [ext]   agent_internal -> hill90dev_... [ext]
  agent_sandbox  -> hill90_...          agent_sandbox  -> hill90dev_...
  docker_proxy   -> hill90_...          docker_proxy   -> hill90dev_...
```

Production is unaffected: with the variable unset every name resolves exactly as
before.

And a prod compose file will now actually run locally. `docker-compose.minio.yml`
was brought up against Hill90's local networks — the one prod stack whose
`container_name` collides with nothing — and reached `healthy` attached to
`hill90dev_edge` and `hill90dev_internal`. The test stack was then removed with
its volume. So the retarget is feasible, not just plausible.

**The override layer itself is blocked, and deliberately so.** An override that
layers on the prod files has to say something about `container_name`, because
that is where the VPS collision lives — `keycloak`, `postgres` and
`postgres-exporter` are all names Hill90 already occupies there. Any override
written now would bake in an answer to the naming question that is explicitly
reserved for Jon. Writing it would mean choosing by default, which is exactly
what the local work was careful not to do.

What is not blocked, and is the next work once the naming scheme is settled:
`deploy/compose/overrides/local.*.yml` layering on the prod files, collapsing
`compose/` into that structure, committing `.env.local.example`, porting the
drift check, and bringing `local.sh` to parity with Hill90's (`health`, `urls`).

One merge subtlety found while verifying, not introduced here: with all nine prod
files merged at once, `agent_sandbox` resolves to `external: true`, because `ai`
and `knowledge` declare it external while only `api` creates it. Nothing then
creates it. Per-stack deploys (`make deploy-db` and friends) do not hit this, but
a single combined `up` would.

## Audit corrections (adversarial review, 2026-07-27)

An adversarial subagent audit was run against both branches. It found real
problems. They are folded in here rather than summarised away.

### The `postgres` collision is masked, not removed

Only the Postgres *container* moved to `app_internal`. Its eight consumers stayed
dual-homed on `<prefix>_internal`, so that network still answers to `postgres`
with Hill90's instance:

```
hill90-minio: postgres -> 172.21.0.9   (hill90dev-postgres, Hill90's)
hill90-api  : postgres -> 172.26.0.2   (the app's, 30/30 lookups)
REACHABLE: hill90-api -> 172.21.0.9:5432
```

Nothing is broken today, because `hill90-api` resolves to the app's instance
consistently. But that determinism comes from Docker's resolver preferring one
network, **not from the ambiguity being gone** — and the app can still open a TCP
session to Hill90's Postgres. `compose/local.infra.yml` states the correct
principle ("the only way ... is to keep them off `<prefix>_internal` entirely")
and then applies it to one of nine services. The earlier wording here, "app data
plane moved", was wrong: one container moved.

Properly fixing this means taking the app's services off `<prefix>_internal`
altogether, which is part of the deferred naming decision.

### The app now poisons `keycloak` for Hill90's own containers

The overlay comment says "`keycloak` stays ambiguous on edge; nothing internal
relies on it any more." That was checked for the app and is true of the app. **It
was never checked for Hill90.** From Hill90's containers:

```
hill90dev-openbao : keycloak -> 172.18.0.12   (the APP's Keycloak)
hill90dev-grafana : keycloak -> 172.18.0.12   (the APP's Keycloak)
hill90dev-traefik : keycloak -> 172.18.0.6    (Hill90's)
hill90-api, 30 lookups: 18x 172.18.0.12, 12x 172.18.0.6
```

It is latent only because Hill90's services reach Keycloak via `KC_PUBLIC_URL`
rather than the bare name. This record earlier leaned on "Hill90 stayed green
throughout ... so the boundary held" — that is not evidence for this, because
Hill90's health check probes `auth.localtest.me/realms/platform` and is
structurally incapable of detecting a poisoned `keycloak` alias. The same
skepticism applied to Postgres ("the exposure is on restart") was not applied
here, and should have been.

**So running the app alongside Hill90 locally degrades Hill90's DNS, today.**
Not fatally, and not detectably by Hill90's own checks.

### The Keycloak dedup conclusion is weaker than the Postgres one

Postgres has an enforced boundary: `✓ Platform-only databases` is a real check
that really fires. There is no realm equivalent — nothing in Hill90's
`scripts/local.sh`, `scripts/checks/` or `tests/` asserts anything about realms.
Its import is `start --import-realm` over `/opt/keycloak/data/import/`, one bind
mount per file, so **adding an app realm to Hill90's Keycloak is one volume
line.**

"Cannot serve this app as provisioned" is true. "Would break the same separation
boundary that the platform-only database check defends" is an argument about
intent presented with the same force as the Postgres evidence, and it should not
have been. The conclusion may still be right; its stated basis was overstated.

### "MinIO — nothing to dedup" is already false

Hill90 has an in-flight branch, `feat/restore-minio`, checked out as a worktree,
which restores MinIO to Hill90 with `container_name: ${CONTAINER_PREFIX:-}minio`
on both `<prefix>_edge` and `<prefix>_internal`, a `minio-console` Traefik router,
and `Host(${MINIO_HOST:-storage}.${BASE_DOMAIN})`. That is the same three
collision shapes again — alias, router name, hostname — against the one service
this record called conflict-free. The app's MinIO sits on both those networks
today.

**And that branch edits the identical line of `platform/edge/traefik.local.yml`**
that the fix branch here edits, appending `hill90-local-storage` where this
appends `hill90-local`. Those two branches will conflict on line 90.

### This branch carries an unrelated commit

`bbcc0dd chore: move issue tracking from Linear to GitHub Issues` is not on
`main` and is not part of this work; it also exists on its own unmerged branch
`chore/github-issues-tracking`. So this branch is **6 commits ahead, not 5**, and
cannot be merged without dragging that chore with it. It should be rebased off
before review.

### `NETWORK_PREFIX` is now a live variable in production compose

Before the parameterisation, prod network names could not be perturbed by the
environment. Now a shell `NETWORK_PREFIX` takes precedence over `--env-file`, and
both repos share a deploy user on the VPS where Hill90's tooling does set that
variable. This is a **risk flagged, not a defect proven** — confirming it needs
VPS inspection, which was out of scope for this phase.

### What the audit confirmed, including one thing understated here

- "Production is unaffected" **holds**, and is the most strongly verified claim on
  the branch. All ten prod files were resolved under both `main` and `HEAD` with
  `NETWORK_PREFIX` unset and the full output diffed: the only differences are
  worktree paths in `build.context` and bind-mount `source`. No `container_name`,
  no `prod_postgres-data`, no existing `traefik.docker.network` value was touched.
- The Hill90 change **is** local-only. `docker-compose.infra.yml:61` mounts
  `${TRAEFIK_STATIC_CONFIG:-traefik.generated.yml}`; only `.env.local.example:59`
  points it at `traefik.local.yml`; `traefik.yml.tmpl` has no `constraints:` key.
- `app_internal` with `internal: true` is correct — nothing on it needs egress.
- **The browser login flow works, and this record understated it.** The audit ran
  the full authorization-code redirect flow: `/api/auth/csrf` → `POST
  /api/auth/signin/keycloak` → Keycloak form at `app-auth.localtest.me` → credentials
  → `302` callback → `302 /dashboard` → `authjs.session-token` set →
  `/api/auth/session` returns `{"user":{"name":"Local Developer","roles":["admin","user"]}}`.
  With `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, a token fetched over the internal
  `app-keycloak:8080` back-channel still stamps
  `iss = http://app-auth.localtest.me:8080/realms/hill90`, so Auth.js's issuer
  check passes. Only true browser specifics — JavaScript execution, SameSite under
  HTTPS — remain untested.

## Decision: the naming scheme (reversible — overrule freely)

Taken 2026-07-27 without Jon, on instruction not to block on it. Recorded with
the alternatives so it can be overruled rather than archaeologically reconstructed.

**Chosen: adopt Hill90's prefix mechanism verbatim, and add an `app-` tenant
component to the names that collide.**

```yaml
container_name: ${CONTAINER_PREFIX:-}app-<service>   # Hill90's exact convention
```

Concretely:

| Layer | Rule | Why |
|---|---|---|
| `container_name` | `${CONTAINER_PREFIX:-}app-<name>`, **all** services | Hill90 applies `${CONTAINER_PREFIX:-}` uniformly to all of its own; costs nothing and survives Hill90 later claiming a name |
| Service keys (= DNS aliases) | `app-` only where they collide: `app-postgres`, `app-keycloak`, `app-minio`, `app-postgres-exporter` | renaming a service key rewrites every internal URL, so blast radius is kept to the four that actually collide |
| Traefik router/service names | `app-<name>`, all | zero cost, and `keycloak` genuinely collided |
| Hostnames | app's Keycloak → `${APP_AUTH_HOST:-app-auth}`; others parameterised as `${X_HOST:-x}.${BASE_DOMAIN:-hill90.com}` | `auth.hill90.com` is Hill90's; the rest were hardcoded, which is its own bug |

Verified against the live VPS: **zero overlap** between the app's resolved
container names *and* service keys and Hill90's 13 running containers. Before
this, `keycloak`, `postgres` and `postgres-exporter` all collided outright.

`postgres-exporter` mattered more than expected. Hill90's Prometheus scrapes
`postgres-exporter:9187` **by name**
(`platform/observability/prometheus/prometheus.yml:24`), so with both stacks up
that target was ambiguous and Hill90's own database metrics could have come from
the app's exporter under Hill90's job label.

### Why not the alternatives

- **Uniform `app-` on every service key.** More robust — MinIO just proved Hill90
  can retroactively claim a name the app thought safe. Rejected because it
  rewrites roughly twenty internal URLs (`http://api:3000`, `http://ai:8000`,
  `http://mcp:8001`, …) across both repos' expectations for no present benefit.
  If Hill90 later claims one of those names, promote that single service; the
  mechanism is already in place.
- **Drop `container_name` entirely** and let the compose project namespace
  everything (`hill90-local-api-1`). Genuinely the most collision-proof option
  and needs no prefix at all. Rejected because it diverges from Hill90, and every
  runbook, `docker exec` and `docker logs` invocation in both repos assumes stable
  names.
- **Give the app its own prefix variable** (`APP_CONTAINER_PREFIX`). Rejected as
  a second mechanism for a job Hill90's existing one already does; two prefix
  variables that must agree is a new drift surface.
- **Consume Hill90's Keycloak and Postgres** so there is nothing to name. Ruled
  out earlier on evidence, though note the audit correction above: the Keycloak
  half of that is weaker than the Postgres half.

### Consequence that must be handled before the VPS phase

The app's Keycloak moves off `auth.hill90.com` to `app-auth.hill90.com`. There
are A records for `ai`, `api` and `auth` but **not** for `app-auth`, so that
hostname needs a new A record and its own HTTP-01 certificate. It is a public
host, so HTTP-01 applies and the unextracted `services/dns-manager` is not
involved. **This is a blocker for deploying the auth stack, and it is new work
created by this decision** — the alternative was leaving a collision that Docker
would refuse to start.

## What the app needs from the Hill90 lane

Not edited here. Both are in the Hill90 repo:

1. **`platform/edge/traefik.local.yml:90`** — the Docker provider constraint must
   include the app's compose project `hill90-local`. The currently running config
   already contains it alongside `hill90-local-storage`; the PR must keep **both**.
   Taking one side resolves the conflict silently and 404s the other stack.
   Traefik needs a **restart**, not a reload — it is static config.
2. **`platform/observability/prometheus/prometheus.yml`** — a scrape job for
   `app-postgres-exporter:9187`. Hill90's existing job targets
   `postgres-exporter`, which the app no longer answers to by design, so the
   app's database is currently unmonitored.

## Known-unverified

- No real browser was used. The Mac is locked, so headed Playwright is
  unavailable. The redirect flow *was* exercised with curl end to end, including
  the session cookie and `/api/auth/session` (see the audit section), so this is
  considerably better than "unverified" — but JavaScript execution and SameSite
  cookie behaviour under HTTPS are still untested.
- `/agents` returned `[]`. Nothing has been created through the app, so agent
  creation, the agentbox runtime and the model router are unexercised.
- The prod compose files remain hardcoded and unexercised. Everything proven
  above was proven through `compose/local.yml` plus the overlay — the fork, not
  the path production uses.
- Whether the existing overlay can be retargeted onto the prod compose files
  without a rewrite. `compose/local.yml` and `deploy/compose/prod/*.yml` differ
  in service naming and volumes, not just networks, so this is asserted from
  reading, not tested.
- Whether MinIO has the app's buckets is not yet checked. Moot for the dedup
  decision, since the app keeps its own MinIO.
- `traefik.docker.network` is expected to need setting explicitly, because it
  does not follow `NETWORK_PREFIX` — Hill90's own
  `deploy/compose/overrides/local.observability.yml:21,45` sets it for exactly
  this reason. Expected, not yet confirmed for this repo.
- Hill90's `internal` network is `internal: true` (no egress), so anything
  needing outbound must also sit on `edge`. Documented in
  `compose/local.infra.yml:46-48`; not yet hit in this repo.
- Nothing about the VPS deployment path has been attempted. The app needs `ai`,
  `api` and `auth` hostnames; these have A records pointing at the VPS but no
  certificates. They are public hosts, so HTTP-01 applies rather than the DNS-01
  path that depended on the unextracted `services/dns-manager`.

---

# Phase A of the tenant deployment runbook

Executing `Hill90/docs/runbooks/tenant-app-deployment.md` §3 Phase A. No VPS
contact in this phase. Numbered to match the runbook.

## Step 1 — name collisions resolved, and the data-plane network decided

The naming scheme itself was settled earlier in this record. Verified against
Hill90's repository across **four** namespaces — the runbook names three, but the
fourth is where the dangerous one actually lives:

```
container names : app-ai app-api app-discord-bot app-docker-proxy app-keycloak
                  app-knowledge app-litellm app-mcp app-minio app-postgres app-ui
                  overlap with Hill90: none
traefik routers : app-api app-keycloak app-litellm app-mcp app-minio-console app-ui
                  overlap with Hill90: none
hostnames       : app's Keycloak on ${APP_AUTH_HOST:-app-auth}; Hill90 keeps auth
                  overlap with Hill90: none
service keys    : ai api app-keycloak app-minio app-postgres discord-bot
                  docker-proxy knowledge litellm mcp ui agentbox*
                  overlap with Hill90: none
```

**Service keys are the namespace that matters most and the runbook does not list
it.** Compose derives a network alias from the service key, not from
`container_name`, so renaming only the container would have left `postgres` and
`keycloak` ambiguous on the shared network — which is exactly risk §4.3.

### Decision: the app's data plane stays on `hill90_internal`

The runbook makes this an explicit open question. Decided: **keep it on the
shared internal network, do not give the app a private data network.**

Reasoning. Risk §4.3 is entirely a *name* collision — two containers answering to
`postgres` on one network, DNS returning both, Keycloak reaching the wrong one.
Renaming the service key to `app-postgres` removes that at the root: the alias is
now unique, so there is nothing to resolve ambiguously. A private network would be
a second, independent fix for a cause already eliminated.

Rejected alternative: a dedicated `${NETWORK_PREFIX:-hill90}_app_internal` with
`internal: true`, which is what the *local overlay* on `compose/local.yml` does.
It was necessary there because that path never renamed its service keys, so the
alias really was ambiguous. It is not necessary here, and it would cost a fourth
network to maintain, an extra attachment on five services, and a divergence
between the local overlay and the production topology — the divergence this whole
effort exists to remove.

Residual risk, stated: if Hill90 ever introduces a service named `app-postgres`,
the collision returns. That is implausible, because `app-` is the tenant's
namespace by construction — but it is the assumption this decision rests on, and
MinIO already demonstrated that Hill90 can retroactively claim a name the app
believed was safe.

### `postgres-exporter` deleted — and what that costs

Deleted per the runbook, reversing an earlier decision in this record. Hill90 owns
observability and already runs an exporter.

**The cost is real and is not hypothetical.** Hill90's exporter is single-target:

```
DATA_SOURCE_URI=postgres:5432/hill90?sslmode=disable
```

It scrapes Hill90's database and cannot reach the app's. So **the app's database
now has no metrics at all.** Hill90's Prometheus has one `postgres-exporter` job
targeting `postgres-exporter:9187`.

The fix, when someone wants app database metrics back, is on Hill90's side and is
small: `postgres-exporter` v0.17.1 supports multi-target scraping via
`/probe?target=`, so one exporter can cover both databases with a scrape config
change and no second container. That is the right shape and it keeps observability
in the repo that owns it. Recorded here so the gap is a known trade rather than a
discovery.

## Step 2 — `mcp-strip` fixed

`docker-compose.mcp.yml` referenced `mcp-strip@file`, which Hill90 does not
define — it removed the middleware in JON-27 as app-specific, correctly, since
only this service used it.

This does not degrade. A router naming an undefined middleware is **errored by
Traefik and serves nothing**, so this would have been a total outage of the MCP
gateway with no obvious cause. It is declared as a label instead, which is also
the right ownership boundary: prefix-stripping for `/mcp` is an app routing
concern.

Runbook verify criterion — "the prod compose has no `@file` reference Hill90 does
not define":

```
app references : rate-limit@file  tailscale-only@file
Hill90 defines : auth@file compress@file cors@file rate-limit@file
                 security-headers@file tailscale-only@file
undefined      : none
```

The runbook said the app referenced three and two existed. That is now two and
two.
