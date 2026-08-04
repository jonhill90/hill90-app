"""Internal admin endpoints for shared knowledge — API proxy layer.

Authenticated with AKM_INTERNAL_SERVICE_TOKEN. The API service enforces
user-level authorization before calling these endpoints.
"""

from __future__ import annotations

from datetime import datetime

import time
from typing import Any

import asyncpg
from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel

from app.services import shared_store
from app.services.ingest import IngestError, ingest_source
from app.services.quality import compute_quality_summary, enrich_results_with_quality


def _validate_uuid(value: str, label: str = "id") -> None:
    """Raise 422 if value is not a valid UUID."""
    try:
        __import__("uuid").UUID(value)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail=f"invalid {label}: {value}")

router = APIRouter(prefix="/internal/admin/shared", tags=["internal-admin-shared"])


def _verify_service_token(request: Request) -> None:
    internal_token = request.app.state.settings.internal_service_token
    auth_header = request.headers.get("Authorization", "")
    if auth_header != f"Bearer {internal_token}":
        raise HTTPException(status_code=401, detail="invalid service token")


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------


class CollectionCreate(BaseModel):
    name: str
    description: str = ""
    visibility: str = "private"
    created_by: str


class CollectionUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    visibility: str | None = None


@router.post("/collections")
async def create_collection(
    body: CollectionCreate, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool

    if body.visibility not in ("private", "shared"):
        raise HTTPException(status_code=422, detail="visibility must be 'private' or 'shared'")

    try:
        return await shared_store.create_collection(
            pool,
            name=body.name,
            description=body.description,
            visibility=body.visibility,
            created_by=body.created_by,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=409,
            detail=f"collection '{body.name}' already exists for this user",
        )


@router.get("/collections")
async def list_collections(
    request: Request,
    response: Response,
    owner: str | None = Query(None, description="Owner user sub for scoping"),
    limit: int = Query(500, ge=1, le=2000, description="Max collections to return"),
    offset: int = Query(0, ge=0, description="Rows to skip before the page"),
) -> list[dict[str, Any]]:
    """List one page of collections, optionally scoped to an owner.

    ``owner`` is OPTIONAL, so omitting it spans every owner — the same shape as
    the task admin route in #184, and the reason this twin is bounded in the
    same change as the agent-facing one rather than after it.
    """
    _verify_service_token(request)
    pool = request.app.state.pool
    collections, total = await shared_store.list_collections(
        pool, owner=owner, limit=limit, offset=offset
    )
    response.headers["X-Total-Count"] = str(total)
    return collections


@router.get("/collections/{collection_id}")
async def get_collection(
    collection_id: str, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(collection_id, "collection_id")
    pool = request.app.state.pool
    result = await shared_store.get_collection(pool, collection_id)
    if result is None:
        raise HTTPException(status_code=404, detail="collection not found")
    return result


@router.put("/collections/{collection_id}")
async def update_collection(
    collection_id: str, body: CollectionUpdate, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(collection_id, "collection_id")
    pool = request.app.state.pool

    if body.visibility is not None and body.visibility not in ("private", "shared"):
        raise HTTPException(status_code=422, detail="visibility must be 'private' or 'shared'")

    result = await shared_store.update_collection(
        pool,
        collection_id,
        name=body.name,
        description=body.description,
        visibility=body.visibility,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="collection not found")
    return result


@router.delete("/collections/{collection_id}")
async def delete_collection(
    collection_id: str, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(collection_id, "collection_id")
    pool = request.app.state.pool
    deleted = await shared_store.delete_collection(pool, collection_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="collection not found")
    return {"deleted": True, "id": collection_id}


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


class SourceCreate(BaseModel):
    collection_id: str
    title: str
    source_type: str
    raw_content: str | None = None
    source_url: str | None = None
    created_by: str


@router.post("/sources")
async def create_source(body: SourceCreate, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(body.collection_id, "collection_id")
    pool = request.app.state.pool

    try:
        result = await ingest_source(
            pool,
            collection_id=body.collection_id,
            title=body.title,
            source_type=body.source_type,
            raw_content=body.raw_content or "",
            source_url=body.source_url,
            created_by=body.created_by,
        )
    except IngestError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # ingest_source returns error payload on internal failure (after job creation)
    if result.get("source", {}).get("status") == "error":
        raise HTTPException(
            status_code=500,
            detail=result.get("ingest_job", {}).get("error_message", "ingest failed"),
        )

    return result


@router.post("/embeddings/backfill")
async def backfill_embeddings(
    request: Request,
    limit: int = Query(50, ge=1, le=500, description="Max documents per run"),
) -> dict[str, Any]:
    """Embed chunks that have none, and recompute the documents' status.

    The converge half of #210. Ingest stays best-effort — a transient AI-service
    outage should not discard keyword-searchable content — but "best-effort"
    only means something honest if the gap can later be closed. This is the
    shared-knowledge counterpart of the entry reconciler.

    Bounded per run and safe to call repeatedly: it works from the CHUNKS, so a
    run that partially succeeds simply leaves less for the next one.
    """
    _verify_service_token(request)
    pool = request.app.state.pool

    from app.services.embeddings import generate_embeddings

    docs = await shared_store.documents_needing_embeddings(pool, limit=limit)

    repaired = 0
    embedded_chunks = 0
    still_incomplete = 0

    for doc in docs:
        chunks = await shared_store.chunks_missing_embeddings(pool, doc["id"])
        if not chunks:
            continue

        vectors = await generate_embeddings([c["content"] for c in chunks])
        # Positional pairing, and a SHORT response is partially applied rather
        # than discarded — the same correction made in create_chunks. Zipping
        # stops at the shorter sequence, which is exactly the prefix that came
        # back.
        pairs = [
            (c["id"], v) for c, v in zip(chunks, vectors or [])
        ]
        embedded_chunks += await shared_store.set_chunk_embeddings(pool, pairs)

        status = await shared_store.recompute_document_embedding_status(pool, doc["id"])
        if status == "embedded":
            repaired += 1
        else:
            still_incomplete += 1

    return {
        "documents_examined": len(docs),
        "documents_repaired": repaired,
        "documents_still_incomplete": still_incomplete,
        "chunks_embedded": embedded_chunks,
    }


@router.get("/sources")
async def list_sources(
    request: Request,
    collection_id: str = Query(..., description="Collection to list sources from"),
) -> list[dict[str, Any]]:
    _verify_service_token(request)
    _validate_uuid(collection_id, "collection_id")
    pool = request.app.state.pool
    return await shared_store.list_sources(pool, collection_id)


@router.get("/sources/{source_id}")
async def get_source(source_id: str, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(source_id, "source_id")
    pool = request.app.state.pool
    result = await shared_store.get_source(pool, source_id)
    if result is None:
        raise HTTPException(status_code=404, detail="source not found")
    return result


@router.delete("/sources/{source_id}")
async def delete_source(source_id: str, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(source_id, "source_id")
    pool = request.app.state.pool
    deleted = await shared_store.delete_source(pool, source_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="source not found")
    return {"deleted": True, "id": source_id}


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


@router.get("/search")
async def search_shared(
    request: Request,
    q: str = Query(..., min_length=1, description="Search query"),
    collection_id: str | None = Query(None, description="Optional collection filter"),
    owner: str | None = Query(None, description="Owner sub for visibility scoping"),
    requester_id: str = Query(..., description="Requester ID for audit"),
    requester_type: str = Query("user", description="Requester type: user or agent"),
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool

    if collection_id is not None:
        _validate_uuid(collection_id, "collection_id")

    if requester_type not in ("user", "agent"):
        raise HTTPException(status_code=422, detail="requester_type must be 'user' or 'agent'")

    from app.services.embeddings import generate_embedding

    t0 = time.monotonic()
    query_embedding = await generate_embedding(q)

    if query_embedding:
        results = await shared_store.hybrid_search_chunks(
            pool, q, query_embedding,
            owner=owner, collection_id=collection_id, limit=limit,
        )
        search_type = "hybrid"
    else:
        results = await shared_store.search_chunks(
            pool, q,
            owner=owner, collection_id=collection_id, limit=limit,
        )
        search_type = "fts"
    duration_ms = int((time.monotonic() - t0) * 1000)

    results = enrich_results_with_quality(results)
    quality_summary = compute_quality_summary(results)

    chunk_ids = [r["chunk_id"] for r in results]
    resolved_collection_id = collection_id
    if resolved_collection_id is None and results:
        resolved_collection_id = results[0].get("collection_id")

    await shared_store.record_retrieval(
        pool,
        query=q,
        requester_type=requester_type,
        requester_id=requester_id,
        result_count=len(results),
        chunk_ids=chunk_ids,
        duration_ms=duration_ms,
        collection_id=resolved_collection_id,
    )

    return {
        "query": q,
        "results": results,
        "count": len(results),
        "search_type": search_type,
        "score_type": "ts_rank",
        "quality_summary": quality_summary,
    }


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


@router.get("/stats")
async def get_stats(
    request: Request,
    # `datetime`, not `str`. asyncpg requires a datetime for a timestamptz parameter
    # and raises TypeError on a string, so this endpoint returned 500 for every
    # request that supplied `since`. Typing it here also gets ISO-8601 parsing and a
    # 422 on malformed input from FastAPI, instead of a crash deep in the driver.
    since: datetime | None = Query(None, description="ISO timestamp to scope time-based stats"),
) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool
    return await shared_store.get_shared_stats(pool, since=since)
