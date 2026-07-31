# Retiring app-postgres

Date: 2026-07-31. Companion to [retiring-app-keycloak.md](retiring-app-keycloak.md),
which retired the other half of the duplicated infrastructure the day before.

app-postgres was stopped and removed from the VPS. All four database-using services
read Hill90's platform Postgres as the tenant role `hill90_app`. The data volume was
deliberately kept.

## What was actually removed, and what was not

REMOVED: the container `app-postgres` (`pgvector/pgvector:pg16`), via `docker rm`
without `-v`.

KEPT, deliberately: the volume `prod_app-postgres-data`, 103MB, verified present
after removal. It holds all five databases including `keycloak`, and therefore holds
realm hill90 and its three users — the realm that
[retiring-app-keycloak.md](retiring-app-keycloak.md) explicitly said would outlive
that retirement. It stays until it has been unused for a day, and deleting it is a
separate decision that should be taken on purpose, not as tidy-up.

KEPT, also deliberately: `deploy/compose/prod/docker-compose.db.yml`. Local
development still runs the app's own Postgres — `scripts/local.sh` has its own
`STACKS="db auth api ai knowledge mcp minio ui"` and layers
`deploy/compose/overrides/local.db.yml` on the production file. Deleting the prod
file to "finish" the retirement would break local and gain nothing in production,
where the deploy path is now closed instead. The file carries a retirement banner.

NOT A CUTOVER. This is worth stating because the task that produced this record was
framed as one. The cutover already happened, in #51 plus pipeline deploys of
knowledge, api and ai; by the time this work started the app had zero connections to
app-postgres and the platform databases were populated. What remained was retirement
only. Anything describing app-postgres as still the app's data path is stale.

## The backup, and the fact that it was restored

`/opt/hill90/backups/app-postgres-final/20260730_000432/` on the VPS, mode 0600 in a
0700 directory, not moved off the box — the `keycloak` dump contains password hashes
and client secrets.

Five per-database dumps in custom format (`pg_dump -Fc --no-owner --no-privileges`),
plus `globals.sql` from `pg_dumpall --globals-only --no-role-passwords`, plus a
metadata note recording the retired container's image and volume.

A dump that has not been restored is not a backup, so it was restored. Into a
throwaway `pgvector/pgvector:pg16` container on `--network none`, never into the
platform Postgres. Every database restored with `pg_restore` exit 0 and zero
diagnostics, and row counts were compared PER TABLE against the source:

| database | tables | rows | restore |
|---|---|---|---|
| hill90 | 0 | 0 | identical (genuinely empty — no schema, no tables) |
| hill90_akm | 14 | 12 | identical |
| hill90_api | 32 | 105 | identical |
| hill90_litellm | 47 | 77 | identical |
| keycloak | 89 | 1568 | identical |

Counts are exact, from `query_to_xml` per relation, not `n_live_tup` estimates —
estimates are what earlier notes in this repo used, and they disagree slightly with
the truth (`hill90_akm` reads 13 as an estimate and 12 exactly).

The restored `keycloak` database was opened rather than merely counted: realms
`master` and `hill90`, and 3 users in realm hill90. That is what makes it a restore
rather than a schema.

The comparison was then PROVEN CAPABLE OF FAILING, because a passing `diff` over
files that could both be empty proves nothing. Deleting a single row from
`user_attribute` in the throwaway produced exactly the expected red
(`public.user_attribute 1` → `0`). A first attempt at this negative control used
`user_entity` and was rejected by a foreign key, so nothing was deleted and the
check reported "no difference" — which for a moment read as the check being vacuous
when in fact the control was.

## Why removal was safe, verified before rather than asserted after

Zero client backends on app-postgres. That check was itself validated first, because
an earlier hand-run probe of `pg_stat_activity` had returned an empty string rather
than a number and an untrustworthy check is worse than none: a deliberate `psql`
session was opened, the counter returned `1`, the session was terminated, and the
counter returned `0`. It counts.

No running container named app-postgres anywhere in its environment. The four
database consumers all name the platform host: app-api and app-ai `hill90_api`,
app-litellm `hill90_litellm`, app-knowledge `hill90_akm` (via `AKM_DATABASE_URL`,
not `DATABASE_URL` — a name-specific grep would have missed it, which is why the
check was written against the whole environment).

