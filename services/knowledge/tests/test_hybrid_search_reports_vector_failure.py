"""hybrid_search_chunks silently fell back to FTS-only on a real vector-search
failure, exactly like a genuine zero-embedding-matches case — and the two
routes that call it (routes/shared.py, routes/internal_admin_shared.py) set
`search_type: "hybrid"` purely from "was an embedding generated for the
query", never from whether the vector arm actually ran. So a caller could be
told `search_type: "hybrid"` on a response that is, underneath, pure keyword
search — the exact shape this sweep is for: an operation (the vector half of
the search) that failed while the response reports it as having happened.

Not "returns nothing" — routes/memories.py already established elsewhere in
this codebase that returning nothing on a caught error is the wrong shape
(HTTPException instead). This is a milder but real variant: results ARE
returned (from FTS), but mislabeled as having included a semantic search
that never completed.

Fixed by moving the try/except from vector_search_chunks (which used to
catch everything and return [] either way) up into hybrid_search_chunks,
the one function with enough context to tell "ran, matched zero rows" apart
from "the query itself broke" — both used to collapse into the same empty
list and the same False-shaped signal.
"""
from __future__ import annotations

from typing import Any

import pytest

from app.services import shared_store


class _Pool:
    """fetch() returns FTS rows for the keyword-search SQL and, for the
    vector-search SQL (identified by the pgvector `<=>` operator, which only
    appears in vector_search_chunks's query), does one of: raise, return a
    real match, or return genuinely zero rows — same fake-pool shape used
    elsewhere in this suite (see test_list_sources_bounded.py).
    """

    def __init__(self, *, vector_mode: str):
        assert vector_mode in ("raises", "matches", "empty")
        self._vector_mode = vector_mode

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        if "<=>" in sql:
            if self._vector_mode == "raises":
                raise RuntimeError("simulated pgvector connection failure")
            if self._vector_mode == "empty":
                return []
            return [
                {
                    "chunk_id": "c-vec-1", "content": "vector hit", "chunk_index": 0,
                    "token_estimate": 10, "score": 0.9, "document_id": "d1",
                    "document_title": "Doc", "source_id": "s1", "source_title": "Src",
                    "source_url": "http://x", "collection_id": "col1", "collection_name": "Col",
                },
            ]
        # FTS path (search_chunks) always answers, real result or not.
        return [
            {
                "chunk_id": "c-fts-1", "content": "fts hit", "chunk_index": 0,
                "token_estimate": 10, "score": 0.5, "document_id": "d1",
                "document_title": "Doc", "source_id": "s1", "source_title": "Src",
                "source_url": "http://x", "collection_id": "col1", "collection_name": "Col",
                "headline": "fts hit",
            },
        ]


@pytest.mark.asyncio
async def test_vector_search_failure_is_reported_not_disguised_as_hybrid():
    pool = _Pool(vector_mode="raises")

    outcome = await shared_store.hybrid_search_chunks(
        pool, "query", query_embedding=[0.1, 0.2, 0.3],
    )

    # FTS still answers — this is not the "reports nothing" shape.
    assert len(outcome.results) == 1
    assert outcome.results[0]["chunk_id"] == "c-fts-1"

    # The gap: nothing before this fix could tell a caller the vector arm
    # died rather than genuinely matching zero chunks.
    assert outcome.vector_search_ok is False


@pytest.mark.asyncio
async def test_vector_search_success_is_reported_as_such():
    pool = _Pool(vector_mode="matches")

    outcome = await shared_store.hybrid_search_chunks(
        pool, "query", query_embedding=[0.1, 0.2, 0.3],
    )

    assert outcome.vector_search_ok is True
    ids = {r["chunk_id"] for r in outcome.results}
    assert "c-vec-1" in ids


@pytest.mark.asyncio
async def test_vector_search_ran_and_genuinely_matched_nothing_is_still_ok():
    # The distinction that collapsing into one "empty" signal would erase:
    # this ran fine, it just found nothing to add — a real hybrid search,
    # not a degraded one, even though the response looks identical to the
    # failure case above (FTS-only results) if you don't read vector_search_ok.
    pool = _Pool(vector_mode="empty")

    outcome = await shared_store.hybrid_search_chunks(
        pool, "query", query_embedding=[0.1, 0.2, 0.3],
    )

    assert outcome.vector_search_ok is True
    assert len(outcome.results) == 1
    assert outcome.results[0]["chunk_id"] == "c-fts-1"


@pytest.mark.asyncio
async def test_no_embedding_provided_is_reported_as_vector_not_run():
    pool = _Pool(vector_mode="matches")  # would succeed if asked — it is not asked

    outcome = await shared_store.hybrid_search_chunks(pool, "query", query_embedding=None)

    assert outcome.vector_search_ok is False
    assert len(outcome.results) == 1
    assert outcome.results[0]["chunk_id"] == "c-fts-1"
