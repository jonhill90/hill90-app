#!/usr/bin/env bash
# Deploy CLI — deploy hill90-app as a tenant of the Hill90 platform.
# Usage: deploy.sh {db|auth|api|ai|knowledge|mcp|minio|ui|all|verify|teardown} [env]
#
# ---------------------------------------------------------------------------
# Why this lives here and not in Hill90
#
# Hill90's scripts/deploy.sh is closed over its own stacks by construction: a
# fixed verb set, a compose path computed as deploy/compose/${env}/... inside
# that repo, a secrets path of infra/secrets/${env}.enc.env authenticated with a
# per-service Hill90 AppRole, a backup inventory that knows the five platform
# volume sets, and a teardown that maps stacks to project names precisely so a
# `down` cannot reach a neighbour.
#
# A `tenant` verb there would need a second compose root, a second secrets
# source, a second backup inventory and a second project-name map — a second
# script inside the first, sharing only the parts that make it dangerous. The
# tenancy contract Hill90 offers is narrow (three external networks, an edge
# proxy, host capacity) and a tenant should depend on that contract rather than
# extend the tooling that provides it.
#
# So: this file follows Hill90's deploy.sh in SHAPE — same dispatcher, same
# readiness-check loop, same project-scoped teardown, same SOPS+age secrets
# mechanism — while owning its own roots. Where it diverges, the divergence is
# commented. Do not redesign it; keep the two recognisably the same script.
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Deploy hill90-app as a tenant of the Hill90 platform.

Usage: deploy.sh <command> [env]

Stacks (deploy order matters — see 'all'):
  db          PostgreSQL, the app's own instance (NOT Hill90's)
  auth        Keycloak, the app's own realm (NOT Hill90's)
  api         Control plane. Sole creator of agent_sandbox and docker_proxy
  ai          Model router + LiteLLM
  knowledge   Agent Knowledge Manager
  mcp         Model Context Protocol gateway
  minio       Object storage
  ui          Next.js frontend

Commands:
  all         Deploy every stack in dependency order, verifying each
  verify      Run the readiness check for one stack
  teardown    Stop and remove one stack (volumes KEPT)
  preflight   Check the tenancy contract only, change nothing
  help        This message

Environment: defaults to 'prod'

Deploy order is not cosmetic. api creates agent_sandbox and docker_proxy, which
ai and knowledge consume as external, so api MUST precede them. auth stores its
realm in the app's postgres, so db MUST precede auth.
EOF
}

# ---------------------------------------------------------------------------
# Stack table
#
# One place defining, per stack: compose file, override file, container names,
# Compose project, and a human summary. Hill90 uses a case statement in
# cmd_service; the same information is here as data so verify, teardown and
# deploy cannot drift from one another — the drift Hill90 guards against by
# repeating the allowlist in three functions.
# ---------------------------------------------------------------------------

DEPLOY_ORDER="db auth api ai knowledge mcp minio ui"

stack_compose()  { printf 'deploy/compose/%s/docker-compose.%s.yml' "${2:-prod}" "$1"; }
stack_override() { printf 'deploy/compose/overrides/local.%s.yml' "$1"; }

stack_containers() {
    case "$1" in
        db)        printf 'app-postgres' ;;
        auth)      printf 'app-keycloak' ;;
        api)       printf 'app-api app-docker-proxy' ;;
        ai)        printf 'app-ai app-litellm' ;;
        knowledge) printf 'app-knowledge' ;;
        mcp)       printf 'app-mcp' ;;
        minio)     printf 'app-minio' ;;
        ui)        printf 'app-ui' ;;
        *)         die "Unknown stack: $1" ;;
    esac
}

# Every stack gets its OWN Compose project. Hill90 groups several stacks into
# shared projects (platform, identity, ...); the app does not, because a shared
# project is exactly what lets a `down` reach a neighbour, and the app has no
# reason to group.
stack_project() { printf 'hill90-app-%s-%s' "${2:-prod}" "$1"; }

