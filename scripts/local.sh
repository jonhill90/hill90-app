#!/usr/bin/env bash
# Hill90 local development stack.
#
#   ./scripts/local.sh up        generate config if needed, build, start, wait
#   ./scripts/local.sh down      stop, keep data
#   ./scripts/local.sh reset     stop and destroy volumes (databases included)
#   ./scripts/local.sh status    container + health summary
#   ./scripts/local.sh logs [svc]
#   ./scripts/local.sh init      generate .env.local and keys, then stop
#   ./scripts/local.sh agentbox  build the agentbox images (needed to run agents)
#
# Add --standalone to any command to use the self-contained fork instead of the
# production compose files. See the note below on why the tenant path is the
# default.
#
# By DEFAULT the app runs as a TENANT of a locally-running Hill90 infra stack,
# on the same compose files production uses:
#
#   ./scripts/local.sh up                 tenant (default)
#   ./scripts/local.sh up --standalone    self-contained fork, no Hill90 needed
#
# The two paths use different compose files on purpose:
#
#   default      deploy/compose/prod/*.yml            the files production uses,
#                + deploy/compose/overrides/local.*   layered, not forked
#   --standalone compose/local.yml                    self-contained fork
#
# The default is the tenant path deliberately. It is the only one that exercises
# production's own compose files, and a default that exercises the fork is how
# the fork drifted in the first place. --standalone remains because the
# production files declare Hill90's networks external, so they cannot run at all
# without the platform up.
#
# Everything is local. This script never touches a VPS, and there is no deploy
# path in this repository.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Standalone path: the self-contained fork. It creates its own networks and
# publishes ports, so it needs nothing outside this repository.
COMPOSE_FILE="$ROOT/compose/local.yml"

# Tenant path (--infra): the PRODUCTION compose files plus the local override
# layer. Not compose/local.infra.yml, which overlays the fork.
#
# This is the point of the override layer. Before, --infra layered on the fork,
# so the only way to exercise the files production actually uses was to hand-type
# a sixteen-flag docker compose command from an override's header comment. Nobody
# does that, so every local run kept exercising the fork and the drift the
# override layer exists to stop carried on through the default path.
PROD_DIR="$ROOT/deploy/compose/prod"
OVERRIDE_DIR="$ROOT/deploy/compose/overrides"
STACKS="db auth api ai knowledge mcp minio ui"

# One Compose project for the whole app under --infra, not one per stack.
# Hill90's local Traefik constrains its Docker provider to an allowlist of
# project names and cannot pattern-match (v2.11 has no LabelRegexp), so a project
# per stack would need eight entries added there and every app router is dropped
# until they are. `hill90-local` is already on that list.
INFRA_PROJECT="hill90-local"

# Note: compose/local.yml carries `name: hill90-local` too, so the standalone
# path and the tenant path share a Compose project name. They are mutually
# exclusive by design — the README says so, and both create
# <prefix>_agent_sandbox — but one consequence is visible: `status --standalone`
# will display tenant containers if the tenant path is what is running. The
# tenant path cannot simply use a different name, because Hill90's local Traefik
# allowlists project names and cannot pattern-match on v2.11.
ENV_FILE="$ROOT/.env.local"
KEY_DIR="$ROOT/compose/local/keys"

# The TENANT path is the default. --standalone opts out of it.
#
# This used to be the other way round, and that was the real problem: `local.sh
# up` drove compose/local.yml, so the default path everyone actually types kept
# exercising the fork. Adding a --infra flag did not fix that; it only gave the
# override layer a door nobody walks through. The drift the override layer exists
# to stop carried on through the default.
#
# --infra is still accepted so existing muscle memory and docs keep working.
INFRA=1
ARGS=()
for a in "$@"; do
  case "$a" in
    --standalone) INFRA=0 ;;
    --infra)      INFRA=1 ;;
    *)            ARGS+=("$a") ;;
  esac
