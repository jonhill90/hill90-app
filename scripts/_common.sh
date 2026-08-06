#!/usr/bin/env bash
# Shared helpers for hill90-app's scripts.
#
# scripts/provision-akm-db.sh and scripts/provision-litellm-db.sh both `source`
# this at line 7 under `set -e`, so if it is missing they die there — loudly,
# non-zero, before reaching any work they claim to do.
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

    # Split on the FIRST '=' with parameter expansion, not `IFS='=' read`.
    #
    # `while IFS='=' read -r key value` silently dropped a single trailing '=' in
    # bash: AUTH_SECRET=YWJjZGVmZ2g= arrived as YWJjZGVmZ2g. Base64 padding is
    # exactly that shape, and AUTH_SECRET plus both signing keys are base64 -- so a
    # credential could reach a container one character short, with no error anywhere
    # and a deploy that reports success. Curiously '==' survived and '=' did not,
    # which is why this was invisible: half the padded values were fine.
    #
    # ${line%%=*} and ${line#*=} have no field-splitting semantics, so a value
    # keeps every character including '=', quotes, backslashes and '$'. Pinned by
    # tests/scripts/secret-values-survive-shell.bats.
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$temp_file.raw" 2>/dev/null \
        | while IFS= read -r line; do
              printf '%s=%q\n' "${line%%=*}" "${line#*=}"
          done \
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

# ---------------------------------------------------------------------------
# The app's client secret must AUTHENTICATE against the platform Keycloak.
#
# WHY THIS EXISTS
#
# On 2026-07-29 production login had been broken since the app was first deployed,
# and every health check passed the whole time. Keycloak authenticated the user, then
# refused the code-for-token exchange with `unauthorized_client`, one redirect further
# on than any probe had gone.
#
# WHY IT IS AN AUTHENTICATION TEST AND NOT A COMPARISON
#
# The first version read the secret out of Keycloak over the ADMIN API and compared it
# to the store. That worked while the Keycloak was the app's own. It cannot work now:
# the app is a tenant of the platform realm, and a tenant has no business holding the
# platform IdP's admin credentials. It failed closed on the first ui deploy with
# admin_token_status=401 — right behaviour, permanently unsatisfiable.
#
# Token introspection requires CLIENT authentication, so the client's own secret is
# sufficient: 200 means it authenticated, 401 means it did not. That is also a
# stronger property than string equality — two matching strings prove storage agrees,
# a 200 proves the credential works.
#
# The assertion layer never receives the secret. It takes an HTTP status.
# ---------------------------------------------------------------------------

# Pure, testable: maps an introspection status to a verdict.
assert_client_auth() {
    local client="${1:?client id required}" code="${2-}"
    case "$code" in
        200)
            echo "CLIENT_SECRET_WORKS for ${client} (client authenticated against the realm)"
            return 0
            ;;
        401|403)
            echo "CLIENT_SECRET_REJECTED for ${client} (HTTP ${code})"
            echo "  The realm refused this client's credentials, so the secret in the"
            echo "  store is not the secret the realm holds."
            echo ""
            echo "  Consequence: Keycloak will authenticate the USER correctly and then"
            echo "  refuse the code-for-token exchange with unauthorized_client, so login"
            echo "  fails AFTER the password is accepted. No health check can see this."
            echo ""
            echo "  Repair: docs/runbooks/one-keycloak-migration.md (the client-secret"
            echo "  section). Do not regenerate the secret — align it."
            return 1
            ;;
        *)
            echo "CLIENT_SECRET_UNVERIFIABLE for ${client} (HTTP ${code:-<none>})"
            echo "  Neither 200 nor 401: the realm could not be asked. A wrong realm gives"
            echo "  404, an unreachable Keycloak gives no status at all."
            echo "  This is a FAILURE, not a pass. A guard that treats cannot-tell as fine"
            echo "  reports success on the day it was needed."
            return 1
            ;;
    esac
}

