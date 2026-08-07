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
    def __init__(self, collections, sources, agents, retrieval_edges, totals):
        self._answers = [collections, sources, agents, retrieval_edges]
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


def _pool(collections=(), sources=(), agents=(), retrieval_edges=(), totals=None):
    totals = totals or {
        "collections": len(collections), "sources": len(sources),
        "agents_with_knowledge": len(agents),
        "requesters_with_retrievals": len({r["requester_id"] for r in retrieval_edges}),
    }
    conn = _Conn(list(collections), list(sources), list(agents), list(retrieval_edges), totals)
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
        totals={"collections": 40, "sources": 90, "agents_with_knowledge": 0,
                "requesters_with_retrievals": 0},
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
        totals={"collections": 40, "sources": 0, "agents_with_knowledge": 0,
                "requesters_with_retrievals": 0},
    ), limit=1)

    assert out["total"]["collections"] == 40
    assert out["shown"]["collections"] == 1
    assert out["truncated"] is True


@pytest.mark.asyncio
async def test_TWIN_a_complete_graph_is_not_marked_truncated():
    out = await shared_store.knowledge_graph(_pool(
        collections=[{"id": "c1", "name": "One", "visibility": "org"}],
        totals={"collections": 1, "sources": 0, "agents_with_knowledge": 0,
                "requesters_with_retrievals": 0},
    ), limit=100)

    assert out["truncated"] is False


@pytest.mark.asyncio
async def test_every_list_is_bounded_by_the_callers_limit():
    # Moved from the api's routes-shared-knowledge suite when the queries moved
    # (#300). Each of the four lists (collections, sources, agent_entries,
    # retrieval_edges — #377 added the fourth) must carry the LIMIT; the
    # totals query must not, or it would count the page.
    pool = _pool(totals={"collections": 0, "sources": 0, "agents_with_knowledge": 0,
                          "requesters_with_retrievals": 0})
    await shared_store.knowledge_graph(pool, limit=5)

    lists = [s for s in pool.conn.sql if "LIMIT $1" in s]
    assert len(lists) == 4, "each list must be bounded"
    assert all(a == (5,) for a in pool.conn.args[:4])
    assert "LIMIT" not in pool.conn.sql[4]


@pytest.mark.asyncio
async def test_owner_none_applies_no_scoping_predicate():
    # Admin caller (owner=None): unchanged behaviour — no WHERE beyond the
    # sources list's existing status filter, and no owner param anywhere.
    pool = _pool(totals={"collections": 0, "sources": 0, "agents_with_knowledge": 0,
                          "requesters_with_retrievals": 0})
    await shared_store.knowledge_graph(pool, limit=5, owner=None)

    collections_sql, sources_sql = pool.conn.sql[0], pool.conn.sql[1]
    assert "created_by" not in collections_sql
    assert "created_by" not in sources_sql
    assert pool.conn.args[0] == (5,)
    assert pool.conn.args[1] == (5,)
    totals_sql, totals_args = pool.conn.sql[4], pool.conn.args[4]
    assert "created_by" not in totals_sql
    assert totals_args == ()


@pytest.mark.asyncio
async def test_owner_scoping_adds_the_same_predicate_as_list_collections_search_chunks():
    # Cross-service sibling-drift sweep (app#445 family): this function used to
    # take no owner at all, unlike its api-side sibling routes which all call
    # scopeToOwner. This pins the fix's SQL shape — the same
    # `created_by = $owner OR visibility = 'shared'` predicate used elsewhere
    # in this file — rather than merely trusting the assembly logic above.
    pool = _pool(totals={"collections": 0, "sources": 0, "agents_with_knowledge": 0,
                          "requesters_with_retrievals": 0})
    await shared_store.knowledge_graph(pool, limit=5, owner="user-1")

    collections_sql, sources_sql = pool.conn.sql[0], pool.conn.sql[1]
    assert "created_by = $2 OR visibility = 'shared'" in collections_sql
    assert "sc.created_by = $2 OR sc.visibility = 'shared'" in sources_sql
    assert pool.conn.args[0] == (5, "user-1")
    assert pool.conn.args[1] == (5, "user-1")

    totals_sql, totals_args = pool.conn.sql[4], pool.conn.args[4]
    assert "created_by = $1 OR visibility = 'shared'" in totals_sql
    assert totals_args == ("user-1",)