done
set -- ${ARGS+"${ARGS[@]}"}

# `|| true` matters: a key that is absent, or a missing .env.local, makes grep
# exit 1, and under `set -euo pipefail` that aborts the caller mid-assignment.
ev() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# Networks the Hill90 infra stack owns. The app owns hill90_agent_sandbox and
# hill90_docker_proxy, matching production, where docker-compose.api.yml is
# their sole creator.
# Networks the infra stack owns, resolved when they are actually needed.
#
# Deliberately not computed at the top level: on a fresh clone .env.local does
# not exist yet, and under `set -euo pipefail` a grep that matches nothing
# aborts the script before cmd_init can create it — silently, with no output.
# The app's Keycloak hostname under --infra. Deliberately NOT AUTH_HOST: Hill90's
# own Keycloak owns auth.<domain> and serves realm `platform`, so printing
# AUTH_HOST here sent people to the wrong Keycloak, where the app's realm 404s.
# Default matches deploy/compose/overrides/local.auth.yml.
app_auth_host() {
  local h
  h=$(ev APP_AUTH_HOST)
  printf '%s' "${h:-app-auth}"
}

infra_networks() {
  local pfx
  pfx=$(ev NETWORK_PREFIX)
  pfx=${pfx:-hill90}
  printf '%s_edge %s_internal %s_agent_internal' "$pfx" "$pfx" "$pfx"
}

# Build the -f list for the tenant path: each production compose file followed by
# its local override, then the networks override that makes agent_sandbox
# creatable in a single merged invocation (see that file for why).
infra_files() {
  local st
  for st in $STACKS; do
    printf -- '-f\n%s\n-f\n%s\n' "$PROD_DIR/docker-compose.$st.yml" "$OVERRIDE_DIR/local.$st.yml"
  done
  printf -- '-f\n%s\n' "$OVERRIDE_DIR/local.networks.yml"
}

# Refuse to start on a variable Compose cannot interpolate.
#
# deploy.sh has had this gate since the incident where hill90.com served app-ui
# with a blank AUTH_SECRET while the deploy reported success. local.sh never had
# it, which is exactly why the PLATFORM_DB_* breakage reached main and sat there:
# production would have refused, local rendered empty strings and said nothing.
#
# SOURCED, not copied. The warning compose emits has BACKSLASH-ESCAPED quotes
# (it is embedded in a logfmt msg="..." field), and a pattern expecting bare
# quotes matches nothing and makes the gate silently inert. That bug has already
# happened once here, and it caught me again while investigating this one. One
# copy of that regex, in _common.sh, tested by tests/scripts/interpolation-gate-check.sh.
#
# Run in a SUBSHELL: _common.sh sets `set -euo pipefail` and this script is not
# written under those options.
require_interpolation() {
  local files=()
  if [ "$INFRA" = "1" ]; then
    while IFS= read -r line; do files+=("$line"); done < <(infra_files)
    ( set +u; source "$ROOT/scripts/_common.sh" >/dev/null 2>&1
      require_compose_interpolation -p "$INFRA_PROJECT" "${files[@]}" --env-file "$ENV_FILE" )
  else
    ( set +u; source "$ROOT/scripts/_common.sh" >/dev/null 2>&1
      require_compose_interpolation -f "$COMPOSE_FILE" --env-file "$ENV_FILE" )
  fi
}

compose() {
  if [ "$INFRA" = "1" ]; then
    local files=()
    while IFS= read -r line; do files+=("$line"); done < <(infra_files)
    docker compose -p "$INFRA_PROJECT" "${files[@]}" --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  fi
}

