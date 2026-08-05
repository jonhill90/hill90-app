"""app#380: the producer half of the graph node-type contract.

WHAT HAPPENED. #379 added `type: "user"` to `knowledge_graph()`'s node output.
#378, built and merged the same night by a different lane with no visibility
into #379, styled only the three node types that existed when it was
written — `KnowledgeGraph.tsx`'s `TYPE_COLORS` and `TYPE_BASE_RADIUS` both have
a defensive fallback (`|| '#6b7280'`, `?? 6`), so the new type rendered as a
small grey dot with a raw UUID label instead of erroring. The fourth time in
one night a producer and a consumer disagreed about a name and nothing caught
it (#354, #371, #373 were the other three).

WHAT THIS FILE DOES AND DOES NOT PROVE. `docs/contracts/graph-node-types.json`
is the shared statement of what the type set IS — not owned by either service,
not read by one service out of the other's source. This file proves two
things, and both matter: (1) `GRAPH_NODE_TYPES` (declared in shared_store.py,
not scraped by static analysis — a grep works today but breaks the moment the
node construction is refactored) agrees with the manifest; (2) what
`knowledge_graph()` ACTUALLY EMITS, from a fixture exercising every type, is a
subset of that constant. Test (2) is the one that matters most: without it,
the manifest and the constant could agree with each other while the real
function quietly emits something neither knows about — the manifest becomes a
second thing to forget to update, which is the defect wearing a hat.

It does NOT prove `services/ui`'s renderer agrees with this manifest — that is
the consumer half, proposed on app#380 for whoever is next in
`KnowledgeGraph.tsx`, not built here (that file was being actively edited by
another lane the night this was written).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.services import shared_store
from app.services.shared_store import GRAPH_NODE_TYPES, GraphNodeType

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = REPO_ROOT / "docs" / "contracts" / "graph-node-types.json"


def _manifest_types() -> set[str]:
    manifest = json.loads(MANIFEST_PATH.read_text())
    return {t["name"] for t in manifest["types"]}


def test_the_manifest_exists_where_the_contract_says_it_does():
    assert MANIFEST_PATH.is_file(), (
        f"docs/contracts/graph-node-types.json not found at {MANIFEST_PATH} — "
        "either this test's path assumption or the file itself moved"
    )


def test_declared_constant_agrees_with_the_manifest():
    assert GRAPH_NODE_TYPES == _manifest_types()


def test_declared_constant_has_no_duplicate_or_stray_members():
    # GraphNodeType's four attributes should be exactly what GRAPH_NODE_TYPES
    # contains — catches a constant that was hand-edited out of sync with the
    # class it is supposedly built from.
    declared = {
        GraphNodeType.COLLECTION, GraphNodeType.SOURCE,
        GraphNodeType.AGENT, GraphNodeType.USER,
    }
    assert declared == GRAPH_NODE_TYPES


# ---------------------------------------------------------------------------
# The test that actually matters: real output vs. the constant, not the
# constant vs. itself. Reuses the same stubbed-pool harness as
# test_shared_graph.py rather than importing it, so this file has no
# dependency on that one's internals changing shape.
# ---------------------------------------------------------------------------


class _Conn:
    def __init__(self, answers: list[list[dict[str, Any]]], totals: dict[str, Any]):
        self._answers = list(answers)
        self._totals = totals

    async def fetch(self, sql: str, *a: Any) -> list[dict[str, Any]]:
        return self._answers.pop(0)

    async def fetchrow(self, sql: str, *a: Any) -> dict[str, Any]:
        return self._totals


class _Acquire:
    def __init__(self, conn): self._conn = conn
    async def __aenter__(self): return self._conn
    async def __aexit__(self, *_): return False


class _Pool:
    def __init__(self, conn): self._conn = conn
    def acquire(self): return _Acquire(self._conn)


@pytest.mark.asyncio
async def test_every_type_the_function_can_actually_emit_is_in_the_declared_constant():
    # A fixture engineered to exercise all four types in one call: a
    # collection, a source, an agent from knowledge_entries, AND a
    # retrieval-derived row for each of requester_type in ('agent', 'user') —
    # the agent-typed retrieval row targets the SAME agent_id as the
    # knowledge_entries row specifically to also exercise the merge path.
    conn = _Conn(
        answers=[
            [{"id": "c1", "name": "Runbooks", "visibility": "org"}],
            [{"id": "s1", "title": "Deploy", "source_type": "web",
              "collection_id": "c1", "chunk_count": 1}],
            [{"agent_id": "scout", "entry_count": 3, "last_updated": None}],
            [
                {"requester_id": "scout", "requester_type": "agent", "source_id": "s1", "chunk_hits": 2},
                {"requester_id": "u1", "requester_type": "user", "source_id": "s1", "chunk_hits": 1},
            ],
        ],
        totals={
            "collections": 1, "sources": 1, "agents_with_knowledge": 1,
            "requesters_with_retrievals": 2,
        },
    )
    out = await shared_store.knowledge_graph(_Pool(conn), limit=100)

    emitted_types = {n["type"] for n in out["nodes"]}
    assert emitted_types == GRAPH_NODE_TYPES, (
        "every declared type should be exercised by this fixture, and nothing "
        "the function emits should fall outside the declared set"
    )
    assert emitted_types <= GRAPH_NODE_TYPES  # the assertion that actually matters, stated on its own


# ---------------------------------------------------------------------------
# POSITIVE CONTROL, run and captured before this shipped — see the PR that
# added this file for the real failing output. Kept here as a permanent,
# always-green record of what the mechanism checks; the red state itself was
# produced by temporarily adding a fifth type and is not committed.
# ---------------------------------------------------------------------------


def test_CONTROL_a_type_outside_the_declared_set_would_fail_the_subset_assertion():
    regressed_emitted_types = GRAPH_NODE_TYPES | {"phantom"}
    with pytest.raises(AssertionError):
        assert regressed_emitted_types <= GRAPH_NODE_TYPES