@pytest.mark.asyncio
async def test_agents_are_counted_with_COUNT_DISTINCT_because_the_list_is_grouped():
    # A plain COUNT(*) there would count entries rather than agents, and the
    # figure would disagree with the list it describes.
    pool = _pool(totals={"collections": 0, "sources": 0, "agents_with_knowledge": 0,
                          "requesters_with_retrievals": 0})
    await shared_store.knowledge_graph(pool, limit=5)

    totals_sql = pool.conn.sql[4]
    assert "count(DISTINCT agent_id)" in totals_sql
    assert "count(DISTINCT r.requester_id)" in totals_sql


# ---------------------------------------------------------------------------
# #377 — retrieval-derived requester -> source edges
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_hub_requester_merges_three_collections_into_one_component():
    # The measured shape from the real corpus: one requester's retrievals
    # resolve to sources in three separate collections. The point of this
    # edge type is exactly this — before it, the three `contains` trees below
    # have no edge between them at all.
    out = await shared_store.knowledge_graph(_pool(
        collections=[
            {"id": "c1", "name": "DevOps", "visibility": "org"},
            {"id": "c2", "name": "Operating Practice", "visibility": "org"},
            {"id": "c3", "name": "Hill90 Platform", "visibility": "org"},
        ],
        sources=[
            {"id": "s1", "title": "A", "source_type": "web", "collection_id": "c1", "chunk_count": 1},
            {"id": "s2", "title": "B", "source_type": "web", "collection_id": "c2", "chunk_count": 1},
            {"id": "s3", "title": "C", "source_type": "web", "collection_id": "c2", "chunk_count": 1},
            {"id": "s4", "title": "D", "source_type": "web", "collection_id": "c3", "chunk_count": 1},
        ],
        retrieval_edges=[
            {"requester_id": "u1", "requester_type": "user", "source_id": "s1", "chunk_hits": 6},
            {"requester_id": "u1", "requester_type": "user", "source_id": "s2", "chunk_hits": 1},
            {"requester_id": "u1", "requester_type": "user", "source_id": "s3", "chunk_hits": 2},
            {"requester_id": "u1", "requester_type": "user", "source_id": "s4", "chunk_hits": 2},
        ],
    ), limit=100)

    retrieved = [e for e in out["edges"] if e["label"] == "retrieved"]
    assert len(retrieved) == 4
    assert all(e["source"] == "user-u1" for e in retrieved)
    assert {e["target"] for e in retrieved} == {"src-s1", "src-s2", "src-s3", "src-s4"}

    # One node, not four — the hub is a single requester, degree 4.
    user_nodes = [n for n in out["nodes"] if n["type"] == "user"]
    assert user_nodes == [{
        "id": "user-u1", "type": "user", "label": "u1",
        "meta": {"retrieval_count": 11},   # 6 + 1 + 2 + 2, the sum of chunk_hits
    }]

    # And the connectivity claim itself: every collection is reachable from
    # every other collection by walking through the hub node, which is the
    # whole justification for building this edge type at all.
    adjacency: dict[str, set[str]] = {}
    for e in out["edges"]:
        adjacency.setdefault(e["source"], set()).add(e["target"])
        adjacency.setdefault(e["target"], set()).add(e["source"])
    seen = {"col-c1"}
    frontier = ["col-c1"]
    while frontier:
        node = frontier.pop()
        for neighbor in adjacency.get(node, ()):
            if neighbor not in seen:
                seen.add(neighbor)
                frontier.append(neighbor)
    assert {"col-c1", "col-c2", "col-c3"} <= seen, "all three collections must be in one component"


@pytest.mark.asyncio
async def test_a_retrieval_derived_agent_merges_with_its_knowledge_entries_node():
    # requester_type='agent' reuses the SAME id scheme knowledge_entries nodes
    # use (agent-{agent_id}) on purpose, so the two sources of agent activity
    # merge into one node rather than emitting two nodes under one id.
    out = await shared_store.knowledge_graph(_pool(
        sources=[{"id": "s1", "title": "A", "source_type": "web", "collection_id": "c1", "chunk_count": 1}],
        agents=[{"agent_id": "scout", "entry_count": 3, "last_updated": None}],
        retrieval_edges=[
            {"requester_id": "scout", "requester_type": "agent", "source_id": "s1", "chunk_hits": 5},
        ],
    ), limit=100)

    agent_nodes = [n for n in out["nodes"] if n["id"] == "agent-scout"]
    assert len(agent_nodes) == 1, "must merge, not duplicate the id"
    assert agent_nodes[0]["meta"] == {"entry_count": 3, "retrieval_count": 5}


