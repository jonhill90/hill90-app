"""The private-memory graph (app#501), built by the service that owns the table.

Jon: "I want a knowledge graph for the memories for the agent. The
non-shared ones, but I can view."

AUTHORITY, settled before building (per the issue's own explicit ask):
`knowledge_entries` has no owner/created_by column at all — ownership is
entirely indirect, via which Keycloak user's `agents` row a given
`agent_id` belongs to. `entries_graph()` does not resolve that itself and
is not supposed to: `agent_ids`, when given, IS the caller's already-decided
visibility, computed once by the api's own `getAllowedAgentIds` before this
is ever called — the same trust boundary `internal_admin.py`'s own module
docstring already states for this file's sibling endpoints. `agent_ids=None`
means "no filter" — reached only on the admin path, never a default. These
tests pin that boundary from the SQL side: a filter clause appears in the
query text if and only if `agent_ids` is not None.

WHAT THESE TESTS DO AND DO NOT PROVE. They pin the graph ASSEMBLY — same
discipline as test_shared_graph.py's own header. They do NOT prove the SQL
parses against the real schema; that is PREPARE against real Postgres, done
separately for this PR (see the PR body).
"""
from __future__ import annotations

from typing import Any

import pytest

from app.services import knowledge_store


class _DirectPool:
    """knowledge_store.py calls pool.fetch/pool.fetchrow directly (this
    file's own established convention) rather than pool.acquire() the way
    shared_store.py does — a different stub from test_shared_graph.py's,
    matching what entries_graph() actually calls.
    """
    def __init__(self, fetch_answers: list[list[dict[str, Any]]], totals: dict[str, Any]):
        self._fetch_answers = list(fetch_answers)
        self._totals = totals
        self.fetch_calls: list[tuple[str, tuple]] = []

    async def fetch(self, sql: str, *a: Any) -> list[dict[str, Any]]:
        self.fetch_calls.append((sql, a))
        return self._fetch_answers.pop(0)

    async def fetchrow(self, sql: str, *a: Any) -> dict[str, Any]:
        return self._totals


def _pool(agents=(), entries=(), links=(), totals=None):
    totals = totals or {
        "agents_with_entries": len({e["agent_id"] for e in entries}),
        "entries": len(entries),
    }
    return _DirectPool(
        fetch_answers=[list(agents), list(entries), list(links)],
        totals=totals,
    )


@pytest.mark.asyncio
async def test_nodes_and_contains_edges_are_built_from_the_rows():
    out = await knowledge_store.entries_graph(_pool(
        agents=[{"agent_id": "scout", "entry_count": 1, "last_updated": None}],
        entries=[{"id": "e1", "agent_id": "scout", "path": "notes/x.md", "title": "X Research",
                  "entry_type": "research", "tags": ["azure"], "status": "active",
                  "created_at": None, "updated_at": None}],
    ), limit=100)

    assert {n["id"] for n in out["nodes"]} == {"agent-scout", "entry-e1"}
    entry_node = next(n for n in out["nodes"] if n["id"] == "entry-e1")
    assert entry_node["type"] == "entry"
    assert entry_node["label"] == "X Research"
    assert entry_node["meta"] == {"entry_type": "research", "tags": ["azure"], "status": "active"}
    assert out["edges"] == [{"source": "agent-scout", "target": "entry-e1", "label": "contains"}]
    assert out["dangling_edges"] == 0


@pytest.mark.asyncio
async def test_POSITIVE_CONTROL_an_edge_to_a_truncated_agent_is_not_emitted():
    # The fixture that separates the versions: an entry whose agent was cut
    # by the agents-page LIMIT. Emitting the edge would point it at a node
    # that does not exist — the entry node stays, only the edge withholds.
    out = await knowledge_store.entries_graph(_pool(
        agents=[],  # agent row cut from this page
        entries=[{"id": "e1", "agent_id": "cut-off-agent", "path": "notes/x.md", "title": "X",
                  "entry_type": "note", "tags": [], "status": "active",
                  "created_at": None, "updated_at": None}],
        totals={"agents_with_entries": 5, "entries": 1},
    ), limit=1)

    assert out["edges"] == []
    assert out["dangling_edges"] == 1
    assert any(n["id"] == "entry-e1" for n in out["nodes"])


@pytest.mark.asyncio
async def test_a_link_resolves_between_two_entries_shown_on_this_page():
    out = await knowledge_store.entries_graph(_pool(
        agents=[{"agent_id": "scout", "entry_count": 2, "last_updated": None}],
        entries=[
            {"id": "e1", "agent_id": "scout", "path": "notes/a.md", "title": "A",
             "entry_type": "note", "tags": [], "status": "active", "created_at": None, "updated_at": None},
            {"id": "e2", "agent_id": "scout", "path": "notes/b.md", "title": "B",
             "entry_type": "note", "tags": [], "status": "active", "created_at": None, "updated_at": None},
        ],
        links=[{"source_id": "e1", "target_id": "e2"}],
    ), limit=100)

    link_edges = [e for e in out["edges"] if e["label"] == "links"]
    assert link_edges == [{"source": "entry-e1", "target": "entry-e2", "label": "links"}]
    assert out["dangling_edges"] == 0


