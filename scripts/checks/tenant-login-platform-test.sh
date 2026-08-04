#!/usr/bin/env bash
# Complete a REAL authorization-code login against the LOCAL PLATFORM Keycloak,
# USING THE PARAMETERS THE RUNNING UI ACTUALLY SENDS, and assert the token the
# tenant depends on.
#
# This is the tenant-side mirror of Hill90's scripts/checks/tenant-login-local-test.sh.
# It exists because "the login form appeared" and "a token came back" are different
# claims, and because until 2026-08-01 a local login authenticated against the app's
# OWN Keycloak — proving the realm design and nothing about the tenancy.
#
# EVERY REQUEST PARAMETER IS READ FROM THE UI CONTAINER, not from this file and not
# from an env file. That is the correction made for #271, and it is the part to keep
# if this script is ever edited:
#
#   redirect_uri   derived from the UI's AUTH_URL — the value NextAuth canonicalises
#                  every URL to, so it is what a browser carries to Keycloak
#   client_id      the UI's AUTH_KEYCLOAK_ID
#   client_secret  the UI's AUTH_KEYCLOAK_SECRET
#   issuer/realm   the UI's AUTH_KEYCLOAK_ISSUER
#
# Until 2026-08-04 line 32 read
#     REDIRECT="http://localhost:13000/api/auth/callback/keycloak"
# while the UI sent `http://app.localtest.me:8080/api/auth/callback/keycloak`. All four
# token assertions passed on a stack where no human could sign in: a check that hardcodes
# a parameter can never fail on that parameter being wrong. The secret had drifted the
# same way — it was grepped from .env.local, which is not the value the UI holds.
#
# Six assertions, and each fails a different way:
#   the client accepts the UI's redirect_uri   a browser login is a 400 otherwise, and
#                                              this is the ONLY assertion that sees it
#   the authorization code exchanges           proves the secret the UI holds is the
#                                              secret the client expects
#   resource_access.hill90-ui.roles            authorisation is by CLIENT role
#   aud includes hill90-api                    the api rejects tokens that fail audience
#                                              validation
#   no 'admin' in realm_access.roles           the realm role grants Grafana Admin and
#                                              OpenBao; an app admin must not inherit
#                                              infrastructure admin
#   iss ends /realms/platform                  it is HILL90's realm, not a local fork —
#                                              still asserted against the literal
#                                              `platform`, because the issuer the UI
#                                              carries is itself what is under test
#
# A VERIFY_PROFILE diversion is detected explicitly: a seeded account missing email,
# firstName or lastName lands on required-action?execution=VERIFY_PROFILE, which looks
# EXACTLY like rejected credentials.
#
# Usage: bash scripts/checks/tenant-login-platform-test.sh [.env.local] [user] [pass]
#   The env file is consulted for ONE thing — CONTAINER_PREFIX, i.e. which UI container
#   to interrogate. Override with UI_CONTAINER=... for a custom name.
# Exits 0 with SKIP when the local stack is not running, so it is safe anywhere.
set -uo pipefail
ENVF="${1:-.env.local}"; U="${2:-dev}"; P="${3:-dev}"
[ -f "$ENVF" ] || { echo "SKIP: no $ENVF — bring the local stack up first"; exit 0; }
command -v docker >/dev/null 2>&1 || { echo "SKIP: no docker on PATH"; exit 0; }

CPFX=$(grep -E '^CONTAINER_PREFIX=' "$ENVF" | tail -1 | cut -d= -f2-)
UI_CONTAINER="${UI_CONTAINER:-${CPFX}app-ui}"
docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$UI_CONTAINER" \
  || { echo "SKIP: the UI container ($UI_CONTAINER) is not running — bring the local stack up first"; exit 0; }

# Read from the container, never from a file. A missing value is a FAIL rather than a
# fallback: a fallback is how the hardcode this script exists to prevent comes back.
ui_env() { docker exec "$UI_CONTAINER" printenv "$1" 2>/dev/null | tr -d '\r'; }
APP_URL=$(ui_env AUTH_URL); [ -n "$APP_URL" ] || APP_URL=$(ui_env NEXTAUTH_URL)
[ -n "$APP_URL" ] || { echo "FAIL: $UI_CONTAINER declares neither AUTH_URL nor NEXTAUTH_URL, so nothing here can know what redirect_uri a browser would be sent with"; exit 1; }
CID=$(ui_env AUTH_KEYCLOAK_ID)
SECRET=$(ui_env AUTH_KEYCLOAK_SECRET)
ISSUER=$(ui_env AUTH_KEYCLOAK_ISSUER)
[ -n "$CID" ]    || { echo "FAIL: $UI_CONTAINER has no AUTH_KEYCLOAK_ID — the UI cannot log anyone in either"; exit 1; }
[ -n "$SECRET" ] || { echo "FAIL: $UI_CONTAINER has no AUTH_KEYCLOAK_SECRET — the UI cannot log anyone in either"; exit 1; }
[ -n "$ISSUER" ] || { echo "FAIL: $UI_CONTAINER has no AUTH_KEYCLOAK_ISSUER — the UI cannot log anyone in either"; exit 1; }

