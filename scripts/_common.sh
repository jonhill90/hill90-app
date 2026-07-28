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

The app's secrets store is encrypted with its own age key, separate from
Hill90's. To create one:

  mkdir -p infra/secrets/keys
  age-keygen -o infra/secrets/keys/age-${env}.key

then put its public key in infra/secrets/.sops.yaml and encrypt the store:

  sops -e infra/secrets/${env}.env > infra/secrets/${env}.enc.env
  rm infra/secrets/${env}.env

The key file is gitignored and must never be committed."
}

# Decrypt the store and export every variable in it.
#
# The indirection through a temp file with %q quoting is Hill90's, and it is
# there for a reason: values containing spaces, newlines or quotes (the Ed25519
# PEMs do) are mangled by a naive `export $(...)`.
load_secrets() {
    local env="${1:-prod}"
    local secrets_file="${2:-$PROJECT_ROOT/infra/secrets/${env}.enc.env}"

    require_command sops
    ensure_age_key "$env"
    require_file "$secrets_file" "Secrets file"

    local temp_file
    temp_file=$(mktemp)
    # shellcheck disable=SC2064  # early expansion of $temp_file is intentional
    trap "rm -f '$temp_file'" RETURN

    sops -d "$secrets_file" \
        | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' \
        | while IFS='=' read -r key value; do printf '%s=%q\n' "$key" "$value"; done \
        > "$temp_file"

    set -a
    # shellcheck disable=SC1090  # dynamic source of decrypted secrets
    source "$temp_file"
    set +a

    rm -f "$temp_file"
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
