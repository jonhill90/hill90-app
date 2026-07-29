#!/usr/bin/env bash
# Assert require_compose_interpolation behaves in BOTH directions. Used by
# secrets-loader.bats.
#
# Two bugs made this gate worse than useless, and both were silent:
#   1. `grep` matching nothing returned 1, and the `set -euo pipefail` in
#      _common.sh killed the deploy with no message — it failed exactly when
#      nothing was wrong. That took down the first knowledge deploy.
#   2. compose's warning embeds BACKSLASH-ESCAPED quotes (logfmt msg="..."), so a
#      pattern expecting bare quotes matched nothing and the gate returned 0 on a
#      compose file with an unset variable. It never worked.
d="${1:?tmpdir required}"; repo="${2:?repo required}"
cd "$repo" || exit 2
# shellcheck source=/dev/null
source scripts/_common.sh >/dev/null 2>&1
set +e   # _common.sh sets -e; a failing subshell would kill this script

printf 'services:\n  y:\n    image: alpine\n' > "$d/ok.yml"
printf 'services:\n  x:\n    image: alpine\n    environment:\n      - A=${DEFINITELY_UNSET_VAR}\n' > "$d/bad.yml"

( require_compose_interpolation -f "$d/ok.yml" ) >/dev/null 2>&1
[ $? -eq 0 ] && echo CLEAN_PASSES || { echo "CLEAN_FAILED (bug 1 regressed)"; exit 1; }

( require_compose_interpolation -f "$d/bad.yml" ) > "$d/out" 2>&1
[ $? -ne 0 ] && echo UNSET_CAUGHT || { echo "UNSET_MISSED (bug 2 regressed)"; exit 1; }
grep -q DEFINITELY_UNSET_VAR "$d/out" && echo NAMES_THE_VARIABLE || { echo "DID_NOT_NAME_IT"; exit 1; }