# The overlay declares the shared networks external, so they must already
# exist. Compose's own error names one network at a time and says nothing about
# where it should come from.
check_infra_networks() {
  local missing=()
  for n in $(infra_networks); do
    docker network inspect "$n" >/dev/null 2>&1 || missing+=("$n")
  done
  [ ${#missing[@]} -eq 0 ] && return 0
  cat >&2 <<EOF

--infra needs the Hill90 infrastructure stack running locally, but these
networks do not exist:

$(printf '  %s\n' "${missing[@]}")
Start the Hill90 local infra stack first, then run this again. To run without
it, drop --infra: the standalone stack creates its own networks and reaches
every service on published ports.

EOF
  return 1
}

rand() { openssl rand -hex 32; }

# Read a value out of .env.local (last definition wins, as with docker compose).

# ---------------------------------------------------------------------------
# Ed25519 keypairs.
#
# The API mints agent tokens signed with these; the AI and knowledge services
# verify them against the matching public key. The private halves live in
# .env.local as \n-escaped PEM (services/api/src/services/akm-token.ts:21
# un-escapes them); the public halves are mounted read-only at /etc/akm.
# Freshly generated keys are fine — nothing depends on the originals.
# ---------------------------------------------------------------------------
gen_keys() {
  mkdir -p "$KEY_DIR"
  for name in akm model-router; do
    if [ ! -f "$KEY_DIR/$name-private.pem" ]; then
      openssl genpkey -algorithm ed25519 -out "$KEY_DIR/$name-private.pem" 2>/dev/null
      echo "  generated $name keypair"
    fi
  done
  # services/knowledge expects its public key at exactly /etc/akm/public.pem
  # (AKM_PUBLIC_KEY_PATH); the AI service expects model-router-public.pem.
  openssl pkey -in "$KEY_DIR/akm-private.pem"          -pubout -out "$KEY_DIR/public.pem"
  openssl pkey -in "$KEY_DIR/model-router-private.pem" -pubout -out "$KEY_DIR/model-router-public.pem"
  chmod 644 "$KEY_DIR"/*.pem
}

escape_pem() { awk '{printf "%s\\n", $0}' "$1"; }

# Keys the TENANT path needs that pre-2026-07-31 .env.local files predate.
#
# When app-keycloak, app-postgres and app-minio were retired in PRODUCTION, the
# production compose files started reading PLATFORM_DB_* and MINIO_TENANT_*. The
# local overrides LAYER on those production files, so local started reading them
# too — and nothing supplied them. Compose does not fail on an unset variable, it
# substitutes an empty string, so `api`, `ai` and `knowledge` were handed
# `postgresql://:@:5432/hill90_api`. Since #61 `ai` refuses to start without a
# database, so a clean `up` failed outright.
#
# THE VALUES POINT AT THE APP'S OWN SERVICES, NOT THE PLATFORM'S. Locally
# "platform Postgres" is played by app-postgres and "platform MinIO" by
# app-minio. That is a restoration of how local worked before the cutover, NOT
# the parity conversion — see docs/decisions/local-parity-with-platform-services.md,
# which is still an open decision for Jon. Do not read these names as a claim
# that local matches production; it does not, and that is the open question.
#
# Setting values rather than overriding in local.*.yml is deliberate: an override
# replaces the production line, and then the local run stops exercising it
# (CLAUDE.md invariant 6). This way `DATABASE_URL=postgresql://${PLATFORM_DB_USER}...`
# is the very line local runs.
tenant_platform_keys() {
  cat <<'KEYS'
PLATFORM_DB_HOST=app-postgres
PLATFORM_DB_USER=hill90
PLATFORM_DB_PASSWORD=hill90
MINIO_ENDPOINT=http://app-minio:9000
MINIO_TENANT_ACCESS_KEY=hill90admin
MINIO_TENANT_SECRET_KEY=hill90admin
KEYS
}

# gen_env refuses to touch an existing .env.local, which is correct — it holds
# generated keys and possibly real provider keys. But it also means fixing the
# generator alone fixes nobody who already has the file. Append what is missing,
# never overwrite what is there.
topup_env() {
  [ -f "$ENV_FILE" ] || return 0
  local line name
  local added=""
  while IFS= read -r line; do
    name=${line%%=*}
    grep -qE "^${name}=" "$ENV_FILE" 2>/dev/null || added="${added}${line}"$'\n'
  done < <(tenant_platform_keys)
  [ -z "$added" ] && return 0
  {
    echo ""
    echo "# --- added by scripts/local.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) ---"
    echo "# The production compose files began reading these when app-postgres and"
    echo "# app-minio were retired in PRODUCTION. Files created before 2026-07-31"
    echo "# predate them. Values point at the app's OWN local services."
    printf '%s' "$added"
  } >> "$ENV_FILE"
  echo "  .env.local: added $(printf '%s' "$added" | cut -d= -f1 | tr '\n' ' ')"
}

gen_env() {
  if [ -f "$ENV_FILE" ]; then
    echo "  .env.local exists — topping up any missing keys"
    topup_env
    return
  fi
  echo "  writing .env.local"
  cat > "$ENV_FILE" <<EOF
# Hill90 local stack — generated by scripts/local.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# Local-only credentials. Regenerate any time by deleting this file and
# re-running ./scripts/local.sh init. Not for any deployed environment.

# --- database ---
DB_USER=hill90
DB_PASSWORD=hill90

# --- what production calls the platform services ---
# Read by the PRODUCTION compose files, which the tenant path layers on. Locally
# these point at the app's own containers; see tenant_platform_keys() in
# scripts/local.sh for why, and docs/decisions/local-parity-with-platform-services.md
# for the open question of whether local should use Hill90's instead.
$(tenant_platform_keys)

# --- object storage ---
MINIO_ROOT_USER=hill90admin
MINIO_ROOT_PASSWORD=hill90admin

# --- keycloak ---
KC_ADMIN_USERNAME=admin
KC_ADMIN_PASSWORD=admin
AUTH_KEYCLOAK_ID=hill90-ui
AUTH_KEYCLOAK_SECRET=local-dev-secret

# --- shared service tokens (must match across api/ai/knowledge) ---
AKM_INTERNAL_SERVICE_TOKEN=$(rand)
MODEL_ROUTER_INTERNAL_SERVICE_TOKEN=$(rand)
CHAT_CALLBACK_TOKEN=$(rand)
PROVIDER_KEY_ENCRYPTION_KEY=$(rand)
LITELLM_MASTER_KEY=sk-local-$(openssl rand -hex 16)
AUTH_SECRET=$(rand)

# --- agent token signing (Ed25519, public halves in compose/local/keys/) ---
AKM_SIGNING_PRIVATE_KEY=$(escape_pem "$KEY_DIR/akm-private.pem")
MODEL_ROUTER_SIGNING_PRIVATE_KEY=$(escape_pem "$KEY_DIR/model-router-private.pem")

# --- provider keys: REQUIRED FOR INFERENCE, optional to boot ---
# The stack starts and is fully browsable without these. Chat and embeddings
# will fail until at least one is real.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
TAVILY_API_KEY=

# --- agent containers ---
# Absolute host path the API bind-mounts into each agentbox container. Must be
# a host path, since the Docker daemon resolves it, not the API container.
AGENTBOX_CONFIG_HOST_PATH=$ROOT/.local/agentbox-configs

# --- published ports (13000/18000 band, to avoid common conflicts) ---
PORT_UI=13000
PORT_API=13001
PORT_LITELLM=14000
PORT_POSTGRES=15432
PORT_AI=18000
PORT_MCP=18001
PORT_KNOWLEDGE=18002
PORT_KEYCLOAK=18080
PORT_MINIO=19000
PORT_MINIO_CONSOLE=19001

# --- infra overlay (./scripts/local.sh up --infra) ---------------------------
# Ignored unless --infra is used. These must match the Hill90 infra repo's own
# .env.local, since both stacks have to agree on network names and hostnames.
# The defaults below are the infra repo's local values.
NETWORK_PREFIX=hill90dev
BASE_DOMAIN=localtest.me
HTTP_PORT=8080
UI_HOST=app
API_HOST=api
AI_HOST=ai
STORAGE_HOST=storage

# The app's Keycloak hostname. Deliberately NOT \`auth\`: Hill90's own Keycloak
# owns auth.<domain> and serves realm \`platform\`, so asking for \`auth\` reaches
# the wrong Keycloak and the app's realm 404s.
APP_AUTH_HOST=app-auth

# Hill90's Keycloak hostname. Kept so a value copied from Hill90's .env.local
# does not read as missing; the app does not route on it.
AUTH_HOST=auth

# Container name prefix, matching Hill90's convention: empty in production, set
# locally so two environments can coexist on one machine.
CONTAINER_PREFIX=hill90dev-
EOF
}

cmd_init() {
  echo "Preparing local configuration..."
  gen_keys
  gen_env
  mkdir -p "$ROOT/.local/agentbox-configs"
  echo "Ready. Review $ENV_FILE, then: ./scripts/local.sh up"
}

wait_healthy() {
  local deadline=$((SECONDS + 300))
  echo "Waiting for services to become healthy (up to 5 min)..."
  while [ $SECONDS -lt $deadline ]; do
    local pending
    pending=$(compose ps --format json 2>/dev/null \
      | python3 -c '
import json,sys
bad=[]
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: c=json.loads(line)
    except Exception: continue
    h=(c.get("Health") or "").lower(); s=(c.get("State") or "").lower()
    if h and h!="healthy": bad.append(c.get("Service","?")+":"+h)
    elif not h and s!="running": bad.append(c.get("Service","?")+":"+s)
print(" ".join(bad))' 2>/dev/null || echo "unknown")
    if [ -z "$pending" ]; then
      echo "All services healthy."
      return 0
    fi
    printf "\r  waiting: %-70s" "$pending"
    sleep 5
  done
  echo
  echo "Timed out. Current state:"
  compose ps
  return 1
}

# ---------------------------------------------------------------------------
# Port preflight.
#
# Every published port is configurable in .env.local, but a clash otherwise
# surfaces as a bare Docker error part-way through startup, after some
# containers are already running:
#
#   Bind for 0.0.0.0:14000 failed: port is already allocated
#
# The chosen band avoids the usual suspects, but nothing can avoid every host.
# Check up front and say which variable to change.
# ---------------------------------------------------------------------------
port_in_use() { (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; }

# Ports published by containers belonging to OUR compose project.
#
# Identified by the project label, not by a container-name prefix. The previous
# version filtered `name=hill90-`, and `--filter name=` is a substring match, so with
# CONTAINER_PREFIX=hill90dev the names are `hill90dev-app-ui` — which does not contain
# `hill90-`. The exclusion matched nothing, every port looked foreign, and `up`
# against a running stack refused while naming our own containers as the holders.
# That made `up` non-idempotent for any prefix except the literal `hill90-`.
#
# Every container either path creates carries com.docker.compose.project=hill90-local,
# whatever CONTAINER_PREFIX is, so the label is the prefix-independent answer.
ours_ports() {
  local project="${1:-$INFRA_PROJECT}"
  docker ps --filter "label=com.docker.compose.project=${project}" \
            --format '{{.Ports}}' 2>/dev/null \
    | grep -oE '0\.0\.0\.0:[0-9]+' | cut -d: -f2 | sort -u
}

check_ports() {
  # Ports this stack is already publishing are not conflicts — that is just a
  # re-run of `up` against a running stack. A genuinely foreign holder still refuses.
  local ours
  ours=$(ours_ports "$INFRA_PROJECT")

  local conflicts=""
  while IFS='=' read -r var port; do
    [ -n "$port" ] || continue
    grep -qx "$port" <<<"$ours" && continue
    if port_in_use "$port"; then
      local holder
      holder=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
               | grep ":$port->" | cut -f1 | head -1)
      conflicts+="  $port  ($var)${holder:+  — held by container '$holder'}"$'\n'
    fi
  done < <(grep -E '^PORT_[A-Z_]+=[0-9]+' "$ENV_FILE")

  [ -z "$conflicts" ] && return 0

  cat >&2 <<EOF

Port conflict — these are already in use on this host:

$conflicts
Edit $ENV_FILE, change the listed PORT_* variable(s) to a free port,
then run this again. Nothing was started.

EOF
  return 1
}

cmd_up() {
  [ -f "$ENV_FILE" ] || cmd_init
  topup_env
  [ "$INFRA" = "1" ] && { check_infra_networks || exit 1; }
  check_ports || exit 1
  mkdir -p "$ROOT/.local/agentbox-configs"
  gen_keys
  require_interpolation || exit 1
  compose build
  compose up -d
  wait_healthy || true
  echo
  cmd_status
  local dom port
  dom=$(ev BASE_DOMAIN); dom=${dom:-localtest.me}
  port=$(ev HTTP_PORT);  port=${port:-8080}
  cat <<EOF

  UI              http://localhost:$(grep -E '^PORT_UI=' "$ENV_FILE" | cut -d= -f2)
  API             http://localhost:$(grep -E '^PORT_API=' "$ENV_FILE" | cut -d= -f2)/health
  Keycloak admin  http://localhost:$(grep -E '^PORT_KEYCLOAK=' "$ENV_FILE" | cut -d= -f2)  (admin/admin)
  MinIO console   http://localhost:$(grep -E '^PORT_MINIO_CONSOLE=' "$ENV_FILE" | cut -d= -f2)
EOF
  [ "$INFRA" = "1" ] && cat <<EOF

  Through Traefik (Hill90 infra):
    UI            http://$(ev UI_HOST).$dom:$port
    API           http://$(ev API_HOST).$dom:$port/health
    Keycloak      http://$(app_auth_host).$dom:$port
    MCP gateway   http://$(ev AI_HOST).$dom:$port/mcp
    MinIO console http://$(ev STORAGE_HOST).$dom:$port
EOF
  cat <<EOF

  Log in to the UI as  dev / dev

EOF
}

cmd_status() {
  compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'
}

cmd_agentbox() {
  # agentbox is not a compose service — the API creates one container per agent
  # from these images (services/api/src/services/docker.ts:78-146). The base
  # image copies the akm CLI out of hill90/knowledge, so that must exist first.
  echo "Building agentbox images (slow: installs Node, Playwright, oh-my-zsh)..."
  docker build -t hill90/knowledge:latest "$ROOT/services/knowledge"
  docker build -t hill90/agentbox:latest  "$ROOT/services/agentbox"
  docker build -t hill90/agentbox-monitor:latest -f "$ROOT/services/agentbox/Dockerfile.monitor" "$ROOT/services/agentbox"
  echo "Done. hill90/agentbox:latest is what the API launches by default."
}

# Sourcing this file must not run a command. Without this, a test that sources it to
# reach a helper silently executes `up`.
if [ "${1:-}" = "--source-only" ]; then
  return 0 2>/dev/null || exit 0
fi

case "${1:-up}" in
  init)     cmd_init ;;
  up)       cmd_up ;;
  down)     compose down ;;
  reset)    compose down -v; rm -rf "$ROOT/.local/agentbox-configs"; echo "Volumes destroyed." ;;
  status)   cmd_status ;;
  logs)     shift; compose logs -f "$@" ;;
  agentbox) cmd_agentbox ;;
  realm)    echo "Edit compose/local/keycloak/realm-local.json, then: ./scripts/local.sh reset && ./scripts/local.sh up" ;;
  *)        sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
