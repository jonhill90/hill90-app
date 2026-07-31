#!/usr/bin/env bash
# Provision the hill90_litellm database on an existing PostgreSQL instance.
#
#   bash scripts/provision-litellm-db.sh                  # platform Postgres
#   PG_CONTAINER=app-postgres bash scripts/...            # local standalone stack
#
# In production this is a no-op: hill90_litellm already exists on the platform
# Postgres. Like its sibling, it grants to the SUPERUSER only and does not create or
# grant the tenant role hill90_app that the app connects as — Hill90's
# scripts/provision-tenant-db.sh owns that. It says so at the end.
#
# This script already had `docker exec -i`, so it never had the silent-stdin bug
# its sibling did. It shared the fatal one: `source _common.sh` for a file that
# was never extracted, which killed it at line 7 under `set -e`. It also
# hardcoded the container name `postgres`, which is Hill90's instance, not the
# app's.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

# The PLATFORM Postgres by default, since 2026-07-31 — see the long note in
# provision-akm-db.sh. The old default, ${CONTAINER_PREFIX:-}app-postgres, names a
# container that was retired, and the old error sent the operator to
# `scripts/deploy.sh db`, which now refuses. CONTAINER_PREFIX is deliberately not
# applied: the platform's container is plainly `postgres` and is Hill90's.
PG_CONTAINER="${PG_CONTAINER:-postgres}"

# hill90 is the platform-invariant PostgreSQL superuser. It is set at VPS bootstrap via
# POSTGRES_USER=hill90 — on the PLATFORM instance now, not this repo's
# docker-compose.db.yml, which is local-only since the retirement. The name happens to
# be the same on both, which is why this default survived the cutover unchanged.
DB_USER="${DB_USER:-hill90}"

docker inspect "$PG_CONTAINER" >/dev/null 2>&1 \
    || die "Container '${PG_CONTAINER}' not found, so hill90_litellm cannot be provisioned.

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

info "Provisioning hill90_litellm in ${PG_CONTAINER} as ${DB_USER}..."

docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname postgres <<-EOSQL
    SELECT 'CREATE DATABASE hill90_litellm'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hill90_litellm')\\gexec

    \\c hill90_litellm;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \\c postgres;
    GRANT ALL PRIVILEGES ON DATABASE hill90_litellm TO $DB_USER;
EOSQL

success "hill90_litellm provisioned in ${PG_CONTAINER}"

# Same omission as its sibling, stated for the same reason: an incomplete provision
# otherwise surfaces later as a permission error that reads as a broken app.
info "Granted to '${DB_USER}' only. The app connects as the tenant role (hill90_app
on the platform), which this script does NOT create or grant. On the platform, tenant
roles and grants come from Hill90's scripts/provision-tenant-db.sh."