app-keycloak, the sole remaining consumer when this work began, had already been
retired the previous day. Retiring app-postgres before that would have broken it.

## That it serves from the platform is measured, not assumed

Container health proves nothing here, so traffic was attributed from the database
side. 20 real HTTPS requests to `api.hill90.com/health/detailed`, a public route
that issues a query through the app's own pool, moved platform `hill90_api` forward
by 7 commits and 806 returned tuples while app-postgres's counters stayed
bit-identical at zero client backends. Fresh backends appeared on platform
`hill90_api` from app-api's address with a `backend_start` timestamp inside the test
window.

The decisive test is removal itself: with app-postgres first STOPPED and then
REMOVED, the app kept answering 200 on `hill90.com`, `hill90.com/api/health`,
`hill90.com/api/services/health`, `api.hill90.com/health` and
`api.hill90.com/health/detailed`, reported `database: connected, latency_ms 1`, and
platform commits kept rising (+51 across the post-removal check). If anything had
still been reading app-postgres, taking it away would have broken it.

One honest limit. No credentialed, row-returning endpoint was exercised, because
every such route requires the `user` role and the SOPS age key for `testuser01` is
not on the machine this ran from; moving that credential around to satisfy a test
was the worse option. The counts the public route does expose (`agents`, `threads`,
`workflows`) are all 0 in BOTH databases, so they do not discriminate between them.
The traffic attribution and the serve-after-removal result do.

## What stops it coming back

`db` is removed from `DEPLOY_REST`, so `deploy all` cannot recreate it. That was the
live risk: the stack was still in the deploy order after the container was gone, and
recreating it would have SUCCEEDED — compose happy, healthcheck green, a second
Postgres running that nothing reads. Nothing would have broken loudly.

`deploy db` now refuses via `refuse_if_retired`, naming the date, this record, the
backup location and the fact that the volume survived.

That guard runs FIRST, before the deploy banner and before `cmd_preflight`. This
corrects the auth retirement as well, which had the refusal after preflight: on any
machine without Hill90's networks, `deploy auth` died with "Hill90's shared networks
are missing" and never reached the retirement notice. A retirement that presents as
a platform outage invites the operator to bring the networks up and retry, which is
exactly the path that recreates what was retired.

`tests/scripts/retired-stacks.bats` covers both stacks. It asserts the refusal fires
before preflight, refuses to pass on a bare grep for "RETIRED" (the stack summary
line contains that word, which is how the weaker version of this test passed while
the auth refusal was unreachable), and guards against the vacuous case where
`DEPLOY_REST` parses as empty and every "does not contain" assertion succeeds for the
wrong reason. Neutering `refuse_if_retired` turns tests 4, 5 and 6 red.

## Corrections to earlier documentation

`docker-compose.db.yml` justified a second Postgres on the grounds that the platform
instance asserts platform-only databases and offers only the role `hill90`. That was
true when written and is now false: the platform grew the tenant role `hill90_app`
(NOSUPERUSER) with per-database grants. The banner records the correction, because
that claim was the entire reason this container existed.

The same file noted that the app's database had no metrics. Half true now, stated
precisely in the file: Hill90's exporter connects to `postgres:5432/hill90` (verified
2026-07-31), and cluster-wide `pg_stat_database` is visible from any database, so the
app's databases ARE scraped at database level; per-table statistics are not, because
`pg_stat_user_tables` is per-database.

`docker-compose.api.yml` said `DB_USER`/`DB_PASSWORD` are not reused because
"app-postgres and app-keycloak still consume them". Both are retired in production;
their only remaining consumer is local development.

## Reversing it

`docker run` the image against the surviving volume, or restore the dumps. The volume
is the faster path and loses nothing; the dumps are the insurance if the volume is
ever removed. Recreating the container via compose requires deliberately overriding
the refusal, which is the point.

## Still outstanding

The volume `prod_app-postgres-data` is scheduled for review after a day unused, no
earlier than 2026-08-01. `scripts/provision-akm-db.sh` and
`scripts/provision-litellm-db.sh` still default `PG_CONTAINER` to app-postgres; they
are local provisioning tools and were left alone rather than changed as drive-by
scope, but they will mislead in production.
