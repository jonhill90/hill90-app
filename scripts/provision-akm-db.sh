#!/usr/bin/env bash
# Provision the hill90_akm database on the app's existing PostgreSQL instance.
#
#   bash scripts/provision-akm-db.sh
#
# Three bugs were fixed here, and the first hid the other two:
#
#   1. `source _common.sh` — that file did not exist and was never extracted from
#      Hill90, so this script died at line 7 under `set -e`, loudly and non-zero,
#      before reaching any of the work below.
#   2. `docker exec` without `-i` — with stdin not attached, psql reads EOF
#      immediately and exits 0 having run nothing. Silent, and the loud failure
#      above masked it.
#   3. `--username postgres` and `docker exec postgres` — neither is right. The
#      role is $DB_USER (`postgres` does not exist), and the container is the
#      app's `app-postgres`, not the bare `postgres`, which is Hill90's.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

PG_CONTAINER="${PG_CONTAINER:-${CONTAINER_PREFIX:-}app-postgres}"
DB_USER="${DB_USER:-hill90}"

docker inspect "$PG_CONTAINER" >/dev/null 2>&1 \
    || die "Container '$PG_CONTAINER' not found. The app's database must be running:
  bash scripts/deploy.sh db
Set PG_CONTAINER to override the name."

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

success "hill90_akm provisioned"
