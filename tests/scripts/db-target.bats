#!/usr/bin/env bats

# scripts/db-target.sh must not be able to print a password.
#
# It exists because `docker inspect | grep DATABASE_URL` leaked a live credential twice
# in one session, while someone was legitimately checking which database a service was
# pointed at. A redacted view is only worth having if it cannot leak, so that is what
# these assert — with docker stubbed, so no daemon is needed.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  STUB="${BATS_TEST_TMPDIR}/bin"; mkdir -p "$STUB"; PATH="$STUB:$PATH"
  SECRET="sup3r-s3cret-p4ssw0rd"
  cat > "${STUB}/docker" <<SH
#!/usr/bin/env bash
[ "\$1" = "inspect" ] || exit 0
case "\$*" in
  *--format*) echo "DATABASE_URL=postgresql://hill90_app:${SECRET}@postgres:5432/hill90_api" ;;
  *) exit 0 ;;
esac
SH
  chmod +x "${STUB}/docker"
}

@test "the password never appears in the output" {
  run bash "${REPO_ROOT}/scripts/db-target.sh" app-api
  [ "$status" -eq 0 ]
  [[ "$output" != *"sup3r-s3cret-p4ssw0rd"* ]]
}

@test "it still answers the question — host, user and database survive" {
  run bash "${REPO_ROOT}/scripts/db-target.sh" app-api
  [[ "$output" == *"hill90_app"* ]]
  [[ "$output" == *"postgres:5432"* ]]
  [[ "$output" == *"hill90_api"* ]]
  [[ "$output" == *"<redacted>"* ]]
}

@test "a container that is not running is reported, not skipped silently" {
  cat > "${STUB}/docker" <<'SH'
#!/usr/bin/env bash
exit 1
SH
  chmod +x "${STUB}/docker"
  run bash "${REPO_ROOT}/scripts/db-target.sh" app-api
  [ "$status" -eq 0 ]
  [[ "$output" == *"not running"* ]]
}

@test "a container with no DATABASE_URL is reported rather than shown blank" {
  cat > "${STUB}/docker" <<'SH'
#!/usr/bin/env bash
[ "$1" = "inspect" ] || exit 0
case "$*" in *--format*) echo "PORT=3000" ;; *) exit 0 ;; esac
SH
  chmod +x "${STUB}/docker"
  run bash "${REPO_ROOT}/scripts/db-target.sh" app-api
  [[ "$output" == *"no DATABASE_URL"* ]]
}

@test "redaction does not mangle a URL whose password contains an @" {
  cat > "${STUB}/docker" <<'SH'
#!/usr/bin/env bash
[ "$1" = "inspect" ] || exit 0
case "$*" in *--format*) echo 'DATABASE_URL=postgresql://u:p@ss@postgres:5432/db' ;; *) exit 0 ;; esac
SH
  chmod +x "${STUB}/docker"
  run bash "${REPO_ROOT}/scripts/db-target.sh" app-api
  [[ "$output" != *"p@ss"* ]]
  [[ "$output" == *"postgres:5432/db"* ]]
}
