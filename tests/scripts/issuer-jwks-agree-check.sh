#!/usr/bin/env bash
# KEYCLOAK_ISSUER and KEYCLOAK_JWKS_URI must never be able to disagree about which
# host and which realm they point at.
#
# The generalisable form of the bug #26 fixed. The JWKS URI was pinned to
# app-keycloak while the issuer was built from ${APP_AUTH_HOST}/${KC_REALM}, so
# moving APP_AUTH_HOST moved the front channel and left the back channel behind:
# every authenticated call 401s while the login page looks fine, and reverting
# APP_AUTH_HOST alone restores the login page while leaving calls broken — a revert
# that looks like it worked.
#
# OIDC expects the JWKS to correspond to the issuer. Two independently-settable
# values for one relationship is the defect, whichever way they are set.
#
# Passes in exactly three shapes:
#   1. JWKS unset  -> the service derives it from the issuer. Cannot diverge.
#   2. JWKS set    -> it must be literally ${KEYCLOAK_ISSUER}/... so it still
#                     cannot diverge.
#   3. A LOCAL OVERRIDE that diverges on purpose and says so, by carrying the
#      marker DIVERGENCE-INTENTIONAL in a comment on the same service.
#
# Shape 3 exists because locally the divergence is REQUIRED, not sloppy: app
# containers cannot resolve the browser-facing Traefik hostname, which is the same
# reason local.ui.yml carries KEYCLOAK_INTERNAL_ISSUER. Forcing derivation there
# would break local auth. Requiring the marker keeps it a conscious choice rather
# than a silent exemption, and the marker only helps in overrides — prod is checked
# strictly and cannot opt out.
set -uo pipefail
cd "${1:?repo required}" || exit 2
rc=0
found_any=0

for f in deploy/compose/prod/docker-compose.*.yml deploy/compose/overrides/*.yml; do
    [ -f "$f" ] || continue
    body=$(sed -E 's/^[[:space:]]*#.*//' "$f")

    jwks=$(printf '%s\n' "$body" | grep -E 'KEYCLOAK_JWKS_URI' || true)
    [ -z "$jwks" ] && continue
    found_any=1

    issuer=$(printf '%s\n' "$body" | grep -E 'KEYCLOAK_ISSUER[=:]' || true)
    if [ -z "$issuer" ]; then
        echo "FAIL $f sets KEYCLOAK_JWKS_URI but no KEYCLOAK_ISSUER — nothing anchors it"
        rc=1; continue
    fi

    # The only safe form is one that reuses the issuer variable verbatim.
    if printf '%s' "$jwks" | grep -qE '\$\{?KEYCLOAK_ISSUER\}?'; then
        echo "OK $f JWKS derived from KEYCLOAK_ISSUER"
        continue
    fi

    # Shape 3: a local override may diverge deliberately if it says so. Prod may not.
    case "$f" in
        deploy/compose/overrides/*)
            if grep -q 'DIVERGENCE-INTENTIONAL' "$f"; then
                echo "OK $f local override diverges deliberately (marker present)"
                continue
            fi
            echo "FAIL $f local override diverges with no DIVERGENCE-INTENTIONAL marker."
            echo "    If the internal back channel is required here, say so in a comment"
            echo "    containing DIVERGENCE-INTENTIONAL and why."
            rc=1; continue
            ;;
    esac

    echo "FAIL $f KEYCLOAK_JWKS_URI is set independently of KEYCLOAK_ISSUER:"
    printf '%s\n' "$jwks" | sed 's/^/    jwks:   /'
    printf '%s\n' "$issuer" | sed 's/^/    issuer: /'
    echo "    They can disagree about host or realm. Either unset the JWKS URI and let"
    echo "    the service derive it, or write it as \${KEYCLOAK_ISSUER}/protocol/openid-connect/certs."
    rc=1
done

if [ "$rc" -eq 0 ]; then
    [ "$found_any" -eq 0 ] && echo "NO_JWKS_OVERRIDES (all services derive it from the issuer)"
    echo ISSUER_JWKS_CANNOT_DIVERGE
fi
exit $rc
