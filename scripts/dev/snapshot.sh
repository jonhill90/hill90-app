#!/usr/bin/env bash
# Save and restore exact file bytes around a positive-control experiment.
#
# WHY THIS EXISTS. Every fix in this repository is proven by breaking it again
# and watching the test go red. The obvious way to undo that break is
# `git checkout -- <file>` — and it discards EVERYTHING uncommitted in that
# path, exits 0, and prints nothing. On 2026-08-04 that silently threw away
# uncommitted work four times in one session; each time it was noticed
# downstream, from a test failing for a reason that had to be traced back,
# never from the command itself.
#
# That is this repository's own defect class, in the workflow rather than the
# code: an operation that destroys and reports success. The fix is the same one
# applied everywhere else — make it recoverable, and make it loud.
#
#   save     copies the exact bytes somewhere git cannot reach
#   restore  puts them back, PRINTING each file, and refuses if nothing is saved
#   status   says what is currently held
#
# NOT `git stash`: this worktree shares its stash stack with the main checkout
# and other sessions, so a stash here can be popped by someone else.
set -uo pipefail
STORE="${SNAPSHOT_DIR:-${TMPDIR:-/tmp}/hill90-snapshots}"
CMD="${1:-}"; shift || true

case "$CMD" in
  save)
    [ $# -gt 0 ] || { echo "usage: snapshot.sh save <file>..."; exit 2; }
    mkdir -p "$STORE"
    for f in "$@"; do
      [ -f "$f" ] || { echo "REFUSING: $f does not exist"; exit 1; }
      dest="$STORE/$(printf '%s' "$f" | tr '/' '_')"
      cp "$f" "$dest"
      printf '%s\n' "$f" > "$dest.path"
      echo "saved: $f"
    done
    ;;
  restore)
    shopt -s nullglob
    saved=("$STORE"/*.path)
    [ ${#saved[@]} -gt 0 ] || { echo "NOTHING SAVED — restore is a no-op, which is not the same as a successful restore"; exit 1; }
    for p in "${saved[@]}"; do
      f=$(cat "$p"); dest="${p%.path}"
      cp "$dest" "$f"
      echo "restored: $f"          # loud on purpose: a silent restore is how this started
      rm -f "$dest" "$p"
    done
    ;;
  status)
    shopt -s nullglob
    saved=("$STORE"/*.path)
    if [ ${#saved[@]} -eq 0 ]; then echo "nothing saved"; else
      for p in "${saved[@]}"; do echo "held: $(cat "$p")"; done
    fi
    ;;
  *)
    echo "usage: snapshot.sh {save <file>...|restore|status}"; exit 2 ;;
esac
