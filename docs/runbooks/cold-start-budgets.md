# Cold start: which healthchecks survive an empty database

**A healthcheck budget chosen against a warm start is a defect that only appears
once, on the day you can least afford it.** This page records what every service
actually takes from nothing, measured, so the next person changing a
`start_period` has a number to argue with instead of an instinct.

`Measured 2026-07-31` on an Apple Silicon laptop, tenant path, volumes destroyed
between runs (`./scripts/local.sh reset`).

## How the budget works

Docker does not fail a container the moment a probe fails. The usable budget is:

```
start_period  +  interval x retries
```

During `start_period` a failing probe does not count toward `retries`. After it,
`retries` consecutive failures mark the container `unhealthy`.

That matters because **`unhealthy` is not just cosmetic**: any service declaring
`depends_on: { condition: service_healthy }` will refuse to start, and
`docker compose up` aborts. In this repo two dependencies are of that kind:

| Waiter | Waits on |
|---|---|
| `ai` | `litellm` |
| `api` | `docker-proxy` |

## Measured cold starts — tenant path

Time from container start to first healthy probe, with empty volumes.

| Service | Measured | Budget | Margin |
|---|---|---|---|
| `docker-proxy` | 11s | 100s | 89s |
| `app-postgres` | 32s | 50s | **18s — thinnest** |
| `app-minio` | 37s | 90s | 53s |
| `ui` | 42s | 90s | 48s |
| `api` | 42s | 90s | 48s |
| `knowledge` | 49s | 100s | 51s |
| `mcp` | 50s | 90s | 40s |
| `litellm` | **96s / 172s** | 390s | ample |
| `app-keycloak` | 127s | 240s | 113s |

`ai` is not listed because it does not start until `litellm` is healthy, so its
own clock begins late; it was healthy about 5s after starting.

### Why litellm has two numbers

**172s on a truly first run, 96s on a later one.** The difference is the prisma
query engine download, which the first run does and later runs find cached. Both
are cold-database runs; only one is a cold *image* run.

That spread is the whole lesson. Against the old budget of `15 + 30x3 = 105s`,
the 96s run would have **passed** and the 172s run **failed** — the same defect
present or absent depending on a layer cache. A defect that heals itself before
anyone looks is the hardest kind to find.

### `app-postgres` is the thinnest margin, and is deliberately not changed

32s measured against a 50s budget. It has never failed, nothing in the tenant
path gates on it being healthy, and in production the service is retired. Raising
it on the strength of one machine's measurement is exactly how a real slowdown
gets hidden — the number would grow to cover a problem instead of surfacing it.
**Recorded, not padded.** If it ever does flip, this table is the baseline to
compare against.

## The case that exposes all of this: a rebuild

Production's `hill90_litellm` database has 55 tables. The migrations are long
applied, so litellm binds in seconds and nothing ever looked wrong — which is
precisely why `start_period: 15s` survived in
`deploy/compose/prod/docker-compose.ai.yml`, the **production** file, with no
local override softening it.

**A VPS rebuild starts from empty volumes by definition.** Hill90's rebuild
runbook takes a snapshot as rollback and then redeploys from git; it does not
restore database volumes. So the first app deploy onto a rebuilt host is a cold
start with an empty `hill90_litellm`, litellm takes minutes, and — before #77 —
`app-ai` would have refused to start and the deploy would have failed.

Two consequences worth keeping straight:

1. **Fixed at the source.** `main` now carries `start_period: 300s`, so a rebuild
   today deploys the corrected value.
2. **Production is still running the old one.** The value is baked into a
   container at creation time, and the currently-running `app-litellm` reports
   `StartPeriod: 15s`. It is harmless while the database stays migrated, and it
   is corrected by the next `ai` deploy. Nothing needs doing urgently; it should
   just not be mistaken for already-fixed on the host.

> Hill90's `docs/runbooks/vps-rebuild.md` should link here, since the rebuild is
> the path that exposes cold-start budgets and the app is deployed after it. That
> edit belongs in the platform repo.

## Before changing a start_period

1. Reproduce from nothing — `./scripts/local.sh reset && ./scripts/local.sh up`.
   A restart proves nothing; the database is already migrated.
2. Read the real number:
   `docker inspect <c> --format '{{json .State.Health.Log}}'` — the log keeps
   only the last five probes, so capture it while the stack is still starting.
3. Set the budget from the **slow** measurement, not the median, and say in a
   comment which run the number came from.
4. Never raise `interval` or `retries` to buy time. Those govern how fast a
   genuinely dead service is noticed. `start_period` is the one that means
   "still doing one-time work".
