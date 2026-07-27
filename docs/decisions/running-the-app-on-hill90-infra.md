# Running hill90-app on Hill90's Infrastructure

**Status:** in progress — Phase 0 complete, Phase 1 under way
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

Hill90 declares exactly one realm, `platform`
(`platform/auth/keycloak/platform-realm.json`), whose sole client is
`hill90-vault` — that is OpenBao UI SSO, i.e. infra admin SSO. The app requires
realm `hill90` with clients `hill90-ui` and `hill90-api`, plus its own login
theme. Adding an app realm to Hill90's Keycloak would break the same separation
boundary that the platform-only database check defends.

### MinIO — app keeps its own

No conflict at all: Hill90 runs no MinIO. Nothing to dedup.

### `postgres-exporter` — the app should drop its copy

This is the one genuine deletion. Hill90 owns observability
([RESURRECTION.md](../../RESURRECTION.md) §9) and already runs
`postgres-exporter`. The app's copy in `docker-compose.db.yml` is a pure
duplicate of an infra concern.

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

## Known-unverified

- Whether the app serves traffic end to end. Eight of nine containers started;
  the UI never started because Keycloak blocked it. **No routed surface of the
  app has been reached, no login has been performed.** Nothing about the app
  working is proven yet.
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
