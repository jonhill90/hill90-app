#!/usr/bin/env bash
# Shared helpers for hill90-app's scripts.
#
# This file did not exist. scripts/provision-akm-db.sh and
# scripts/provision-litellm-db.sh both `source` it at line 7 under `set -e`, so
# both died there — loudly, non-zero, before reaching any work they claimed to
# do. It was never extracted from Hill90.
#
# Deliberately modelled on Hill90's scripts/_common.sh rather than designed
# fresh: the two repos should fail the same way, print the same shapes, and load
# secrets by the same mechanism. Where this diverges it is because the app is a
# tenant, and the divergence is commented.

set -euo pipefail

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

_c_red=$'\033[0;31m'; _c_yellow=$'\033[0;33m'; _c_green=$'\033[0;32m'
_c_blue=$'\033[0;34m'; _c_bold=$'\033[1m'; _c_off=$'\033[0m'

die()     { echo "${_c_red}✗${_c_off} $*" >&2; exit 1; }
warn()    { echo "${_c_yellow}!${_c_off} $*" >&2; }
info()    { echo "${_c_blue}i${_c_off} $*"; }
success() { echo "${_c_green}✓${_c_off} $*"; }
banner()  { echo; echo "${_c_bold}$*${_c_off}"; }

require_file() {
    [ -f "$1" ] || die "${2:-File} not found: $1"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "${2:-$1} is required but not installed"
}

# ---------------------------------------------------------------------------
# Secrets
#
# SOPS + age, the same mechanism Hill90 uses. The app has its OWN store and its
# OWN age key: it is a tenant, and reusing Hill90's key would give the app the
# ability to decrypt platform secrets it has no business reading.
#
# Hill90's loader tries OpenBao first and falls back to SOPS. The app has no
# AppRole yet, so this is SOPS-only. The vault path is where it would go, and
# the signature is kept compatible so adding it later does not change callers.
# ---------------------------------------------------------------------------

