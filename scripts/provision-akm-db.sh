#!/usr/bin/env bash
# Provision the hill90_akm database on an existing PostgreSQL instance.
#
#   bash scripts/provision-akm-db.sh                      # platform Postgres
#   PG_CONTAINER=app-postgres bash scripts/...            # local standalone stack
#
# In production this is a no-op: hill90_akm already exists on the platform Postgres,
# and Hill90's own scripts/provision-tenant-db.sh is what creates a tenant database
# together with the NOSUPERUSER role hill90_app that the app actually connects as.
# This script creates the database and grants to the SUPERUSER only — it does not
# grant to the tenant role, so a database created by this script alone is not usable
# by the app. It says so at the end rather than leaving that to be discovered.
#
# Three bugs were fixed here, and the first hid the other two:
#
#   1. `source _common.sh` — that file was missing, so this script died at line 7
#      under `set -e`, loudly and non-zero, before reaching any of the work below.
#   2. `docker exec` without `-i` — with stdin not attached, psql reads EOF
#      immediately and exits 0 having run nothing. Silent, and the loud failure
#      above masked it.
#   3. `--username postgres` and `docker exec postgres` — neither is right. The
#      role is $DB_USER (`postgres` does not exist), and the container is the
#      app's `app-postgres`, not the bare `postgres`, which is Hill90's.
#
# Point 3's SECOND half has since inverted, and it is left in place rather than
# rewritten because the reasoning was sound when written: the app consumed its own
# Postgres then, and the bare `postgres` was somebody else's. After the cutover the
# app consumes the platform's instance, so `postgres` is now the right target and
# `app-postgres` no longer exists in production.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

# The PLATFORM Postgres by default, since 2026-07-31.
#
# This used to default to ${CONTAINER_PREFIX:-}app-postgres, which was correct until
# app-postgres was retired and then became a default that cannot work in production:
# `docker inspect` fails, and the old failure message sent the operator to
# `scripts/deploy.sh db`, which now refuses. A default pointing at a container that
# was deliberately removed, with an error naming a command that deliberately refuses,
# is worse than no default at all.
#
# CONTAINER_PREFIX is deliberately NOT applied. The platform's container is plainly
# `postgres` — it is Hill90's, not this repo's, so it does not carry the app's prefix.
# For a standalone local stack, which still runs the app's own Postgres, set
# PG_CONTAINER=app-postgres explicitly.
PG_CONTAINER="${PG_CONTAINER:-postgres}"
DB_USER="${DB_USER:-hill90}"

docker inspect "$PG_CONTAINER" >/dev/null 2>&1 \
    || die "Container '${PG_CONTAINER}' not found, so hill90_akm cannot be provisioned.

This script defaults to the PLATFORM Postgres container, 'postgres', which Hill90
owns. If you expected the app's own instance, note that app-postgres was RETIRED on
2026-07-31 (docs/decisions/retiring-app-postgres.md) and scripts/deploy.sh refuses to
recreate it — do not reach for 'deploy.sh db' to fix this.

Pick the one that matches where you are:
  platform / production   the container is named 'postgres' and belongs to Hill90.
                          If it is absent, the platform is down; this is not the
                          script to fix that.
  local, standalone       PG_CONTAINER=app-postgres bash ${BASH_SOURCE[0]##*/}
  anything else           set PG_CONTAINER to the container you mean."

info "Provisioning hill90_akm in ${PG_CONTAINER} as ${DB_USER}..."

docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname postgres <<-'EOSQL'
	SELECT 'CREATE DATABASE hill90_akm'
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hill90_akm')\gexec
EOSQL

docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname hill90_akm <<-'EOSQL'
	CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
EOSQL

# \c cannot be used to switch databases inside a single non-interactive psql run
# in the way the original assumed, which is why this is two invocations.
docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname postgres <<-EOSQL
	GRANT ALL PRIVILEGES ON DATABASE hill90_akm TO "${DB_USER}";
EOSQL

success "hill90_akm provisioned in ${PG_CONTAINER}"

# Say what was NOT done. The app connects as the tenant role, not as the superuser,
# so a database provisioned only by this script authenticates fine and then fails on
# the first query with a permission error — which reads as a broken app rather than an
# incomplete provision.
info "Granted to '${DB_USER}' only. The app connects as the tenant role (hill90_app
on the platform), which this script does NOT create or grant. On the platform, tenant
roles and grants come from Hill90's scripts/provision-tenant-db.sh."
