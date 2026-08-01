#!/usr/bin/env python3
"""Guard the vendored standalone realm against Hill90's platform-realm.json.

    python3 scripts/checks/check_vendored_realm.py                 # the CI gate
    python3 scripts/checks/check_vendored_realm.py --check-upstream # is the target stale?
    python3 scripts/checks/check_vendored_realm.py --refresh        # adopt upstream

WHY THIS EXISTS. `--standalone` runs the fork's own Keycloak against
compose/local/keycloak/realm-local.json, a COPY of Hill90's platform realm. A
copy is a second source of truth and is safe only while something keeps it
honest. Nothing did, and the two had already drifted on six fields — including
`defaultClientScopes`, which carries the `roles` scope that emits
`resource_access.hill90-ui.roles`, the claim authorisation actually reads. A copy
that loses it still logs a user in and hands back an empty-permissions view with
no error, which is the worst shape a defect can take.

HOW THE COMPARISON IS AVAILABLE WITHOUT THE HILL90 CHECKOUT. CI here cannot
assume a sibling clone, so the load-bearing fields are extracted from upstream
and COMMITTED as upstream-realm-expected.json. The gate is therefore hermetic:
no network, no second repository, and a pull request here never goes red because
somebody edited Hill90 five minutes ago.

The cost is honest and worth stating: that committed target can go stale.
`--check-upstream` fetches the live file and fails if the extract no longer
matches, so staleness is detectable on demand rather than silently assumed away.
It is deliberately NOT the pull-request gate — making every PR here depend on a
network fetch of another repository's main branch trades one silent failure for a
flaky one.

SEMANTIC, NOT BYTE-WISE. Only the fields that change behaviour are compared, and
lists are compared as sets. Reordering keys, reformatting, or reordering
`defaultClientScopes` is not drift. Changing which scopes are in it is.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VENDORED = ROOT / "compose/local/keycloak/realm-local.json"
EXPECTED = Path(__file__).resolve().parent / "upstream-realm-expected.json"

# Fields the local copy is ALLOWED to differ on, with the reason. Anything not
# listed here and not in guarded_fields is simply not compared; anything in
# guarded_fields is compared and must match.
#
# These are declared rather than inferred on purpose: "different because someone
# meant it" and "different because nobody noticed" look identical in a diff.
ALLOWED_DIVERGENCES = {
    "redirectUris": "localhost callbacks; production URLs would break --standalone",
    "webOrigins": "localhost origins, same reason",
    "secret": "a literal dev secret locally; upstream carries ${HILL90_UI_CLIENT_SECRET}",
    "attributes": "local post-logout redirect",
    "description": "local-only prose, carries no behaviour",
    "rootUrl": "localhost",
    "baseUrl": "localhost",
    "adminUrl": "localhost",
}

# Whole objects the local realm legitimately does not carry.
ALLOWED_ABSENT_CLIENTS = {
    "hill90-vault": "the standalone fork runs no OpenBao, so the client would authorise nothing",
}


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        sys.exit(f"missing file: {path}")
    except json.JSONDecodeError as e:
        sys.exit(f"{path} is not valid JSON: {e}")


def normalise(value):
    """Order-insensitive for lists, so a reorder is not reported as drift."""
    if isinstance(value, list):
        return sorted(map(str, value))
    return value


def compare(vendored: dict, expected: dict) -> list[str]:
    guarded = expected["guarded_fields"]
    local_clients = {c["clientId"]: c for c in vendored.get("clients", [])}
    problems: list[str] = []

    for cid, exp_fields in expected["clients"].items():
        local = local_clients.get(cid)
        if local is None:
            if cid in ALLOWED_ABSENT_CLIENTS:
                continue
            problems.append(
                f"client {cid!r} is in Hill90's realm but missing from the vendored copy"
            )
            continue

        for field in guarded:
            if field not in exp_fields:
                # Upstream does not set it; the local copy may do as it likes.
                continue
            want = normalise(exp_fields[field])
            got = normalise(local.get(field, "<absent>"))
            if want != got:
                problems.append(
                    f"{cid}.{field}\n"
                    f"      Hill90   : {want}\n"
                    f"      vendored : {got}"
                )
    return problems


def fetch_upstream(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


def cmd_check(expected: dict) -> int:
    vendored = load(VENDORED)
    problems = compare(vendored, expected)

    src = expected["source"]
    print(f"Vendored realm : {VENDORED.relative_to(ROOT)}")
    print(f"Compared against: {src['repo']}@{src['commit'][:8]} ({src['committed_at']})")
    print(f"Guarded fields : {', '.join(expected['guarded_fields'])}")
    print(f"Declared divergences: {', '.join(sorted(ALLOWED_DIVERGENCES))}")
    print()

    if problems:
        print(f"DRIFT — {len(problems)} guarded field(s) differ from Hill90's realm:\n")
        for p in problems:
            print(f"  {p}")
        print(
            "\nThe vendored copy is a second source of truth. Either bring it back into\n"
            "line, or — if the difference is deliberate — add the field to\n"
            "ALLOWED_DIVERGENCES in this script with the reason, so the next reader\n"
            "sees a decision instead of an accident."
        )
        return 1

    print("no drift — every guarded field matches Hill90's realm")
    return 0


def cmd_check_upstream(expected: dict) -> int:
    """Is the committed target still what upstream says? The staleness check."""
    src = expected["source"]
    print(f"Fetching {src['url']}")
    try:
        live = fetch_upstream(src["url"])
    except Exception as e:  # noqa: BLE001 - any failure here is worth reporting verbatim
        print(f"COULD NOT FETCH: {e}")
        print("Not treating this as pass or fail — the target's freshness is unknown.")
        return 2

    live_clients = {c["clientId"]: c for c in live.get("clients", [])}
    stale: list[str] = []
    for cid, exp_fields in expected["clients"].items():
        up = live_clients.get(cid)
        if up is None:
            stale.append(f"client {cid!r} has disappeared from upstream")
            continue
        for field, want in exp_fields.items():
            got = up.get(field, "<absent>")
            if normalise(want) != normalise(got):
                stale.append(f"{cid}.{field}: committed={normalise(want)} live={normalise(got)}")

    if stale:
        print(f"\nSTALE — the committed extract no longer matches upstream ({len(stale)}):\n")
        for s in stale:
            print(f"  {s}")
        print("\nRefresh it:  python3 scripts/checks/check_vendored_realm.py --refresh")
        print("Then re-run the gate, which may now report real drift in the vendored copy.")
        return 1

    print("committed extract still matches upstream")
    return 0


def cmd_refresh(expected: dict) -> int:
    src = expected["source"]
    live = fetch_upstream(src["url"])
    live_clients = {c["clientId"]: c for c in live.get("clients", [])}
    guarded = expected["guarded_fields"]
    expected["clients"] = {
        cid: {f: live_clients[cid][f] for f in guarded if f in live_clients[cid]}
        for cid in expected["clients"]
        if cid in live_clients
    }
    EXPECTED.write_text(json.dumps(expected, indent=2) + "\n")
    print(f"refreshed {EXPECTED.name} from live upstream")
    print("NOTE: source.commit is not updated automatically — set it to the commit you adopted.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--check-upstream", action="store_true",
                   help="fetch Hill90's realm and report whether the committed extract is stale")
    g.add_argument("--refresh", action="store_true",
                   help="adopt live upstream into the committed extract")
    args = ap.parse_args()

    expected = load(EXPECTED)
    if args.check_upstream:
        return cmd_check_upstream(expected)
    if args.refresh:
        return cmd_refresh(expected)
    return cmd_check(expected)


if __name__ == "__main__":
    sys.exit(main())