# Ask the realm whether the store's secret authenticates. Needs no privileges beyond
# the client's own credentials.
require_client_secret_works() {
    local client="${1:-${AUTH_KEYCLOAK_ID:-hill90-ui}}"
    local realm="${KC_REALM:-platform}"
    local kc_container="${2:-${KEYCLOAK_CONTAINER:-keycloak}}"

    [ -n "${AUTH_KEYCLOAK_SECRET:-}" ] \
        || die "AUTH_KEYCLOAK_SECRET is not in the environment. Load secrets before calling require_client_secret_works."
    docker inspect "$kc_container" >/dev/null 2>&1 \
        || die "${kc_container} is not running, so ${client}'s secret cannot be verified. Failing closed: the one time this matters is the time the container is in an unexpected state."

    # Runs in the Keycloak container's network namespace so it can reach localhost:8080
    # without depending on the edge. The secret goes in via the environment, never argv.
    local code
    code="$(docker run --rm --network "container:${kc_container}" \
              -e SEC="$AUTH_KEYCLOAK_SECRET" -e CID="$client" -e REALM="$realm" \
              python:3.12-alpine python3 -c '
import os, urllib.request, urllib.parse, urllib.error
d = urllib.parse.urlencode({"client_id": os.environ["CID"],
                            "client_secret": os.environ["SEC"],
                            "token": "probe-not-a-real-token"}).encode()
u = "http://localhost:8080/realms/%s/protocol/openid-connect/token/introspect" % os.environ["REALM"]
r = urllib.request.Request(u, data=d, headers={"Content-Type": "application/x-www-form-urlencoded"})
try:
    with urllib.request.urlopen(r, timeout=20) as x:
        print(x.status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print("000")
' 2>/dev/null)" || code=""

    assert_client_auth "$client" "$code" || return 1
}

# app#579: hill90/agentbox and hill90/agentbox-monitor copy the akm CLI out of
# hill90/knowledge at BUILD time (services/agentbox/Dockerfile) — a fact that
# lives only in that Dockerfile, nowhere in the deploy or merge path. So a
# knowledge deploy ships services/knowledge/ changes to hill90/knowledge and
# nowhere else; the agentbox images only pick them up when
# build-agentbox-images.yml is separately, manually re-run. That workflow is
# workflow_dispatch-only ON PURPOSE (it builds on the production host, so it
# follows deploy.yml's manual-only rule — CLAUDE.md invariant 7, a merge must
# not deploy), so a push trigger from services/knowledge/** is not a small
# addition here; it would need to reproduce that whole guarded, host-mutating
# path rather than just add a `paths:` filter. This check is the cheaper half
# of the fix: it does not close the gap, it refuses to let a deploy complete
# without saying the gap is now open.
#
# Reuses check_deploy_drift.sh's own definition of "stale" for these two
# images (its dep_re case for hill90/agentbox|hill90/agentbox-monitor) rather
# than inventing a second one that could quietly disagree with it — see that
# script's own header for why a second definition is worse than none.
#
# $1: the revision the deploy just stamped (deploy.sh's $DEPLOY_REVISION).
require_agentbox_images_not_stale() {
    local deploy_revision="${1:?deploy revision required}"
    local img label n_dep sha

    for img in hill90/agentbox hill90/agentbox-monitor; do
        label="$(docker inspect -f '{{index .Config.Labels "com.hill90.revision"}}' "${img}:latest" 2>/dev/null || true)"

        if [ -z "$label" ] || [ "$label" = "<no value>" ]; then
            echo "${img}:latest does not exist, or carries no com.hill90.revision label."
            echo "Nothing here can say whether it holds the akm CLI this knowledge deploy just shipped."
            return 1
        fi

        if ! git -C "$PROJECT_ROOT" rev-parse --verify --quiet "${label}^{commit}" >/dev/null; then
            echo "${img}:latest is stamped '${label}', which is not a commit in this repository."
            echo "Cannot tell whether it is current."
            return 1
        fi

        n_dep=0
        for sha in $(git -C "$PROJECT_ROOT" rev-list "${label}..${deploy_revision}" 2>/dev/null); do
            # Same dep_re as check_deploy_drift.sh's hill90/agentbox|agentbox-monitor
            # case — both prefixes, not just services/knowledge/, so this cannot
            # quietly disagree with the alarm about what makes these two images stale.
            if git -C "$PROJECT_ROOT" show --name-only --format="" "$sha" | grep -qE '^(services/agentbox/|services/knowledge/)'; then
                n_dep=$((n_dep + 1))
            fi
        done

        if [ "$n_dep" -gt 0 ]; then
            echo "${img}:latest is stamped ${label:0:12}, ${n_dep} services/agentbox/ or services/knowledge/ commit(s) behind the knowledge image just deployed (${deploy_revision:0:12})."
            echo "This is the app#579 gap: knowledge ships, agentbox does not, and nothing else says so."
            return 1
        fi
    done

    return 0
}
