"""Save must not let a dependency outage surface as a raw Postgres error.

THE OTHER HALF OF THE DEFECT test_recall_distinguishes_failure.py's own
docstring calls "already closed on the write side" — it was not. That
docstring described `memory_store.save_memory` no longer SWALLOWING the
resulting Postgres error (confirmed: the current store has no try/except
around its INSERT, so a failure there propagates). What it never received
is the explicit, clean guard `recall_memories` got: `save_memory`'s route
handler still wraps only `generate_embedding()` in a try/except that can
never fire (`generate_embedding` catches everything internally and
returns `None`, never raises — the exact dead-guard shape
`test_recall_distinguishes_failure.py::test_the_dead_guard_is_gone`
already documents for the read side), with no `if embedding is None`
check anywhere.

Verified directly against a real `pgvector/pgvector:pg16` container, not
guessed: `SELECT 'null'::vector;` raises `invalid input syntax for type
vector: "null"` — `json.dumps(None)` is the string `"null"`, which is
exactly what an unchecked `None` embedding becomes when bound as
`$4::vector`. That exception is not caught anywhere in this call chain,
so a caller trying to save a memory during an AI-service outage gets an
unhandled 500 with a raw Postgres syntax error, instead of the same
clean "the embedding service is unavailable" message `recall_memories`
already gives for the identical root cause.

WHAT THIS TEST PROVES. That save_memory raises the same clean, actionable
503 recall_memories does, before ever reaching the store — not that the
store's own error handling changes (it already correctly propagates,
per the analysis above).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.routes import memories


class _Claims:
    sub = "agent-1"


class _Request:
    def __init__(self, pool):
        self.state = type("S", (), {"agent_claims": _Claims()})()
        self.app = type("A", (), {"state": type("AS", (), {"pool": pool})()})()


class SaveMemoryBody:
    def __init__(self, content: str):
        self.content = content


async def _call_save(pool, embedding, content="a memory worth keeping"):
    with patch.object(memories, "generate_embedding", AsyncMock(return_value=embedding)):
        return await memories.save_memory(_Request(pool), SaveMemoryBody(content))


@pytest.mark.asyncio
async def test_embedder_unavailable_is_503_not_a_raw_db_error():
    """POSITIVE CONTROL. Pre-fix, this reaches memory_store.save_memory with
    embedding=None and raises whatever asyncpg does for 'null'::vector — an
    unhandled exception, not an HTTPException at all. Confirmed failing for
    that reason before the fix landed."""
    with pytest.raises(HTTPException) as exc:
        await _call_save(pool=object(), embedding=None)

    assert exc.value.status_code == 503
    assert "embedding service" in exc.value.detail
    assert "not the same as" in exc.value.detail


@pytest.mark.asyncio
async def test_a_genuinely_saved_memory_is_still_a_successful_save():
    """GUARD RAIL: a working embedder must not be caught by the same net."""
    with patch.object(
        memories.memory_store, "save_memory",
        AsyncMock(return_value={"id": "mem-1", "agent_id": "agent-1", "content": "a memory worth keeping"}),
    ):
        result = await _call_save(pool=object(), embedding=[0.1, 0.2])

    assert result["saved"] is True
    assert result["memory"]["id"] == "mem-1"


@pytest.mark.asyncio
async def test_the_dead_guard_is_gone():
    """Same shape as recall's own regression guard: generate_embedding never
    raises, so a try/except around only that call is dead code. If it comes
    back, a raising embedder would be swallowed into a misleading 500 with
    the wrong message instead of propagating or being caught properly."""
    with patch.object(
        memories, "generate_embedding", AsyncMock(side_effect=RuntimeError("boom"))
    ):
        with pytest.raises(RuntimeError):
            await memories.save_memory(_Request(object()), SaveMemoryBody("x"))
