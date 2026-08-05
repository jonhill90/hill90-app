"""Agent persistent memory endpoints.

Authenticated via Ed25519 JWT (same middleware as AKM entries).
Agent ID comes from JWT `sub` claim.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.services import memory_store
from app.services.embeddings import generate_embedding

router = APIRouter(prefix="/api/v1/memories", tags=["agent-memories"])


def _get_claims(request: Request) -> Any:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return claims


class SaveMemoryRequest(BaseModel):
    content: str


@router.post("")
async def save_memory(request: Request, body: SaveMemoryRequest) -> dict[str, Any]:
    """Save a memory for the authenticated agent."""
    claims = _get_claims(request)
    pool = request.app.state.pool
    agent_id = claims.sub

    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    if len(content) > 2000:
        raise HTTPException(status_code=400, detail="memory too long (max 2000 chars)")

    # NO try/except AROUND THIS CALL — same reasoning as recall_memories'
    # identical comment: generate_embedding catches every exception
    # internally and returns None, so it never raises. A try/except here
    # was dead code that could never fire.
    embedding = await generate_embedding(content)

    if embedding is None:
        # The write-side half of the defect recall_memories' own docstring
        # already fixed the read-side half of: memory_store.save_memory no
        # longer swallows the resulting Postgres error (there is no
        # try/except around its INSERT), but nothing here ever stopped
        # embedding=None from reaching it in the first place. json.dumps(None)
        # is the string "null", bound as $4::vector — verified directly
        # against a real pgvector/pgvector:pg16 container: `'null'::vector`
        # raises "invalid input syntax for type vector", an unhandled
        # exception with no relation to what actually went wrong. The honest
        # answer, same as recall's, is a failure — not an attempt.
        raise HTTPException(
            status_code=503,
            detail=(
                "Cannot save memory: the embedding service is unavailable. "
                "This is not the same as a save that was rejected — retry, "
                "or check the AI service."
            ),
        )

    result = await memory_store.save_memory(pool, agent_id, content, embedding)
    return {"saved": True, "memory": result}


@router.get("/recall")
async def recall_memories(
    request: Request,
    q: str = Query(..., min_length=1, description="Query to recall relevant memories"),
    limit: int = Query(10, ge=1, le=50, description="Max memories to return"),
) -> dict[str, Any]:
    """Recall relevant memories for the authenticated agent using semantic search."""
    claims = _get_claims(request)
    pool = request.app.state.pool
    agent_id = claims.sub

    # NO try/except AROUND THIS CALL. There was one, and it could never fire:
    # generate_embedding catches every exception internally and returns None. The
    # handler read as protection, provided none, and would have returned exactly
    # the error field that was missing from the response below.
    query_embedding = await generate_embedding(q)

    if query_embedding is None:
        # THE SECOND HALF OF A DEFECT ALREADY CLOSED ON THE WRITE SIDE. When the
        # embedder is unreachable this used to fall through with None, Postgres
        # rejected "null"::vector, memory_store swallowed that and returned [],
        # and the agent was told {"memories": [], "count": 0} with HTTP 200 —
        # indistinguishable from having no memories.
        #
        # There is no degraded mode to fall back to: agent_memories is searched
        # by vector only, so without an embedding the search cannot run at all.
        # `shared.py` can answer with search_type "fts" because it has a keyword
        # arm; this endpoint has none, so the honest answer is a failure, not an
        # empty success.
        raise HTTPException(
            status_code=503,
            detail=(
                "Cannot search memories: the embedding service is unavailable. "
                "This is not the same as having no memories — retry, or check the "
                "AI service."
            ),
        )

    try:
        memories = await memory_store.recall_memories(pool, agent_id, query_embedding, limit=limit)
    except Exception:
        # The other dependency. A Postgres failure produced the same empty
        # success, through the same silence.
        raise HTTPException(
            status_code=503,
            detail="Cannot search memories: the knowledge database is unavailable.",
        )

    return {
        "memories": [
            {"content": m["content"], "score": float(m.get("score", 0)), "created_at": str(m.get("created_at", ""))}
            for m in memories
        ],
        "count": len(memories),
        # Names which arm answered, matching routes/shared.py's convention rather
        # than inventing a second one. Only ever "vector" here — an empty result
        # from a vector search that RAN is a real answer.
        "search_type": "vector",
    }