# Resolve a service's actual container name. The compose files set
# container_name: ${CONTAINER_PREFIX:-}app-<name>, so anything in this script
# that runs `docker exec` or `docker inspect` must apply the same prefix.
# Hardcoding the bare name made every readiness check fail against a prefixed
# environment with "No such container" — found by running it, not by reading.
cname() { printf '%s%s' "${CONTAINER_PREFIX:-}" "$1"; }

stack_summary() {
    case "$1" in
        db)        printf 'app-postgres — the app'"'"'s own database. Hill90'"'"'s asserts platform-only databases.' ;;
        auth)      printf 'app-keycloak — realm hill90, on ${APP_AUTH_HOST:-app-auth}. Hill90 keeps auth.<domain>.' ;;
        api)       printf 'app-api, app-docker-proxy — control plane; creates agent_sandbox and docker_proxy' ;;
        ai)        printf 'app-ai, app-litellm — model router; internal-only' ;;
        knowledge) printf 'app-knowledge — AKM; internal-only' ;;
        mcp)       printf 'app-mcp — MCP gateway on ${AI_HOST:-ai}/mcp' ;;
        minio)     printf 'app-minio — object storage on ${STORAGE_HOST:-storage}' ;;
        ui)        printf 'app-ui — frontend at the apex domain' ;;
    esac
}

# ---------------------------------------------------------------------------
# Readiness checks
#
# Same loop as Hill90's cmd_verify: poll a per-service predicate, and on failure
# dump the container's recent logs rather than just reporting a timeout, because
# "not ready after 60s" is not actionable on its own.
# ---------------------------------------------------------------------------

cmd_verify() {
    local stack="${1:?stack required}"
    local env="${2:-prod}"
    local max_attempts=45

    # Readiness is each container's OWN healthcheck, not a URL this script
    # guesses. Every service in deploy/compose/prod defines one, written by
    # whoever knows the service.
    #
    # The first version probed hardcoded paths and got `ai` wrong: it polled
    # /health while the service serves /health/ready, so a container that was up,
    # connected to its database and answering 200 was reported as a failed
    # deploy. That is the same mistake as calling `api`'s 404 at bare `/` a
    # routing bug -- probing a path that was never mounted. Asking Docker for the
    # status the service itself declares removes the guess entirely.
    local containers c status attempt
    containers="$(stack_containers "$stack")"

    info "Waiting for ${stack} to become healthy (up to $((max_attempts * 2))s)..."
    for name in $containers; do
        c="$(cname "$name")"
        attempt=0
        status=""
        while [ "$attempt" -lt "$max_attempts" ]; do
            status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || true)"
            if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
                success "${c}: ${status}"
                break
            fi
            attempt=$((attempt + 1))
            sleep 2
        done
        if [ "$attempt" -ge "$max_attempts" ]; then
            warn "${stack} did not become healthy. Recent logs from ${c}:"
            docker logs --tail 40 "$c" 2>&1 | sed 's/^/    /' || true
            die "${stack} failed its readiness check (last status: ${status:-unknown})"
        fi
    done
    success "${stack} ready"
}

# ---------------------------------------------------------------------------
# Preflight — the tenancy contract, checked before anything is changed
# ---------------------------------------------------------------------------

cmd_preflight() {
    banner "Preflight — tenancy contract"
    require_command docker
    require_infra_networks
    success "shared networks present: $(network_prefix)_{edge,internal,agent_internal}"

    docker inspect "${TRAEFIK_CONTAINER:-traefik}" >/dev/null 2>&1 \
        && success "Traefik is running" \
        || warn "Traefik container '${TRAEFIK_CONTAINER:-traefik}' not found — routes will not serve"

    # The app references these and does not define them. mcp-strip is NOT in this
    # list on purpose: it is declared as a label in docker-compose.mcp.yml,
    # because Hill90 removed it as app-specific.
    require_file_middlewares rate-limit tailscale-only \
        || warn "Continuing — but the routers referencing them will serve nothing"

    success "preflight complete"
}