REDIRECT="${APP_URL%/}/api/auth/callback/keycloak"
BASE="${ISSUER%%/realms/*}"
REALM="${ISSUER##*/realms/}"; REALM="${REALM%%/*}"

curl -s -o /dev/null --max-time 5 "$ISSUER" \
  || { echo "SKIP: the local platform Keycloak is not reachable at $ISSUER"; exit 0; }

echo "  as configured on $UI_CONTAINER:"
echo "    client_id     $CID"
echo "    issuer        $ISSUER"
echo "    redirect_uri  $REDIRECT"

enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
CJ=$(mktemp)
AUTH_EP="$BASE/realms/$REALM/protocol/openid-connect/auth?client_id=$(enc "$CID")&response_type=code&scope=openid&redirect_uri=$(enc "$REDIRECT")"
RESP=$(curl -s -c "$CJ" -w '\n%{http_code}' "$AUTH_EP")
STATUS="${RESP##*$'\n'}"; FORM="${RESP%$'\n'*}"

# The assertion #271 needed and no earlier version of this script could make: does the
# client accept the redirect the UI sends? Keycloak answers 400 with this exact string,
# and without this branch the failure surfaces as the far vaguer "NO LOGIN FORM".
case "$FORM" in
  *"Invalid parameter: redirect_uri"*)
    echo "  FAIL  the client rejects the redirect_uri the UI sends  ->  $REDIRECT"
    echo "        HTTP $STATUS from $BASE/realms/$REALM/protocol/openid-connect/auth"
    echo "        A BROWSER LOGIN CANNOT COMPLETE. Two ways out, and they are not equivalent:"
    echo "        (a) point the UI's AUTH_URL at a host the client already allows"
    echo "            (deploy/compose/overrides/local.ui.yml), or"
    echo "        (b) teach the client this callback — that is HILL90's realm, written by"
    echo "            its scripts/local.sh via keycloak.sh tenant-clients, and webOrigins"
    echo "            needs the same origin or NextAuth's browser calls fail CORS instead."
    rm -f "$CJ"; exit 1;;
esac
ACTION=$(printf '%s' "$FORM" | python3 -c "
import sys,re,html
m=re.search(r'action=\"([^\"]+)\"', sys.stdin.read())
print(html.unescape(m.group(1)) if m else '')")
[ -n "$ACTION" ] || { echo "  FAIL  no login form (HTTP $STATUS) for redirect_uri $REDIRECT"; rm -f "$CJ"; exit 1; }
echo "  PASS  the client accepts the redirect_uri the UI sends  ->  $REDIRECT"

LOC=$(curl -s -b "$CJ" -c "$CJ" -o /dev/null -D- -d "username=$U" -d "password=$P" "$ACTION" | grep -i '^location:' | tr -d '\r' | sed 's/^[Ll]ocation: //')
case "$LOC" in
  *VERIFY_PROFILE*) echo "DIVERTED TO VERIFY_PROFILE (missing email/firstName/lastName)"; rm -f "$CJ"; exit 1;;
esac
CODE=$(printf '%s' "$LOC" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$CODE" ] || { echo "NO AUTHORIZATION CODE. Location: $LOC"; rm -f "$CJ"; exit 1; }
TOK=$(curl -s -d grant_type=authorization_code -d "client_id=$CID" -d "client_secret=$SECRET" \
     -d "code=$CODE" -d "redirect_uri=$REDIRECT" \
     "$BASE/realms/$REALM/protocol/openid-connect/token")
rm -f "$CJ"
printf '%s' "$TOK" | python3 -c '
import sys,json,base64
d=json.load(sys.stdin)
if "access_token" not in d:
    print("  FAIL  the authorization code did not exchange:",d)
    print("        unauthorized_client here means the secret the UI holds is not the one")
    print("        the client expects — reconcile the client, do not edit this script.")
    sys.exit(1)
print("  PASS  the authorization code exchanged with the secret the UI holds")
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
