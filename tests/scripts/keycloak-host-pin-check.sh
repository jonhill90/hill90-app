#!/usr/bin/env bash
# app-keycloak's own hostname and Traefik router rule must NOT follow
# APP_AUTH_HOST.
#
# APP_AUTH_HOST repoints the app's CONSUMERS (api, mcp, ui) at a different
# Keycloak. If it also moved app-keycloak, then flipping it to "auth" would give
# app-keycloak the rule Host(`auth.hill90.com`) — identical to Hill90's Keycloak
# router, same entrypoint, same Traefik, both on hill90_edge. Traefik would pick
# between them non-deterministically, and app-keycloak has no `platform` realm, so
# Grafana / Portainer / OpenBao SSO would break with nothing deployed to them.
#
# Worse, it is LATENT: Traefik labels bake at container creation, so it would not
# fail at migration time. It would fail on a later unrelated `deploy.sh auth`.
set -uo pipefail
cd "${1:?repo required}" || exit 2
f=deploy/compose/prod/docker-compose.auth.yml
rc=0

# Non-comment lines only: the comments legitimately discuss APP_AUTH_HOST.
if grep -vE '^\s*#' "$f" | grep -q 'APP_AUTH_HOST'; then
    echo "FAIL app-keycloak still derives a value from APP_AUTH_HOST:"
    grep -nvE '^\s*#' "$f" | grep 'APP_AUTH_HOST' | sed 's/^/  /'
    rc=1
fi

# And prove it behaviourally: with APP_AUTH_HOST=auth, the rule must not move.
if command -v docker >/dev/null 2>&1; then
    out=$(APP_AUTH_HOST=auth docker compose -f "$f" \
        --env-file deploy/compose/prod/.env.example config 2>/dev/null \
        | grep -E 'KC_HOSTNAME|routers.app-keycloak.rule' || true)
    if printf '%s' "$out" | grep -qE '[^-]auth\.'; then
        echo "FAIL with APP_AUTH_HOST=auth the container moved onto Hill90's hostname:"
        printf '%s\n' "$out" | sed 's/^/  /'
        rc=1
    fi
fi

[ "$rc" -eq 0 ] && echo PIN_HOLDS
exit $rc
