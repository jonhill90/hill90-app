#!/usr/bin/env bash
# Verify a kc.sh realm export is trustworthy BEFORE relying on it.
#
# A realm export that is missing users or client secrets looks exactly like a good
# one: valid JSON, plausible size, realm name correct. The failure only appears
# later, as `invalid_client` at token exchange or as users who cannot log in —
# after the migration, when the original is already gone.
#
# Usage: verify-realm-export.sh <realm-export.json> [expected-realm]
#
# Exits non-zero and says which property failed. Silence is not a pass; it prints
# what it found in every case.

set -euo pipefail

f="${1:-}"
expected_realm="${2:-hill90}"

[ -n "$f" ] || { echo "usage: $0 <realm-export.json> [expected-realm]" >&2; exit 2; }
[ -f "$f" ] || { echo "FAIL: no such file: $f" >&2; exit 2; }
[ -s "$f" ] || { echo "FAIL: $f is empty" >&2; exit 1; }

command -v python3 >/dev/null || { echo "FAIL: python3 required" >&2; exit 2; }

python3 - "$f" "$expected_realm" <<'PY'
import json, sys

path, expected = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"FAIL: {path} is not valid JSON: {e}")
    sys.exit(1)

fail = []

realm = d.get("realm")
print(f"realm:                {realm}")
if realm != expected:
    fail.append(f"realm is {realm!r}, expected {expected!r}")

# --- users, and their credentials -----------------------------------------
# `--users skip` and a REST partial-export both produce a file with no users at
# all. That is the single most likely way to end up with a useless artifact.
users = d.get("users") or []
print(f"users:                {len(users)}")
if not users:
    fail.append("users array is empty or absent — this is NOT a backup of the "
                "accounts (did you use --users skip, or a REST partial-export?)")

for u in users:
    creds = u.get("credentials") or []
    types = [c.get("type") for c in creds]
    hashed = False
    for c in creds:
        if c.get("type") != "password":
            continue
        try:
            sd = json.loads(c.get("secretData") or "{}")
        except Exception:
            sd = {}
        if sd.get("value") and sd.get("salt"):
            hashed = True
    print(f"  user {u.get('username')!r:<28} credentials={types} password-hash={hashed}")
    if not creds:
        fail.append(f"user {u.get('username')!r} has no credentials — that account "
                    f"cannot log in after an import")
    elif "password" in types and not hashed:
        fail.append(f"user {u.get('username')!r} has a password credential with no "
                    f"hash material (secretData.value/salt)")

# --- client secrets -------------------------------------------------------
# Only clients that are BOTH non-public and non-bearerOnly actually use a secret.
# `broker` and `realm-management` are built-in bearer-only clients that ship with
# every realm and never carry one; asserting on them would fail on a good export.
clients = d.get("clients") or []
need_secret = [c for c in clients
               if not c.get("publicClient", False) and not c.get("bearerOnly", False)]
print(f"clients:              {len(clients)} total, {len(need_secret)} confidential")
if not need_secret:
    fail.append("no confidential clients found — the app's clients are confidential, "
                "so this export is not the realm you think it is")
for c in need_secret:
    ok = bool(c.get("secret"))
    print(f"  client {c.get('clientId')!r:<26} secret={'present' if ok else 'MISSING'}")
    if not ok:
        fail.append(f"confidential client {c.get('clientId')!r} has no secret — "
                    f"importing this mints a new one and AUTH_KEYCLOAK_SECRET in "
                    f"SOPS will stop matching (see runbook section 5)")

# --- things whose absence breaks the migration specifically ---------------
mappers = sum(len(c.get("protocolMappers") or []) for c in clients)
realm_roles = [r.get("name") for r in (d.get("roles", {}).get("realm") or [])]
keys = d.get("components", {}).get("org.keycloak.keys.KeyProvider") or []
print(f"client protocolMappers: {mappers}   (section 7 depends on the roles mapper)")
print(f"realm roles:          {realm_roles}")
print(f"signing key providers: {len(keys)}")
if not keys:
    fail.append("no KeyProvider components — realm signing keys are absent, so an "
                "import mints new ones and every previously issued token stops "
                "validating")

print()
if fail:
    print("EXPORT_NOT_TRUSTWORTHY")
    for m in fail:
        print(f"  - {m}")
    sys.exit(1)
print("EXPORT_LOOKS_COMPLETE")
print("  users with password hashes, confidential clients with secrets, signing "
      "keys present.")
print("  This checks the ARTIFACT only. It does not prove an import restores it —")
print("  for that, rehearse an import into a throwaway stack (runbook section 1).")
PY
