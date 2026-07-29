#!/usr/bin/env bash
# Assert that an inlined PEM (literal \n, as the SOPS store keeps it) parses after
# %b expansion and is REJECTED without it. The second half is the trap that makes
# a bad key fail later and elsewhere instead of at write time.
set -u
d="${1:?tmpdir required}"
openssl genpkey -algorithm ed25519 -out "$d/real.pem" 2>/dev/null

# inline it exactly as scripts/local.sh escape_pem does
inlined=$(awk '{printf "%s\\n", $0}' "$d/real.pem")

case "$inlined" in
    *'\n'*) ;;
    *) echo "FIXTURE_BAD: inlining produced no literal backslash-n"; exit 2 ;;
esac

printf '%b\n' "$inlined" > "$d/expanded.pem"
printf '%s\n' "$inlined" > "$d/literal.pem"

openssl pkey -in "$d/expanded.pem" -noout 2>/dev/null \
    && echo EXPANDED_OK || { echo "EXPANDED_FAILED"; exit 1; }

if openssl pkey -in "$d/literal.pem" -noout 2>/dev/null; then
    echo "LITERAL_ACCEPTED"; exit 1
else
    echo LITERAL_REJECTED
fi
