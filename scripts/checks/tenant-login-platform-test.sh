#!/usr/bin/env bash
# Complete a REAL authorization-code login against the LOCAL PLATFORM Keycloak
# and assert the token the tenant depends on.
#
# This is the tenant-side mirror of Hill90's scripts/checks/tenant-login-local-test.sh.
# It exists because "the login form appeared" and "a token came back" are different
# claims, and because until 2026-08-01 a local login authenticated against the app's
# OWN Keycloak — proving the realm design and nothing about the tenancy.
#
# Four assertions, and each fails a different way:
#   resource_access.hill90-ui.roles   authorisation is by CLIENT role
#   aud includes hill90-api           the api rejects tokens that fail audience validation
#   no 'admin' in realm_access.roles   the realm role grants Grafana Admin and OpenBao;
#                                      an app admin must not inherit infrastructure admin
#   iss ends /realms/platform          it is HILL90's realm, not a local fork of it
#
# A VERIFY_PROFILE diversion is detected explicitly: a seeded account missing email,
# firstName or lastName lands on required-action?execution=VERIFY_PROFILE, which looks
# EXACTLY like rejected credentials.
#
# Usage: bash scripts/checks/tenant-login-platform-test.sh [.env.local] [user] [pass]
# Exits 0 with SKIP when the local stack is not running, so it is safe anywhere.
set -uo pipefail
ENVF="${1:-.env.local}"; U="${2:-dev}"; P="${3:-dev}"
[ -f "$ENVF" ] || { echo "SKIP: no $ENVF — bring the local stack up first"; exit 0; }
curl -s -o /dev/null --max-time 5 http://auth.localtest.me:8080/realms/platform \
  || { echo "SKIP: the local platform Keycloak is not reachable"; exit 0; }
BASE="http://auth.localtest.me:8080"
REALM="platform"; CID="hill90-ui"
REDIRECT="http://localhost:13000/api/auth/callback/keycloak"
SECRET=$(grep -E '^AUTH_KEYCLOAK_SECRET=' "$ENVF" | cut -d= -f2-)
CJ=$(mktemp)
AUTH_URL="$BASE/realms/$REALM/protocol/openid-connect/auth?client_id=$CID&response_type=code&scope=openid&redirect_uri=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$REDIRECT")"
FORM=$(curl -s -c "$CJ" "$AUTH_URL")
ACTION=$(printf '%s' "$FORM" | python3 -c "
import sys,re,html
m=re.search(r'action=\"([^\"]+)\"', sys.stdin.read())
print(html.unescape(m.group(1)) if m else '')")
[ -n "$ACTION" ] || { echo 'NO LOGIN FORM'; exit 1; }
LOC=$(curl -s -b "$CJ" -c "$CJ" -o /dev/null -D- -d "username=$U" -d "password=$P" "$ACTION" | grep -i '^location:' | tr -d '\r' | sed 's/^[Ll]ocation: //')
case "$LOC" in
  *VERIFY_PROFILE*) echo "DIVERTED TO VERIFY_PROFILE (missing email/firstName/lastName)"; exit 1;;
esac
CODE=$(printf '%s' "$LOC" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$CODE" ] || { echo "NO AUTHORIZATION CODE. Location: $LOC"; exit 1; }
TOK=$(curl -s -d grant_type=authorization_code -d "client_id=$CID" -d "client_secret=$SECRET" \
     -d "code=$CODE" -d "redirect_uri=$REDIRECT" \
     "$BASE/realms/$REALM/protocol/openid-connect/token")
rm -f "$CJ"
printf '%s' "$TOK" | python3 -c '
import sys,json,base64
d=json.load(sys.stdin)
if "access_token" not in d: print("  FAIL no access_token:",d); sys.exit(1)
p=d["access_token"].split(".")[1]; p+="="*(-len(p)%4)
c=json.loads(base64.urlsafe_b64decode(p))
ra=c.get("resource_access",{}).get("hill90-ui",{}).get("roles",[])
aud=c.get("aud"); aud=[aud] if isinstance(aud,str) else (aud or [])
rr=c.get("realm_access",{}).get("roles",[]) or []
checks=[("resource_access.hill90-ui.roles present",bool(ra),ra),
        ("aud includes hill90-api","hill90-api" in aud,aud),
        ("no admin in realm_access.roles","admin" not in rr,rr),
        ("iss is realm platform",str(c.get("iss","")).endswith("/realms/platform"),c.get("iss"))]
bad=0
for n,ok,v in checks:
    print(("  PASS  " if ok else "  FAIL  ")+n+"  ->  "+str(v))
    bad += 0 if ok else 1
sys.exit(1 if bad else 0)'