@pytest.mark.asyncio
async def test_a_link_to_a_nonexistent_target_path_is_dangling_not_dropped_silently():
    # A genuinely broken wikilink: the SQL's own LEFT JOIN never found a
    # matching active entry, so target_id arrives as None here.
    out = await knowledge_store.entries_graph(_pool(
        agents=[{"agent_id": "scout", "entry_count": 1, "last_updated": None}],
        entries=[{"id": "e1", "agent_id": "scout", "path": "notes/a.md", "title": "A",
                  "entry_type": "note", "tags": [], "status": "active", "created_at": None, "updated_at": None}],
        links=[{"source_id": "e1", "target_id": None}],
    ), limit=100)

    assert [e for e in out["edges"] if e["label"] == "links"] == []
    assert out["dangling_edges"] == 1


@pytest.mark.asyncio
async def test_a_link_whose_source_entry_is_not_on_this_page_is_dangling():
    out = await knowledge_store.entries_graph(_pool(
        agents=[{"agent_id": "scout", "entry_count": 1, "last_updated": None}],
        entries=[{"id": "e2", "agent_id": "scout", "path": "notes/b.md", "title": "B",
                  "entry_type": "note", "tags": [], "status": "active", "created_at": None, "updated_at": None}],
        links=[{"source_id": "e1-not-shown", "target_id": "e2"}],
        totals={"agents_with_entries": 1, "entries": 5},
    ), limit=100)

    assert [e for e in out["edges"] if e["label"] == "links"] == []
    assert out["dangling_edges"] == 1


@pytest.mark.asyncio
async def test_entries_with_no_links_produce_only_contains_edges():
    out = await knowledge_store.entries_graph(_pool(
        agents=[{"agent_id": "scout", "entry_count": 1, "last_updated": None}],
        entries=[{"id": "e1", "agent_id": "scout", "path": "notes/a.md", "title": "A",
                  "entry_type": "note", "tags": [], "status": "active", "created_at": None, "updated_at": None}],
        links=[],
    ), limit=100)

    assert {e["label"] for e in out["edges"]} == {"contains"}


@pytest.mark.asyncio
async def test_totals_come_from_the_counts_not_from_the_page():
    out = await knowledge_store.entries_graph(_pool(
        agents=[{"agent_id": "scout", "entry_count": 1, "last_updated": None}],
        entries=[{"id": "e1", "agent_id": "scout", "path": "notes/a.md", "title": "A",
                  "entry_type": "note", "tags": [], "status": "active", "created_at": None, "updated_at": None}],
        totals={"agents_with_entries": 9, "entries": 42},
    ), limit=1)

    assert out["total"] == {"agents": 9, "entries": 42}
    assert out["shown"] == {"agents": 1, "entries": 1}
    assert out["truncated"] is True


@pytest.mark.asyncio
async def test_TWIN_a_complete_graph_is_not_marked_truncated():
    out = await knowledge_store.entries_graph(_pool(
        agents=[{"agent_id": "scout", "entry_count": 1, "last_updated": None}],
        entries=[{"id": "e1", "agent_id": "scout", "path": "notes/a.md", "title": "A",
                  "entry_type": "note", "tags": [], "status": "active", "created_at": None, "updated_at": None}],
    ), limit=100)

    assert out["truncated"] is False


# ---------------------------------------------------------------------------
# Authority: agent_ids=None (admin) issues no filter; a real list scopes the
# SQL text itself, not just the Python-side result. Pinned against the query
# TEXT the pool actually received, the same discipline
# test_shared_graph.py's own owner_none_applies_no_scoping_predicate uses.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_ids_none_issues_no_filter_predicate_admin_path():
    pool = _pool()
    await knowledge_store.entries_graph(pool, limit=100, agent_ids=None)

    agents_sql, links_sql = pool.fetch_calls[0][0], pool.fetch_calls[2][0]
    assert "agent_id = ANY" not in agents_sql
    assert "agent_id = ANY" not in links_sql


@pytest.mark.asyncio
async def test_agent_ids_given_adds_the_filter_predicate_and_passes_the_list():
    pool = _pool()
    await knowledge_store.entries_graph(pool, limit=100, agent_ids=["a1", "a2"])

    agents_sql, agents_params = pool.fetch_calls[0]
    assert "agent_id = ANY($2::text[])" in agents_sql
    assert agents_params == (100, ["a1", "a2"])

    links_sql, links_params = pool.fetch_calls[2]
    assert "ke_source.agent_id = ANY($1::text[])" in links_sql
    assert links_params == (["a1", "a2"],)


@pytest.mark.asyncio
async def test_an_empty_agent_ids_list_is_NOT_the_same_as_none_still_filters():
    # A caller with zero owned agents must see nothing, not everything — an
    # empty list is a real, deliberate filter value, not the admin sentinel.
    pool = _pool()
    await knowledge_store.entries_graph(pool, limit=100, agent_ids=[])

    agents_sql, agents_params = pool.fetch_calls[0]
    assert "agent_id = ANY($2::text[])" in agents_sql
    assert agents_params == (100, [])
