#!/usr/bin/env bash
# Which database is each service actually pointing at?
#
# WHY THIS EXISTS
#
# The natural way to answer that is `docker inspect ... | grep DATABASE_URL`, and
# DATABASE_URL contains the password. Twice in one session a live Postgres credential
# reached a transcript that way, both times while someone was legitimately verifying a
# cutover. The password is not incidental to the answer, it is inside it.
#
# This prints the same answer with the credential removed before anything is emitted,
# so the routine check stops being a leak. See
# docs/decisions/database-credentials-and-inspectability.md for why the variables are
# not split instead (Prisma requires a single URL, so splitting would leave one service
# leaky and the estate with two conventions).
#
# Reads only container configuration. Touches no database.

set -euo pipefail

CONTAINERS=${*:-"app-api app-ai app-litellm app-knowledge"}

# Replace the password between ':' and '@' in a postgres URL. Anchored on the scheme so
# a value that merely contains an @ is not mangled.
redact() {
    sed -E 's#(postgres(ql)?://[^:/@]+):[^@]*@#\1:<redacted>@#g'
}

printf '%-16s %s\n' "CONTAINER" "TARGET"
for c in $CONTAINERS; do
    if ! docker inspect "$c" >/dev/null 2>&1; then
        printf '%-16s %s\n' "$c" "not running"
        continue
    fi
    # Any *DATABASE_URL* variable, whatever it is called.
    line="$(docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' \
            | grep -E '^[A-Z_]*DATABASE_URL=' | head -1 || true)"
    if [ -z "$line" ]; then
        printf '%-16s %s\n' "$c" "no DATABASE_URL"
        continue
    fi
    printf '%-16s %s\n' "$c" "$(printf '%s' "${line#*=}" | redact)"
done
