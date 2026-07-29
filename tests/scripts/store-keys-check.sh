#!/usr/bin/env bash
# Assert every key in the secrets store is actually consumed by something.
#
# The generalisable form of a real defect: AUTH_KEYCLOAK_ISSUER sat in the store
# and in .env.example while docker-compose.ui.yml recomposed the issuer from
# ${APP_AUTH_HOST}/${BASE_DOMAIN}/${KC_REALM} instead of reading it. All three
# parts carry `:-` defaults, so require_compose_interpolation is structurally
# blind — it can never warn. An operator editing AUTH_KEYCLOAK_ISSUER in SOPS to
# repoint the app gets NO effect and NO warning, and the deploy goes green against
# the old issuer.
#
# A store value reaches a container in exactly one way: a compose file
# interpolates it. Anything else is a value someone can edit to no effect.
#
# Uses infra/secrets/prod.enc.env.example, which carries the same key set as the
# encrypted store, so this needs no sops, no age key and no host.
set -uo pipefail
cd "${1:?repo required}" || exit 2

EXAMPLE=infra/secrets/prod.enc.env.example
[ -f "$EXAMPLE" ] || { echo "MISSING_EXAMPLE $EXAMPLE"; exit 2; }

# Keys consumed by the deploy tooling rather than by compose. Each needs a reason.
#   TAILSCALE_IP — read by .github/workflows/reusable-deploy-service.yml to reach
#                  the host; it is never passed to a container.
TOOLING_ONLY="TAILSCALE_IP"

rc=0
for k in $(grep -oE '^[A-Z_]+=' "$EXAMPLE" | tr -d '='); do
    interp=$(grep -rlE '\$\{'"$k"'(:-[^}]*)?\}' deploy/compose 2>/dev/null | wc -l | tr -d ' ')
    [ "$interp" -gt 0 ] && continue

    case " $TOOLING_ONLY " in
        *" $k "*)
            tooling=$(grep -rl "$k" scripts .github/workflows 2>/dev/null | wc -l | tr -d ' ')
            if [ "$tooling" -gt 0 ]; then
                echo "OK_TOOLING $k"
                continue
            fi
            echo "INERT $k (allowlisted as tooling-only, but no tooling reads it either)"
            rc=1
            continue
            ;;
    esac

    echo "INERT $k (in the store, but no compose file interpolates it)"
    rc=1
done

[ "$rc" -eq 0 ] && echo ALL_KEYS_CONSUMED
exit $rc