@pytest.mark.asyncio
async def test_POSITIVE_CONTROL_a_retrieved_edge_to_a_truncated_source_is_not_emitted():
    # The retrieval-edge twin of the existing collection/source control above.
    # A retrieval resolving to a source that this page's sources LIMIT cut
    # away must not be emitted as an edge — same reasoning: it would point at
    # a node that does not exist on this page.
    out = await shared_store.knowledge_graph(_pool(
        # collection matches s-kept's collection_id so the ONLY dangling edge
        # this fixture produces is the retrieval one under test — otherwise
        # s-kept's own `contains` edge would dangle too and conflate the count.
        collections=[{"id": "c1", "name": "Kept", "visibility": "org"}],
        sources=[{"id": "s-kept", "title": "Kept", "source_type": "web", "collection_id": "c1", "chunk_count": 1}],
        retrieval_edges=[
            {"requester_id": "u1", "requester_type": "user", "source_id": "s-cut-off", "chunk_hits": 3},
        ],
        totals={"collections": 1, "sources": 90, "agents_with_knowledge": 0,
                "requesters_with_retrievals": 1},
    ), limit=1)

    assert [e for e in out["edges"] if e["label"] == "retrieved"] == []
    assert out["dangling_edges"] == 1
    # The requester node itself still shows — only the edge to the missing
    # source is withheld, same as a source node still showing when its
    # collection was the one that got cut.
    assert any(n["id"] == "user-u1" for n in out["nodes"])


@pytest.mark.asyncio
async def test_requesters_with_retrievals_disagreeing_marks_the_graph_truncated():
    # #215's rule applied to the NEW key specifically, not inherited for free
    # from the existing ones: shown and total must be able to disagree on
    # requesters_with_retrievals alone, with every other key agreeing, and
    # truncated must still come back True.
    out = await shared_store.knowledge_graph(_pool(
        retrieval_edges=[
            {"requester_id": "u1", "requester_type": "user", "source_id": "s1", "chunk_hits": 1},
        ],
        totals={"collections": 0, "sources": 0, "agents_with_knowledge": 0,
                "requesters_with_retrievals": 40},
    ), limit=1)

    assert out["total"]["requesters_with_retrievals"] == 40
    assert out["shown"]["requesters_with_retrievals"] == 1
    assert out["truncated"] is True


@pytest.mark.asyncio
async def test_TWIN_requesters_with_retrievals_agreeing_is_not_marked_truncated():
    out = await shared_store.knowledge_graph(_pool(
        retrieval_edges=[
            {"requester_id": "u1", "requester_type": "user", "source_id": "s1", "chunk_hits": 1},
        ],
        totals={"collections": 0, "sources": 0, "agents_with_knowledge": 0,
                "requesters_with_retrievals": 1},
    ), limit=100)

    assert out["truncated"] is False


@pytest.mark.asyncio
async def test_a_requester_with_multiple_sources_produces_one_node_not_one_per_edge():
    # Distinguishes "shown" (distinct requesters) from a row count — the same
    # #215/#188 shape as agents_with_knowledge, exercised on this key directly
    # rather than trusted by analogy.
    out = await shared_store.knowledge_graph(_pool(
        sources=[
            {"id": "s1", "title": "A", "source_type": "web", "collection_id": "c1", "chunk_count": 1},
            {"id": "s2", "title": "B", "source_type": "web", "collection_id": "c1", "chunk_count": 1},
        ],
        retrieval_edges=[
            {"requester_id": "u1", "requester_type": "user", "source_id": "s1", "chunk_hits": 1},
            {"requester_id": "u1", "requester_type": "user", "source_id": "s2", "chunk_hits": 1},
        ],
    ), limit=100)

    assert out["shown"]["requesters_with_retrievals"] == 1
    assert len([n for n in out["nodes"] if n["type"] == "user"]) == 1