# ---------------------------------------------------------------------------
# Deploy one stack
# ---------------------------------------------------------------------------

cmd_deploy() {
    local stack="${1:?stack required}"
    local env="${2:-prod}"
    local compose_file project_name

    compose_file="$(stack_compose "$stack" "$env")"
    project_name="$(stack_project "$stack" "$env")"

    banner "Deploying ${stack} (${env})"
    echo "  compose: ${compose_file}"
    echo "  project: ${project_name}"
    echo "  summary: $(stack_summary "$stack")"
    echo

    require_file "$compose_file" "Compose file"
    require_infra_networks

    # Ordering is a hard dependency, not a preference. Refuse rather than start
    # into a crash loop, which is what Hill90's deploy.sh does for auth->db.
    case "$stack" in
        auth)
            docker exec "$(cname app-postgres)" pg_isready -U "${DB_USER:-hill90}" >/dev/null 2>&1 \
                || die "Cannot deploy auth: the app's postgres is not accepting connections.
Keycloak stores its realm there. Deploy it first:  bash scripts/deploy.sh db ${env}"
            ;;
        ai|knowledge)
            local pfx; pfx="$(network_prefix)"
            docker network inspect "${pfx}_agent_sandbox" >/dev/null 2>&1 \
                || die "Cannot deploy ${stack}: network ${pfx}_agent_sandbox does not exist.
docker-compose.api.yml is its sole creator, and ${stack} consumes it as external.
Deploy api first:  bash scripts/deploy.sh api ${env}"
            ;;
    esac

    load_secrets "$env"

    local -a files=(-f "$compose_file")
    if [ "${USE_LOCAL_OVERRIDE:-0}" = "1" ]; then
        local ov; ov="$(stack_override "$stack")"
        require_file "$ov" "Override file"
        files+=(-f "$ov")
        info "layering local override: ${ov}"
    fi

    docker compose -p "$project_name" "${files[@]}" up -d

    cmd_verify "$stack" "$env"
    success "${stack} deployed"
}

cmd_all() {
    local env="${1:-prod}"
    cmd_preflight
    for stack in $DEPLOY_ORDER; do
        cmd_deploy "$stack" "$env"
    done
    banner "All stacks deployed"
    printf '  %s\n' $DEPLOY_ORDER
}

# ---------------------------------------------------------------------------
# Teardown
#
# Project-scoped, volumes kept, and --remove-orphans is deliberately NOT used.
# Hill90 bans it repo-wide because it will delete containers belonging to
# another stack that shares a project name. The app gives every stack its own
# project, which makes the flag less dangerous here — but the ban is kept so the
# two repos behave identically and nobody has to remember which rule applies.
# ---------------------------------------------------------------------------

cmd_teardown() {
    local stack="${1:?stack required}"
    local env="${2:-prod}"
    local compose_file project_name

    compose_file="$(stack_compose "$stack" "$env")"
    project_name="$(stack_project "$stack" "$env")"
    stack_containers "$stack" >/dev/null   # validates the stack name

    require_file "$compose_file" "Compose file"

    banner "Teardown: ${stack} (${env})"
    echo "  project: ${project_name}"
    echo "  volumes: KEPT — data survives; redeploy restores the stack as-is."
    echo

    docker compose -p "$project_name" -f "$compose_file" down

    success "${stack} torn down. Redeploy with: bash scripts/deploy.sh ${stack} ${env}"
}

# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

main() {
    local cmd="${1:-help}"; shift || true
    case "$cmd" in
        db|auth|api|ai|knowledge|mcp|minio|ui) cmd_deploy "$cmd" "$@" ;;
        all)        cmd_all "$@" ;;
        verify)     cmd_verify "$@" ;;
        teardown)   cmd_teardown "$@" ;;
        preflight)  cmd_preflight "$@" ;;
        help|-h|--help) usage ;;
        *)          usage; die "Unknown command: $cmd" ;;
    esac
}

main "$@"
