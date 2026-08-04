"""The shared-knowledge graph, built by the service that owns the tables (#300).

WHERE IT CAME FROM. The api ran these four statements through its own pool
against `shared_collections`, `shared_sources` and `knowledge_entries` — tables
that live in THIS service's database. Measured: five such tables in
`hill90_akm`, zero in `hill90_api`. The endpoint answered 500 on every call and
the page rendered "Failed to load graph".

WHAT THESE TESTS DO AND DO NOT PROVE. They pin the graph ASSEMBLY: which nodes
and edges come out of given rows, that an edge is never emitted for a collection
that was truncated away, and that the totals come from the counts rather than
from the lengths of the lists. They do NOT prove the SQL parses — the pool is
stubbed here, exactly as it is in the api suite that missed #286. That proof is
`PREPARE` against the real schema, run against `hill90_akm`, and it is the
reason this move is trustworthy rather than merely tidy.
"""
from __future__ import annotations

from typing import Any

import pytest

from app.services import shared_store


class _Conn:
    def __init__(self, collections, sources, agents, totals):
        self._answers = [collections, sources, agents]
        self._totals = totals
        self.sql: list[str] = []
        self.args: list[tuple] = []

    async def fetch(self, sql: str, *a: Any) -> list[dict[str, Any]]:
        self.sql.append(sql)
        self.args.append(a)
        return self._answers.pop(0)

    async def fetchrow(self, sql: str, *a: Any) -> dict[str, Any]:
        self.sql.append(sql)
        self.args.append(a)
        return self._totals


class _Acquire:
    def __init__(self, conn): self._conn = conn
    async def __aenter__(self): return self._conn
    async def __aexit__(self, *_): return False


class _Pool:
    def __init__(self, conn): self._conn = conn
    def acquire(self): return _Acquire(self._conn)


def _pool(collections=(), sources=(), agents=(), totals=None):
    totals = totals or {"collections": len(collections), "sources": len(sources),
                        "agents_with_knowledge": len(agents)}
    conn = _Conn(list(collections), list(sources), list(agents), totals)
    pool = _Pool(conn)
    pool.conn = conn
    return pool


@pytest.mark.asyncio
async def test_nodes_and_edges_are_built_from_the_rows():
    out = await shared_store.knowledge_graph(_pool(
        collections=[{"id": "c1", "name": "Runbooks", "visibility": "org"}],
        sources=[{"id": "s1", "title": "Deploy", "source_type": "web",
                  "collection_id": "c1", "chunk_count": 7}],
        agents=[{"agent_id": "scout", "entry_count": 3, "last_updated": None}],
    ), limit=100)

    assert {n["id"] for n in out["nodes"]} == {"col-c1", "src-s1", "agent-scout"}
    assert out["edges"] == [{"source": "col-c1", "target": "src-s1", "label": "contains"}]
    assert out["dangling_edges"] == 0


@pytest.mark.asyncio
async def test_POSITIVE_CONTROL_an_edge_to_a_truncated_collection_is_not_emitted():
    # The fixture that separates the versions: a source whose collection was cut
    # by the limit. Emitting the edge would point it at a node that does not
    # exist — worse than a smaller graph, because a renderer either drops it
    # silently or lays out around a phantom.
    out = await shared_store.knowledge_graph(_pool(
        collections=[{"id": "c1", "name": "Kept", "visibility": "org"}],
        sources=[{"id": "s9", "title": "Orphan", "source_type": "web",
                  "collection_id": "c-cut-off", "chunk_count": 1}],
        totals={"collections": 40, "sources": 90, "agents_with_knowledge": 0},
    ), limit=1)

    assert out["edges"] == []
    assert out["dangling_edges"] == 1
    assert any(n["id"] == "src-s9" for n in out["nodes"])   # the node still shows


@pytest.mark.asyncio
async def test_totals_come_from_the_counts_not_from_the_page():
    # #215/#188: a total derived from the list it describes agrees with itself
    # and calls truncation complete.
    out = await shared_store.knowledge_graph(_pool(
        collections=[{"id": "c1", "name": "One", "visibility": "org"}],
        totals={"collections": 40, "sources": 0, "agents_with_knowledge": 0},
    ), limit=1)

    assert out["total"]["collections"] == 40
    assert out["shown"]["collections"] == 1
    assert out["truncated"] is True


@pytest.mark.asyncio
async def test_TWIN_a_complete_graph_is_not_marked_truncated():
    out = await shared_store.knowledge_graph(_pool(
        collections=[{"id": "c1", "name": "One", "visibility": "org"}],
        totals={"collections": 1, "sources": 0, "agents_with_knowledge": 0},
    ), limit=100)

    assert out["truncated"] is False


@pytest.mark.asyncio
async def test_every_list_is_bounded_by_the_callers_limit():
    # Moved from the api's routes-shared-knowledge suite when the queries moved
    # (#300). Each of the three lists must carry the LIMIT; the totals query
    # must not, or it would count the page.
    pool = _pool(totals={"collections": 0, "sources": 0, "agents_with_knowledge": 0})
    await shared_store.knowledge_graph(pool, limit=5)

    lists = [s for s in pool.conn.sql if "LIMIT $1" in s]
    assert len(lists) == 3, "each list must be bounded"
    assert all(a == (5,) for a in pool.conn.args[:3])
    assert "LIMIT" not in pool.conn.sql[3]


@pytest.mark.asyncio
async def test_agents_are_counted_with_COUNT_DISTINCT_because_the_list_is_grouped():
    # A plain COUNT(*) there would count entries rather than agents, and the
    # figure would disagree with the list it describes.
    pool = _pool(totals={"collections": 0, "sources": 0, "agents_with_knowledge": 0})
    await shared_store.knowledge_graph(pool, limit=5)

    totals_sql = pool.conn.sql[3]
    assert "count(DISTINCT agent_id)" in totals_sql
