#!/usr/bin/env bash
# Fetch a real access token and print the role claims that actually matter.
#
# Use this instead of a discovery document or a healthcheck. Both of those pass
# while roles arrive empty, which is the exact failure the migration risks:
# signature valid, iss correct, requireAuth passes, roles = [], admin nav gone,
# every requireRole route 403, all healthchecks green.
#
#   bash docs/runbooks/scripts/token-claims.sh testuser01 '<password>'
#
# NEVER use jon's account for this. Token tests lock accounts and create audit
# noise. testuser01 exists for this purpose — see §2 of the runbook.
set -euo pipefail

USER="${1:?username required (use testuser01, never jon)}"
PASS="${2:?password required}"
ISSUER="${ISSUER:-https://app-auth.hill90.com/realms/hill90}"
CLIENT="${CLIENT:-hill90-ui}"
SECRET="${CLIENT_SECRET:-}"

[ "$USER" = "jon" ] && { echo "refusing: do not use jon's account for token tests" >&2; exit 2; }

args=(-d grant_type=password -d "client_id=$CLIENT" -d "username=$USER" -d "password=$PASS" -d scope=openid)
[ -n "$SECRET" ] && args+=(-d "client_secret=$SECRET")

resp="$(curl -sS --max-time 30 -X POST "${ISSUER}/protocol/openid-connect/token" "${args[@]}")"

python3 - "$resp" <<'PY'
import base64, json, sys
resp = json.loads(sys.argv[1])
if "access_token" not in resp:
    print("NO TOKEN:", json.dumps(resp)[:300]); sys.exit(1)
p = resp["access_token"].split(".")[1]; p += "=" * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))

print("iss                 :", c.get("iss"))
print("sub                 :", c.get("sub"))
print("preferred_username  :", c.get("preferred_username"))
print()
non_standard = c.get("realm_roles")
standard = (c.get("realm_access") or {}).get("roles")
print("realm_roles         :", non_standard, "   <- what ui/auth.ts and api/role.ts READ")
print("realm_access.roles  :", standard, "   <- Keycloak's default, and Hill90's helper default")
print()
if non_standard:
    print("OK: the claim the app reads is populated.")
elif standard:
    print("FAIL: roles exist under realm_access.roles but the app reads realm_roles.")
    print("      Tokens verify, iss matches, requireAuth passes, and every")
    print("      requireRole route will 403 with all healthchecks green.")
    sys.exit(1)
else:
    print("FAIL: no roles under either claim. The mapper is missing entirely."); sys.exit(1)
PY
