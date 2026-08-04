"""Search route for FTS queries."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.services import knowledge_store

router = APIRouter(prefix="/api/v1/search", tags=["search"])


@router.get("")
async def search(
    request: Request,
    q: str = Query(..., min_length=1, description="Search query"),
) -> dict[str, Any]:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    results, total_matches = await knowledge_store.search_entries(pool, claims, q)

    serialized = []
    for r in results:
        entry: dict[str, Any] = {}
        for key, value in r.items():
            if hasattr(value, "hex"):
                entry[key] = str(value)
            elif hasattr(value, "isoformat"):
                entry[key] = value.isoformat()
            else:
                entry[key] = value
        serialized.append(entry)

    # HOW MANY MATCHED, not how many fit in the page (#234).
    #
    # This endpoint is agent-facing — it is what `akm search` calls, so its
    # consumer is a model reasoning over its own knowledge base. An agent that
    # searches, gets twenty results and a `count` of twenty concludes those are
    # all the matches, and nothing downstream can correct it.
    #
    # Same vocabulary as `internal_admin.py` since #209 rather than a second
    # dialect: two search handlers in one service must not give two different
    # answers to "how many matched".
    return {
        "query": q,
        "results": serialized,
        # Unchanged meaning: how many rows are in THIS response.
        "count": len(serialized),
        # How many exist. Differs from `count` exactly when the page was cut.
        "total_matches": total_matches,
        "truncated": total_matches > len(serialized),
        "search_type": "fts",
        "score_type": "ts_rank",
    }
