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
  all         Runbook steps 12-13: deploy ui alone, STOP for confirmation in
              prod, then the rest in dependency order. Continue with
              CONFIRM_PUBLIC_DEPLOY=1.
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

# Runbook §3 steps 12-13. `ui` is deployed ALONE and FIRST: it is the certificate
# experiment and the first live routing test, it has no dependency on the
# contested Keycloak, and hill90.com is currently unrouted so there is nothing to
# displace. Everything else follows in dependency order, api before ai and
# knowledge because it is the sole creator of agent_sandbox and docker_proxy.
DEPLOY_FIRST="ui"
DEPLOY_REST="db auth api ai knowledge mcp minio"
DEPLOY_ORDER="$DEPLOY_FIRST $DEPLOY_REST"

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
            if [ "$status" = "healthy" ]; then
                success "${c}: healthy"
                break
            fi
            # A container with no healthcheck can only ever report "running", so
            # without this it would poll until timeout. Accept it, but say so --
            # it is a weaker claim than healthy, and a service added later
            # without a healthcheck would otherwise silently downgrade
            # verification to "the process started" while still printing a tick.
            if [ "$status" = "running" ] && [ -z "$(docker inspect --format '{{if .State.Health}}yes{{end}}' "$c" 2>/dev/null)" ]; then
                warn "${c}: running, but it declares NO healthcheck — verified only that the process started"
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

    stack_assert "$stack"
    success "${stack} ready"
}

# A container being healthy is not the same as the stack being usable, and for
# Postgres the difference is the whole point.
#
# The compose healthcheck is `pg_isready -U $DB_USER`, which reports only that
# the server is accepting connections. It does NOT authenticate and exits 0 on a
# Postgres whose credentials are entirely broken. Hill90's deploy.sh carries a
# comment saying exactly that above its own check, and runs a real query as the
# real user instead. This script copied the loop and left the correction behind,
# so `auth` could be cleared to deploy against a Postgres it cannot authenticate
# to -- and Keycloak would crash-loop with
#   FATAL: password authentication failed for user "hill90"
# which reads as a secrets problem and is not. This estate has already hit that
# exact message once, from a different cause.
#
# Locally the password comes from a known-good .env.local. On the VPS it comes
# from a SOPS store populated by hand, so the one gate that cannot detect a wrong
# password was guarding the only environment where a wrong password is likely.
stack_assert() {
    local stack="$1" c
    case "$stack" in
        db)
            c="$(cname app-postgres)"
            docker exec "$c" psql -U "${DB_USER:-hill90}" -tAc 'SELECT 1' >/dev/null 2>&1 \
                || die "${c} is accepting connections but a real query as '${DB_USER:-hill90}' failed.
That is an authentication or role problem, not a startup problem. pg_isready
would have passed here. Check DB_USER/DB_PASSWORD in the secrets store."
            success "${c}: authenticated query as ${DB_USER:-hill90}"
            ;;
    esac
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

    require_agentbox_path

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
            # A real query as the real user, not pg_isready -- see stack_assert.
            docker exec "$(cname app-postgres)" psql -U "${DB_USER:-hill90}" -tAc 'SELECT 1' >/dev/null 2>&1 \
                || die "Cannot deploy auth: a query against the app's postgres as
'${DB_USER:-hill90}' failed. Keycloak stores its realm there and would crash-loop
with a password-authentication error that reads as a secrets problem.
Deploy the database first:  bash scripts/deploy.sh db ${env}"
            ;;
        ai|knowledge)
            local pfx; pfx="$(network_prefix)"
            docker network inspect "${pfx}_agent_sandbox" >/dev/null 2>&1 \
                || die "Cannot deploy ${stack}: network ${pfx}_agent_sandbox does not exist.
