#!/usr/bin/env bash
# Provision the hill90_litellm database on the app's existing PostgreSQL instance.
#
#   bash scripts/provision-litellm-db.sh
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

PG_CONTAINER="${PG_CONTAINER:-${CONTAINER_PREFIX:-}app-postgres}"

# hill90 is the platform-invariant PostgreSQL superuser, set at VPS bootstrap
# via POSTGRES_USER=hill90 in docker-compose.db.yml.
DB_USER="${DB_USER:-hill90}"

docker inspect "$PG_CONTAINER" >/dev/null 2>&1 \
    || die "Container '$PG_CONTAINER' not found. The app's database must be running:
  bash scripts/deploy.sh db
Set PG_CONTAINER to override the name."

info "Provisioning hill90_litellm in ${PG_CONTAINER} as ${DB_USER}..."

docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname postgres <<-EOSQL
    SELECT 'CREATE DATABASE hill90_litellm'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hill90_litellm')\\gexec

    \\c hill90_litellm;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \\c postgres;
    GRANT ALL PRIVILEGES ON DATABASE hill90_litellm TO $DB_USER;
EOSQL

echo "✓ hill90_litellm database provisioned"
