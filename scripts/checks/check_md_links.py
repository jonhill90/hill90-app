#!/usr/bin/env python3
"""Fail if any tracked markdown file links to a local target that does not exist.

WHY THIS EXISTS. The extraction that created this repository brought the application's
architecture and runbook documents across and left the platform's behind. Their relative
links came with them, so several documents pointed at siblings that were no longer there.
Thirteen dead links accumulated that way and nobody noticed, because nothing looked.

A dead internal link is the first thing that makes a documentation tree look abandoned,
which matters most for a repository that is a candidate for going public.

WHAT IT CHECKS
  - inline links               [text](path/to/file.md)
  - reference definitions      [label]: path/to/file.md
  - anchors within this repo   [text](./other.md#section) — the FILE must exist; the
                               fragment is not validated, because heading-to-anchor
                               rules differ between renderers and a wrong rule here
                               would produce confident false failures.

WHAT IT DELIBERATELY IGNORES
  - http/https/mailto and protocol-relative targets — reachability is a network
    question, and a checker that fails when a third-party site is briefly down teaches
    people to ignore it
  - bare `#fragment` links, which have no file component
  - anything under a path in IGNORED_PREFIXES

Exit codes:
    0 — every local target resolves
    1 — at least one does not
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Paths whose markdown is not ours to police.
IGNORED_PREFIXES = ("node_modules/", ".github/ISSUE_TEMPLATE/")

INLINE = re.compile(r"(?<!\!)\[[^\]]*\]\(\s*([^)\s]+?)\s*\)")
REFDEF = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(\S+)", re.MULTILINE)


def tracked_markdown() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "*.md", "*.markdown"],
        capture_output=True, text=True, cwd=str(ROOT),
    ).stdout.split()
    return [ROOT / p for p in out if not p.startswith(IGNORED_PREFIXES)]


def is_external(target: str) -> bool:
    return (
        target.startswith(("http://", "https://", "mailto:", "//", "#"))
        or ":" in target.split("/")[0]
    )


def main() -> int:
    files = tracked_markdown()
    if not files:
        # A vacuous pass is worse than a failure: it reads as "no dead links".
        print("FAIL: no tracked markdown files found — the check would pass vacuously",
              file=sys.stderr)
        return 1

    dead: list[tuple[Path, int, str]] = []
    links = 0

    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        for pattern in (INLINE, REFDEF):
            for m in pattern.finditer(text):
                target = m.group(1)
                if is_external(target):
                    continue
                links += 1
                file_part = target.split("#", 1)[0]
                if not file_part:      # pure fragment, e.g. (#section)
                    continue
                resolved = (path.parent / file_part).resolve()
                if not resolved.exists():
                    line_no = text[: m.start()].count("\n") + 1
                    dead.append((path.relative_to(ROOT), line_no, target))
        del lines

    print(f"Checked {links} local link(s) across {len(files)} markdown file(s).")

    if dead:
        print(f"\nFAIL — {len(dead)} dead local link(s):", file=sys.stderr)
        for rel, line_no, target in dead:
            print(f"  {rel}:{line_no} -> {target}", file=sys.stderr)
        print(
            "\nRetarget it if the content moved, or remove the link and say in prose "
            "where the content lives. Do not point it at a plausible-looking file: a "
            "confidently wrong link is worse than a dead one, because nobody re-checks "
            "it.",
            file=sys.stderr,
        )
        return 1

    print("PASS — every local markdown link resolves.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