docker-compose.api.yml is its sole creator, and ${stack} consumes it as external.
Deploy api first:  bash scripts/deploy.sh api ${env}"
            ;;
    esac

    # container_name is fixed, so only one Compose project can own a given
    # container at a time. If another project already holds one of this stack's
    # names -- typically because `scripts/local.sh --infra` brought the app up
    # under the single `hill90-local` project -- Compose fails with a bare
    # "container name is already in use" naming a hex id, which says nothing
    # about which project owns it or how to release it.
    #
    # Hill90 auto-removes colliding containers from a known old project. This
    # refuses instead: removing containers belonging to another project is not
    # something a deploy should do without being asked.
    local owner cn
    for cn in $(stack_containers "$stack"); do
        cn="$(cname "$cn")"
        owner="$(docker inspect "$cn" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
        if [ -n "$owner" ] && [ "$owner" != "$project_name" ]; then
            die "Container ${cn} is already owned by Compose project '${owner}', not '${project_name}'.
Two projects cannot share a container_name. Release it first, then retry:
  docker compose -p ${owner} ... down
or, if it came from the local tenant path:
  ./scripts/local.sh down --infra"
        fi
    done

    load_secrets "$env"

    local -a files=(-f "$compose_file")
    if [ "${USE_LOCAL_OVERRIDE:-0}" = "1" ]; then
        local ov; ov="$(stack_override "$stack")"
        require_file "$ov" "Override file"
        files+=(-f "$ov")
        info "layering local override: ${ov}"
    fi

    # build and pull BEFORE up, matching Hill90's deploy.sh.
    #
    # Five of the eight stacks build from local source and are tagged
    # image: hill90/<svc>:${VERSION:-latest}. Compose builds only when the tagged
    # image is ABSENT, so without this the first deploy on a clean host builds and
    # works, and every deploy after it finds the tag present and reuses it. A
    # deploy following a code change would then ship nothing, complete cleanly,
    # and pass its own readiness check -- the container is healthy, it is simply
    # the old one. There is no error anywhere, which is what makes it dangerous.
    #
    # --ignore-buildable so `pull` does not try to fetch images this repo builds.
    docker compose -p "$project_name" "${files[@]}" build --parallel
    docker compose -p "$project_name" "${files[@]}" pull --ignore-buildable
    docker compose -p "$project_name" "${files[@]}" up -d

    cmd_verify "$stack" "$env"
    success "${stack} deployed"
}

# `all` implements runbook §3 steps 12-13, including the stop between them.
#
# It previously brought up all eight stacks in one invocation with `ui` LAST,
# which inverted the one ordering decision the runbook argues for at length and
# published eight services with no gate. Production Traefik sets no provider
# constraints (§4.2), so every container with traefik.enable and a Host rule is
# live on the public internet the moment it starts -- there is no dry-run and no
# disabled state. §4.4 adds that a crash-looping stack during a bulk bring-up is
# the realistic way the 5-failed-validations-per-hostname-per-hour ACME budget
# gets consumed.
#
# A convenience verb that contradicts the document it implements is worse than no
# verb, so this now follows the document.
cmd_all() {
    local env="${1:-prod}"
    cmd_preflight

    banner "Step 12 — ${DEPLOY_FIRST} alone"
    echo "  The certificate experiment and the first live routing test."
    echo
    cmd_deploy "$DEPLOY_FIRST" "$env"

    if [ "$env" = "prod" ] && [ "${CONFIRM_PUBLIC_DEPLOY:-0}" != "1" ]; then
        banner "Stopped, as the runbook requires"
        cat <<EOF
  ${DEPLOY_FIRST} is deployed. Confirm it before continuing — this single step
  answers the only genuinely unproven question in the plan:

    curl -sI https://\${BASE_DOMAIN:-hill90.com}
      expect a real certificate, NOT CN=TRAEFIK DEFAULT CERT
    the four existing DNS-01 certificates must be untouched
    Hill90 baseline: 13 containers, 0 unhealthy

  Then deploy the rest:
    CONFIRM_PUBLIC_DEPLOY=1 bash scripts/deploy.sh all ${env}

  Each remaining stack becomes public the moment it starts. To go one at a time
  instead:  bash scripts/deploy.sh <stack> ${env}
EOF
        return 0
    fi

    banner "Step 13 — the remainder, in dependency order"
    for stack in $DEPLOY_REST; do
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
