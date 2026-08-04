#!/usr/bin/env python3
"""Does hill90-platform-baseline.txt still agree with Hill90's OWN compose files?

    check_platform_baseline_freshness.py <local-list> <compose-file> [<compose-file> ...]

WHY THIS EXISTS (#177). scripts/checks/hill90-platform-baseline.txt is a
hand-copied snapshot of Hill90's `container_name:` entries, taken once by
reading Hill90 340d8847 (2026-08-03) and never compared back to the source
since. Hill90#699 asked for the mirror check on the platform side and is
blocked on a cross-repo PAT (Hill90 reading this PRIVATE... except this repo
is public — see the caller's own note on that). This runs from the OTHER
side instead: hill90-app reading Hill90's compose files needs NO credential
at all, because Hill90 is a public repository. Same gap, closed from the
side that doesn't need a secret.

WHY THE LOCAL COPY STILL EXISTS AND THIS DOES NOT REPLACE IT.
hill90-platform-baseline.txt's own header already explains why the tenant
does not read Hill90's compose files live, at DEPLOY time, to build its own
expectations — that would couple this tenant's deploy behaviour to the
platform's internal file layout, exactly the boundary
"the platform provides, the tenant consumes" exists to hold. This script
does not do that: it runs as its own periodic/CI check, its answer is never
consulted by a deploy, and it does not change what check_platform_baseline.sh
compares against at deploy time. It only tells a human when the hand-copied
snapshot needs a human to update it.

THE THREE OUTCOMES, why fetch failure gets its own state, and how it is kept
distinct from the other two — the caller must not conflate "no compose files
could be read" with either "the lists match" (an empty parsed set is not the
same claim as sixteen names matching sixteen names) or "the lists differ" (a
network failure reported as "the platform removed everything" would send a
reader chasing a platform outage that never happened). This is the same
defect check_sql_identifiers.sh closed this morning, in the other direction:
"nothing ran" must never look like "nothing failed".

Exit codes, following this estate's own convention
(check_deploy_drift.sh, check_hill90_ui_secret_agreement.sh):
  0  AGREE               both sides parsed and their name sets are equal
  1  DIFFER              both sides parsed; the name sets are NOT equal
  2  CANNOT DETERMINE    a compose file could not be read/parsed, or nothing
                          was extracted from either side — never a pass

WHAT THIS DOES NOT DO. Fetch anything. The caller resolves Hill90's `main`
to an exact commit SHA ONCE per run and downloads the compose files at that
SHA — see the workflow. This script only ever sees files already on disk, so
it is fully testable with fabricated compose fixtures and never touches the
network, which is also what makes the pinned-ref requirement enforceable
somewhere other than by convention: the caller either passes files from one
resolved SHA or it does not, and this script cannot tell the difference
between "pinned" and "floating" — that discipline belongs to, and is
documented in, the workflow that calls it.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import yaml

# Compose files in this estate write container_name as
# "${CONTAINER_PREFIX:-}name" — production leaves CONTAINER_PREFIX unset, so
# the deployed name is the bare suffix. Strip exactly that shape; a
# container_name that does NOT start with this is left alone rather than
# mangled, so an unexpected form is visible instead of silently misparsed.
CONTAINER_PREFIX_RE = re.compile(r'^\$\{CONTAINER_PREFIX:-?\}')


def local_names(path: Path) -> set[str]:
    names: set[str] = set()
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        names.add(line)
    return names


def platform_names(compose_paths: list[Path]) -> tuple[set[str], int]:
    """Returns (names, files successfully parsed). A file that fails to open
    or parse is skipped, not fatal by itself — CANNOT DETERMINE is decided
    by the caller, from whether ANYTHING came out the other end, not from
    any single file's fate.
    """
    names: set[str] = set()
    parsed = 0
    for p in compose_paths:
        try:
            doc = yaml.safe_load(p.read_text())
        except (OSError, yaml.YAMLError):
            continue
        if not isinstance(doc, dict):
            continue
        parsed += 1
        for svc in (doc.get('services') or {}).values():
            if not isinstance(svc, dict):
                continue
            cname = svc.get('container_name')
            if not cname:
                continue
            # One-shot containers are not long-lived and are deliberately
            # excluded from the baseline — openbao-init is the current
            # example (restart: "no", a one-time chown). Compose quotes
            # "no" specifically so YAML does not read it as the boolean
            # False; PyYAML then hands back the string "no", which is what
            # is compared here.
            if svc.get('restart') == 'no':
                continue
            names.add(CONTAINER_PREFIX_RE.sub('', str(cname)))
    return names, parsed


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "::error::usage: check_platform_baseline_freshness.py <local-list> "
            "<compose-file> [<compose-file> ...]",
            file=sys.stderr,
        )
        return 2

    local_path = Path(sys.argv[1])
    compose_paths = [Path(p) for p in sys.argv[2:]]

    # Purely for the reader — this script never fetches anything itself, so
    # it cannot verify the claim. Set by the caller after resolving Hill90's
    # main to one commit, once, for this run (see the workflow). Printed
    # unconditionally so a run with this unset is visibly a run that did not
    # pin anything, rather than silently looking the same as one that did.
    hill90_sha = os.environ.get("HILL90_SHA", "<not supplied — caller did not pin a commit>")

    print("Platform baseline freshness — hill90-platform-baseline.txt vs Hill90")
    print("==============================================")
    print(f"  compared against Hill90 commit: {hill90_sha}")
    print(f"  local list: {local_path}")
    print(f"  compose files supplied: {len(compose_paths)}")

    if not local_path.is_file():
        print(f"::error::CANNOT DETERMINE: local list not found: {local_path}. Nothing was compared.", file=sys.stderr)
        return 2

    expected = local_names(local_path)
    if not expected:
        print(f"::error::CANNOT DETERMINE: {local_path} contains no names. Nothing was compared.", file=sys.stderr)
        return 2

    actual, parsed = platform_names(compose_paths)

    # NEVER let "nothing to read" pass as agreement or misreport as
    # "differ". A caller whose fetch step failed and handed this script
    # zero readable files, or files with no container_name entries at all,
    # gets exit 2 either way — the same code as a missing local list,
    # because both mean this comparison did not happen.
    if parsed == 0:
        print(
            f"::error::CANNOT DETERMINE: none of the {len(compose_paths)} supplied compose "
            "file(s) could be read as YAML. This is NOT evidence the lists agree or differ "
            "— nothing was extracted from the platform side.",
            file=sys.stderr,
        )
        return 2
    if not actual:
        print(
            f"::error::CANNOT DETERMINE: {parsed} compose file(s) parsed but yielded zero "
            "container_name entries. That is almost certainly a parsing or extraction bug, "
            "not an empty platform — refusing to report it as either agreement or drift.",
            file=sys.stderr,
        )
        return 2

    print(f"  compose files parsed: {parsed}/{len(compose_paths)}")
    print(f"  names in local copy: {len(expected)}")
    print(f"  names read from Hill90's compose: {len(actual)}")
    print()

    if expected == actual:
        print(f"AGREE: all {len(expected)} names match.")
        return 0

    only_local = sorted(expected - actual)
    only_platform = sorted(actual - expected)

    print("::error::DIFFER: hill90-platform-baseline.txt no longer matches Hill90's compose files.", file=sys.stderr)
    if only_local:
        print(
            f"  IN OUR COPY, NOT IN HILL90'S COMPOSE ({len(only_local)}): {', '.join(only_local)}",
            file=sys.stderr,
        )
        print(
            "    Hill90 no longer declares these — it renamed or removed them. "
            "REMOVE from hill90-platform-baseline.txt, or find out why not.",
            file=sys.stderr,
        )
    if only_platform:
        print(
            f"  IN HILL90'S COMPOSE, NOT IN OUR COPY ({len(only_platform)}): {', '.join(only_platform)}",
            file=sys.stderr,
        )
        print(
            "    Hill90 declares these and our copy does not. "
            "ADD to hill90-platform-baseline.txt, or the deploy-time check "
            "cannot see a platform container that legitimately exists now.",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
