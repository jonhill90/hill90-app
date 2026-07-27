# Running hill90-app on Hill90's Infrastructure

**Status:** in progress — Phase 0 (verification) complete, Phase 1 not started
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

## Known-unverified

- The missing-network error has not been reproduced by running. It is inferred
  from reading nine compose files and `docker network ls`.
- Whether Hill90's Keycloak realm exposes the clients the app needs
  (`hill90-ui`, `hill90-api`) is not yet checked. OIDC discovery returns 200;
  that says the realm exists, not that it fits.
- Whether MinIO has the app's buckets is not yet checked.
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
