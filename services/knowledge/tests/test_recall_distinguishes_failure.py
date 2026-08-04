"""Recall must not report a dependency outage as "you have no memories".

THE SECOND HALF OF A DEFECT ALREADY CLOSED ON THE WRITE SIDE. The ingest path was
fixed this session for the embedder failing silently and the caller being told
nothing. This is the same root cause arriving on the READ side: `/memories/recall`
called `generate_embedding`, got `None` when the AI service was unreachable, passed
that to Postgres as `"null"::vector`, and `memory_store` caught the resulting error
and returned `[]`. The agent received `{"memories": [], "count": 0}` with HTTP 200.

Anyone reading either fix alone would think it was contained. It is one defect with
two ends.

THE FIXTURE MUST BE AN EMBEDDER THAT RETURNS None. With a working embedder and an
empty corpus, the broken and fixed versions BOTH return memories `[]` and count 0 —
so a test built on "no memories exist" passes on the defect and proves nothing.

Seventh instance this session of that one test-design mistake: a total that agrees
with itself, a search count below the cap, an optimistic ui on a successful
response, a succeeding command with a hardcoded exit code, a proxy fixture with no
header, a well-formed empty list, and now an embedder that works.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.routes import memories


class _Claims:
    sub = "agent-1"


class _Request:
    """Minimal stand-in: the route reads claims off state and the pool off app."""

    def __init__(self, pool):
        self.state = type("S", (), {"agent_claims": _Claims()})()
        self.app = type("A", (), {"state": type("AS", (), {"pool": pool})()})()


async def _call_recall(pool, embedding, recall_impl=None):
    with patch.object(memories, "generate_embedding", AsyncMock(return_value=embedding)), \
         patch.object(
             memories.memory_store,
             "recall_memories",
             AsyncMock(side_effect=recall_impl) if recall_impl else AsyncMock(return_value=[]),
         ):
        return await memories.recall_memories(_Request(pool), q="anything", limit=10)


@pytest.mark.asyncio
async def test_embedder_unavailable_is_503_not_an_empty_answer():
    """POSITIVE CONTROL. A working embedder cannot distinguish the versions."""
    with pytest.raises(HTTPException) as exc:
        await _call_recall(pool=object(), embedding=None)

    assert exc.value.status_code == 503
    # Naming what happened is what makes it actionable — an error that merely says
    # "failed" leaves the agent no better off than the empty list did.
    assert "embedding service" in exc.value.detail
    assert "not the same as having no memories" in exc.value.detail


@pytest.mark.asyncio
async def test_database_failure_is_503_not_an_empty_answer():
    """The other dependency, through what used to be the same silence."""
    async def _boom(*_args, **_kwargs):
        raise RuntimeError("connection refused")

    with pytest.raises(HTTPException) as exc:
        await _call_recall(pool=object(), embedding=[0.1, 0.2], recall_impl=_boom)

    assert exc.value.status_code == 503
    assert "database" in exc.value.detail


@pytest.mark.asyncio
async def test_genuinely_no_memories_is_still_a_successful_empty_answer():
    """GUARD RAIL, and the reason it is not the control: it passes on the broken
    code too. An empty corpus is a legitimate answer and must not become a failure
    — turning it into one would be the opposite defect."""
    result = await _call_recall(pool=object(), embedding=[0.1, 0.2])

    assert result["memories"] == []
    assert result["count"] == 0
    assert result["search_type"] == "vector"


@pytest.mark.asyncio
async def test_results_are_returned_and_labelled():
    async def _rows(*_args, **_kwargs):
        return [{"content": "a thing", "score": 0.9, "created_at": "2026-08-04"}]

    result = await _call_recall(pool=object(), embedding=[0.1], recall_impl=_rows)

    assert result["count"] == 1
    assert result["memories"][0]["content"] == "a thing"
    # Matches routes/shared.py's convention rather than inventing a second one.
    assert result["search_type"] == "vector"


@pytest.mark.asyncio
async def test_the_dead_guard_is_gone():
    """`generate_embedding` never raises — it catches everything and returns None.

    The route used to wrap it in try/except and return an `error` field from the
    handler, which could not fire. If someone reintroduces that pattern, a raising
    embedder would be swallowed into a 200 again; here it must propagate.
    """
    with patch.object(
        memories, "generate_embedding", AsyncMock(side_effect=RuntimeError("boom"))
    ):
        with pytest.raises(RuntimeError):
            await memories.recall_memories(_Request(object()), q="x", limit=10)


# ── the store itself, which the tests above mock away ──────────────────
#
# Everything above patches memory_store.recall_memories, so it exercises the
# ROUTE's handling and says nothing about the store. Reverting the store's `raise`
# to `return []` left all five of them passing — caught by running that revert
# rather than by reading the tests. The store needs its own.


class _FailingPool:
    async def fetch(self, *_args, **_kwargs):
        raise RuntimeError("connection refused")


class _EmptyPool:
    async def fetch(self, *_args, **_kwargs):
        return []


@pytest.mark.asyncio
async def test_store_raises_rather_than_returning_empty_on_db_failure():
    """POSITIVE CONTROL for the store. `return []` here is what made a Postgres
    outage indistinguishable from an agent with no memories."""
    from app.services import memory_store

    with pytest.raises(RuntimeError):
        await memory_store.recall_memories(_FailingPool(), "agent-1", [0.1, 0.2], limit=10)


@pytest.mark.asyncio
async def test_store_returns_empty_when_the_query_genuinely_matched_nothing():
    """Guard rail: an empty result set is still an empty list, not an error."""
    from app.services import memory_store

    rows = await memory_store.recall_memories(_EmptyPool(), "agent-1", [0.1, 0.2], limit=10)
    assert rows == []