ensure_age_key() {
    local env="${1:-prod}"
    if [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
        export SOPS_AGE_KEY_FILE="$PROJECT_ROOT/infra/secrets/keys/age-${env}.key"
    fi
    [ -f "$SOPS_AGE_KEY_FILE" ] || die \
"Age key not found: $SOPS_AGE_KEY_FILE

On the VPS the key is the HOST's, shared with Hill90 deliberately, and lives at
/opt/hill90/secrets/keys/keys.txt. The deploy user's .bashrc exports
SOPS_AGE_KEY_FILE to it and the deploy workflow exports it inline as well. If you
are on the VPS and seeing this, that file is missing or unreadable — it is not
something to regenerate here.

Locally, point SOPS_AGE_KEY_FILE at a key whose public half matches
infra/secrets/.sops.yaml, or use APP_ENV_FILE to bypass SOPS entirely."
}

# Decrypt the store and export every variable in it.
#
# The indirection through a temp file with %q quoting is Hill90's, and it is
# there for a reason: values containing spaces, newlines or quotes (the Ed25519
# PEMs do) are mangled by a naive `export $(...)`.
load_secrets() {
    local env="${1:-prod}"
    local secrets_file="${2:-$PROJECT_ROOT/infra/secrets/${env}.enc.env}"

    # Escape hatch for the local path, and the only way this script is testable
    # before a secrets store exists. Hill90's loader has no equivalent because it
    # has always had one. Without this, deploy.sh could not be exercised at all
    # outside a host that already holds the age key — which would mean the first
    # run of the deploy path is also its first test, on the VPS.
    if [ -n "${APP_ENV_FILE:-}" ]; then
        require_file "$APP_ENV_FILE" "Env file"
        warn "using plaintext ${APP_ENV_FILE} instead of the encrypted store (APP_ENV_FILE is set)"
        # Goes through the SAME %q pipeline as the encrypted path, not a naive
        # `source`. Sourcing this file directly fails on the very values the %q
        # indirection exists for: AKM_SIGNING_PRIVATE_KEY is an unquoted PEM
        # containing spaces, so bash splits it and reports
        #   .env.local: line 29: PRIVATE: command not found
        # then `set -e` kills the deploy. Found by running it.
        _export_env_pairs < "$APP_ENV_FILE"
        return 0
    fi

    require_command sops
    ensure_age_key "$env"
    require_file "$secrets_file" "Secrets file"

    local temp_file
    temp_file=$(mktemp)
    # shellcheck disable=SC2064  # early expansion of $temp_file is intentional
    trap "rm -f '$temp_file'" RETURN

    # Decrypt to the temp file, THEN feed _export_env_pairs by redirect.
    #
    # This was `sops -d "$secrets_file" | _export_env_pairs`, and that shipped a
    # production incident. The right-hand side of a pipe runs in a subshell, so
    # the function's `set -a; source` exported into a shell that exited
    # immediately and nothing reached the caller. Every variable arrived unset,
    # `docker compose` substituted "" for each one with only a warning, the
    # container still reported healthy: its healthcheck GETs /api/health and asserts
    # 200, which does not touch auth, and hill90.com served
    # app-ui with AUTH_SECRET empty and /api/auth/signin returning 500
    # MissingSecret.
    #
    # The temp file was already being created here and never used — the redirect
    # was the original intent. Do not reintroduce the pipe; the shape is asserted
    # against in tests/scripts/secrets-loader.bats.
    sops -d "$secrets_file" > "$temp_file"
    # An empty decryption previously died with no message at all: the grep inside
    # _export_env_pairs failed on a file that was never created, and pipefail plus
    # set -e killed the script silently.
    [ -s "$temp_file" ] || die "sops decrypted ${secrets_file} to nothing.
The file exists but produced no output. Check that SOPS_AGE_KEY_FILE
(${SOPS_AGE_KEY_FILE:-unset}) holds a key that can decrypt this store."
    _export_env_pairs < "$temp_file"
}

# ---------------------------------------------------------------------------
# Assert that named variables are set AND non-empty.
#
# This is the cause fix rather than the symptom fix. A loader that silently
# exports nothing must not be able to produce a green deploy again, and the
# failure mode here was empty-string rather than unset — so a presence-only
# check (`[ -v NAME ]`, or `${NAME+x}`) would have passed on the broken system.
# Same class as the pg_isready gate that reported a healthy database it could not
# authenticate to.
# ---------------------------------------------------------------------------
require_secrets() {
    [ $# -gt 0 ] || die "require_secrets called with no arguments — that is a bug in the caller, not a passing check"

    local missing=() name
    for name in "$@"; do
        # printenv reads the EXPORTED ENVIRONMENT, not the shell variable.
        #
        # That distinction is the whole point. `docker compose` is a child process
        # and interpolates from the environment, so a variable that is set in this
        # shell but not exported is invisible to it. An earlier version of this
        # function used [ -z "${!name:-}" ], which reads the shell variable — and
        # an audit proved that removing `set -a` from _export_env_pairs reproduced
        # the entire production incident with the whole test suite still green:
        # variables set, gate satisfied, compose substituting "" anyway.
        #
        # Checking printenv means this gate sees exactly what compose will see.
        if [ -z "$(printenv "$name" 2>/dev/null)" ]; then missing+=("$name"); fi
    done
    [ ${#missing[@]} -eq 0 ] && return 0

    die "These variables are unset or EMPTY after loading secrets:

$(printf '  %s\n' "${missing[@]}")
Each is required by the stack being deployed. An empty value is not a missing
key: the secrets store may be correct while the loader failed to export it, which
is what caused hill90.com to serve app-ui with a blank AUTH_SECRET.

Check in this order:
  1. sops -d infra/secrets/<env>.enc.env | grep '^<KEY>='   is it in the store?
  2. does load_secrets run in the caller's shell, not a subshell or pipe?
  3. is SOPS_AGE_KEY_FILE pointing at a key that can decrypt this store?"
}

# Read KEY=VALUE lines on stdin and export them, quoting each value so that
# spaces and quotes survive. A naive `source` mangles both, and the Ed25519 PEMs
# contain them.
#
# VALUES MUST BE SINGLE-LINE. An earlier version of this comment claimed newlines
# survived too. They do not: the KEY= filter below drops every continuation line
# of a multi-line value before the quoting ever sees it, so a pasted real PEM
# became just its "-----BEGIN PRIVATE KEY-----" header with no warning and no
# non-zero exit. That produces a truncated signing key, a deploy that completes
# and passes readiness, and token signing that fails later under an unrelated
# symptom.
#
# Rather than silently drop them, unparsable lines are now an error. Inline PEMs
# with \n escapes, as infra/secrets/prod.enc.env.example shows.
_export_env_pairs() {
    local temp_file rejected
    temp_file=$(mktemp)
    rejected=$(mktemp)
    # shellcheck disable=SC2064  # early expansion is intentional
    trap "rm -f '$temp_file' '$rejected'" RETURN

    # Split the stream: assignments through, everything else (excluding blanks
    # and comments) into the reject pile so it can be reported rather than lost.
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ''|'#'*) continue ;;
            *)
                if printf '%s' "$line" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*='; then
                    printf '%s\n' "$line" >> "$temp_file.raw"
                else
                    printf '%s\n' "$line" >> "$rejected"
                fi
                ;;
        esac
    done

    if [ -s "$rejected" ]; then
        warn "These lines are not KEY=VALUE assignments and were NOT loaded:"
        sed 's/^/    /' "$rejected" >&2
        die "Refusing to continue with a partially loaded secrets set.
This is almost always a multi-line value -- a PEM pasted across several lines.
Inline it with backslash-n escapes so the whole key is on one line; see
infra/secrets/prod.enc.env.example. Silently dropping the body would give you a
truncated signing key and a deploy that looks entirely successful."
    fi

    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$temp_file.raw" 2>/dev/null \
        | while IFS='=' read -r key value; do printf '%s=%q\n' "$key" "$value"; done \
        > "$temp_file"
    rm -f "$temp_file.raw"

    set -a
    # shellcheck disable=SC1090  # dynamic source of quoted pairs
    source "$temp_file"
    set +a

    rm -f "$temp_file"
}

# ---------------------------------------------------------------------------
# Materialise the AKM public keys into the akm-keys volume.
#
# services/knowledge reads /etc/akm/public.pem and services/ai reads
# /etc/akm/model-router-public.pem, both from the shared `akm-keys` volume which
# they mount read-only. Nothing populated that volume, so on the VPS it was empty:
# knowledge crash-looped with
#   FileNotFoundError: [Errno 2] No such file or directory: '/etc/akm/public.pem'
# and ai started but reported {"status":"not_ready","errors":["public_key_not_loaded"]},
# giving 503 on /health/ready and an unhealthy container.
#
# The store holds the PRIVATE halves. This mirrors gen_keys() in scripts/local.sh,
# which is the app's own established mechanism: derive the public halves with
# `openssl pkey -pubout` and use exactly the filenames the services expect. Hill90
# has no equivalent to copy — no compose `secrets:` blocks and no key-writing step
# anywhere — so there is no platform pattern being diverged from here.
#
# The escapes matter. The store keeps PEMs inlined with literal \n, because
# _export_env_pairs requires single-line values. `printf '%b'` expands them back to
# real newlines. A PEM written with literal backslash-n parses as garbage, and
# openssl would accept the file and fail later somewhere else — so each key is
# parsed immediately after writing and the deploy dies here if it does not.
# ---------------------------------------------------------------------------

akm_volume() { printf '%s_app-akm-keys' "${VOLUME_PREFIX:-prod}"; }

materialise_akm_keys() {
    local vol tmp
    vol="$(akm_volume)"

    require_secrets AKM_SIGNING_PRIVATE_KEY MODEL_ROUTER_SIGNING_PRIVATE_KEY

    tmp="$(mktemp -d)"
    chmod 700 "$tmp"
    # shellcheck disable=SC2064  # early expansion is intentional
    trap "rm -rf '$tmp'" RETURN

    # %b expands the \n escapes the store keeps them inlined with.
    printf '%b\n' "$AKM_SIGNING_PRIVATE_KEY"          > "$tmp/akm-private.pem"
    printf '%b\n' "$MODEL_ROUTER_SIGNING_PRIVATE_KEY" > "$tmp/model-router-private.pem"
    chmod 600 "$tmp"/*.pem

    # Parse immediately. If the escapes were not expanded, this is where it fails —
    # not later, elsewhere, in a service that cannot say why.
    local name
    for name in akm model-router; do
        openssl pkey -in "$tmp/$name-private.pem" -noout 2>/dev/null || die \
"${name} private key did not parse as a key after expanding escapes.

Almost certainly the value reached this shell with literal backslash-n rather than
real newlines. A PEM written that way is accepted by the filesystem and rejected by
whatever reads it later, which is the failure mode this check exists to stop."
    done

    # Names are exactly what the services expect:
    #   knowledge  AKM_PUBLIC_KEY_PATH=/etc/akm/public.pem
    #   ai         PUBLIC_KEY_PATH=/etc/akm/model-router-public.pem
    openssl pkey -in "$tmp/akm-private.pem"          -pubout -out "$tmp/public.pem"
    openssl pkey -in "$tmp/model-router-private.pem" -pubout -out "$tmp/model-router-public.pem"

    # Seed the volume by piping through a throwaway container. Avoids bind-mounting
    # a host path and avoids leaving the private halves anywhere near the volume —
    # only the public halves are copied in.
    local pub
    for pub in public.pem model-router-public.pem; do
        docker run --rm -i -v "${vol}:/out" alpine:3 \
            sh -c "cat > /out/${pub} && chmod 644 /out/${pub}" < "$tmp/$pub" \
            || die "could not write ${pub} into volume ${vol}"
    done

    # Verify from inside the volume, not from the temp dir: this asserts what the
    # services will actually read.
    docker run --rm -v "${vol}:/out" alpine:3 \
        sh -c 'set -e; for f in /out/public.pem /out/model-router-public.pem; do
                   [ -s "$f" ] || { echo "missing or empty: $f" >&2; exit 1; }
                   head -1 "$f" | grep -q "BEGIN PUBLIC KEY" || { echo "not a PEM header: $f" >&2; exit 1; }
               done' \
        || die "the akm-keys volume does not contain valid public keys after seeding"

    success "akm public keys materialised into ${vol} (public.pem, model-router-public.pem)"
}

# ---------------------------------------------------------------------------
# Fail if docker compose cannot interpolate ANY variable.
#
# require_secrets covers a named list, which is one instance deep: it cannot catch
# a variable nobody remembered to list. This covers the class, because compose
# reports every substitution it could not make:
#
#   level=warning msg="The \"AUTH_SECRET\" variable is not set. Defaulting to a
#   blank string."
#
# That warning is the exact signal that was present and ignored during the
# hill90.com incident. Treating it as fatal is what turns a green deploy with
# blank secrets into a refused deploy.
# ---------------------------------------------------------------------------
require_compose_interpolation() {
    local out unset_vars
    out="$(docker compose "$@" config 2>&1 >/dev/null)" || true
    # `|| true` is load-bearing. When compose interpolates everything — the healthy
    # case — grep matches nothing and returns 1, and under the `set -euo pipefail`
    # at the top of this file that killed the whole deploy SILENTLY, with no
    # message and exit 1. It failed exactly when there was nothing wrong, which is
    # how it took down the first knowledge deploy after being added.
    # The quotes in compose's warning are BACKSLASH-ESCAPED, because the message is
    # embedded in a logfmt msg="..." field:
    #   level=warning msg="The \\"AUTH_SECRET\\" variable is not set. Defaulting..."
    # An earlier pattern here expected bare quotes, matched nothing, and made this
    # gate silently inert — it returned 0 on a compose file with an unset variable.
    # `\\?` tolerates both forms so it does not depend on compose's log format.
    unset_vars="$(printf '%s\n' "$out" \
        | grep -oE 'The \\?"[A-Za-z_][A-Za-z0-9_]*\\?" variable is not set' \
        | sed -E 's/.*The \\?"([A-Za-z_][A-Za-z0-9_]*)\\?".*/\1/' | sort -u || true)"

    [ -z "$unset_vars" ] && return 0

    die "docker compose could not interpolate these variables:

$(printf '  %s\n' $unset_vars)
Compose does NOT fail on these — it warns and substitutes an empty string, which
is how hill90.com came to serve app-ui with a blank AUTH_SECRET while the deploy
reported success. Treated as fatal here.

Either the value is missing from the secrets store, or it was not exported into
this shell. Check both."
}

# ---------------------------------------------------------------------------
# Tenancy contract
#
# The app is a tenant of Hill90. It does not create the shared networks and must
# not try to. Checking them by name up front turns Compose's
#
#     network hill90_edge declared as external, but could not be found
#
# — which points at the network rather than at the cause — into a statement of
# which contract term is unmet and who owns it.
# ---------------------------------------------------------------------------

network_prefix() { printf '%s' "${NETWORK_PREFIX:-hill90}"; }

require_infra_networks() {
    local pfx missing=()
    pfx="$(network_prefix)"
    for n in "${pfx}_edge" "${pfx}_internal" "${pfx}_agent_internal"; do
        docker network inspect "$n" >/dev/null 2>&1 || missing+=("$n")
    done
    [ ${#missing[@]} -eq 0 ] && return 0
    die "Hill90's shared networks are missing:

$(printf '  %s\n' "${missing[@]}")
These are created by the Hill90 infrastructure repo, not by this one. The app is
a tenant and cannot start until the platform is up. Deploy Hill90's infra stack
first, or if NETWORK_PREFIX is wrong here, correct it — it is currently
'${pfx}'."
}

# services/api bind-mounts this host directory into itself AND passes the same
# path to every agent container it creates, so it is a contract term with the
# host in the same way the shared networks are.
#
# If it is missing, Docker does NOT fail. It auto-creates the bind-mount source
# as a root-owned directory and carries on, so api starts, reports healthy and
# passes cmd_verify -- the deploy succeeds by every signal the script has. The
# failure surfaces later, elsewhere, as agent config writes failing: a different
# symptom in a different component from the cause. This estate has already been
# bitten by an agentbox-configs permissions problem, so it is a known shape.
#
# Locally the override points this somewhere that exists, so the production
# default has never been exercised.
require_agentbox_path() {
    local p="${AGENTBOX_CONFIG_HOST_PATH:-/opt/hill90/agentbox-configs}"

    [ -e "$p" ] || die "AGENTBOX_CONFIG_HOST_PATH does not exist: ${p}

Docker would not fail on this. It would create the path as a root-owned
directory, api would start and report healthy, and the deploy would look
entirely successful -- then agent config writes would fail later, in a different
component. Create it with the right ownership first:

  sudo mkdir -p ${p} && sudo chown \$(id -u):\$(id -g) ${p}"

    [ -d "$p" ] || die "AGENTBOX_CONFIG_HOST_PATH exists but is not a directory: ${p}"

    [ -w "$p" ] || die "AGENTBOX_CONFIG_HOST_PATH is not writable by $(id -un): ${p}

Owned by $(stat -f '%Su:%Sg' "$p" 2>/dev/null || stat -c '%U:%G' "$p" 2>/dev/null).
api and every agent container write here. Fix ownership before deploying."

    success "agentbox config path writable: ${p}"
}

# Traefik middlewares the app's routers reference but does not define. A router
# naming an undefined middleware is ERRORED by Traefik and serves nothing, so it
# is a total outage of that route with no obvious cause. Cheap to check, and the
# check is why mcp-strip was caught before a deploy rather than after one.
require_file_middlewares() {
    local missing=() mw
    for mw in "$@"; do
        docker exec "${TRAEFIK_CONTAINER:-traefik}" \
            sh -c "grep -rqs '^    ${mw}:' /etc/traefik/dynamic/" 2>/dev/null \
            || missing+=("$mw")
    done
    [ ${#missing[@]} -eq 0 ] && return 0
    warn "Traefik does not appear to define: ${missing[*]}"
    warn "A router naming an undefined middleware serves nothing. Verify before deploying."
    return 1
}
