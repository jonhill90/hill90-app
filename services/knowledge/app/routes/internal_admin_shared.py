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
from pydantic import BaseModel, ValidationError

from app.services import shared_store
from app.services.ingest import IngestError, ingest_source
from app.services.quality import compute_quality_summary, enrich_results_with_quality
from app.services.text_chunker import MAX_SOURCE_SIZE

# The Content-Length pre-check below bounds the whole JSON request body
# (collection_id, title, source_url, created_by, JSON syntax, and
# raw_content all together), not raw_content alone — and JSON string
# escaping can expand content somewhat (a literal newline becomes `\n`,
# a quote becomes `\"`). This is deliberately generous rather than tight:
# ingest.py's own MAX_SOURCE_SIZE check, run on the actual decoded
# raw_content string after parsing, is what enforces the real 100KB limit
# precisely. This constant's only job is to refuse something WILDLY
# oversized before it is ever read into memory.
MAX_REQUEST_BODY_BYTES = MAX_SOURCE_SIZE * 2


def _validate_uuid(value: str, label: str = "id") -> None:
    """Raise 422 if value is not a valid UUID."""
    try:
        __import__("uuid").UUID(value)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail=f"invalid {label}: {value}")


def _reject_if_content_length_exceeds(request: Request, max_bytes: int) -> None:
    """Refuse a request based on its DECLARED Content-Length, before the
    body is read at all.

    NOT the enforcement of MAX_SOURCE_SIZE itself — that still happens in
    ingest.py, on the real decoded raw_content string, after parsing. This
    is the cheap first line: a caller sending a wildly oversized payload
    should not cost this process an allocation proportional to what they
    sent just to be told no. A caller that lies about or omits
    Content-Length is not caught here — that is exactly what the existing
    post-parse check in ingest.py remains the backstop for.
    """
    declared = request.headers.get("content-length")
    if declared is None:
        return
    try:
        declared_bytes = int(declared)
    except ValueError:
        return
    if declared_bytes > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=(
                f"request body declares {declared_bytes} bytes, exceeding the "
                f"{max_bytes // 1024}KB limit"
            ),
        )

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
async def create_source(request: Request) -> dict[str, Any]:
    """Ingest a source.

    Takes a raw Request rather than declaring `body: SourceCreate` as a
    parameter — that shape works everywhere else in this file, but here it
    would defeat the whole point of `_reject_if_content_length_exceeds`:
    FastAPI resolves a Pydantic-model parameter by reading and parsing the
    ENTIRE request body before this function's own code runs at all. The
    Content-Length check needs to happen first, so the body is parsed by
    hand, one line down, after that check has already passed.
    """
    _verify_service_token(request)
    _reject_if_content_length_exceeds(request, MAX_REQUEST_BODY_BYTES)

    try:
        raw_body = await request.json()
    except Exception:
        raise HTTPException(status_code=422, detail="request body is not valid JSON")
    try:
        body = SourceCreate.model_validate(raw_body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

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
    response: Response,
    collection_id: str = Query(..., description="Collection to list sources from"),
    limit: int = Query(200, ge=1, le=1000, description="Max sources to return"),
    offset: int = Query(0, ge=0, description="Rows to skip before the page"),
) -> list[dict[str, Any]]:
    """One page of a collection's sources.

    The total travels in ``X-Total-Count`` and the body stays a bare array, for
    the reason `list_entries` records: a consumer on an older build does
    ``Array.isArray(data) ? data : []``, so a body object here renders an EMPTY
    list — the silent truncation this bound exists to prevent, caused by the fix
    for it (#180).
    """
    _verify_service_token(request)
    _validate_uuid(collection_id, "collection_id")
    pool = request.app.state.pool
    sources, total = await shared_store.list_sources(pool, collection_id, limit=limit, offset=offset)
    response.headers["X-Total-Count"] = str(total)
    return sources


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
    requester_display_name: str | None = Query(
        None,
        description="app#499: the requester's own Keycloak name, forwarded by the "
        "api from the CALLER's own token — never resolved for anyone else.",
    ),
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
        outcome = await shared_store.hybrid_search_chunks(
            pool, q, query_embedding,
            owner=owner, collection_id=collection_id, limit=limit,
        )
        results = outcome.results
        # See routes/shared.py's identical comment: search_type now reflects
        # whether the vector query actually ran, not just whether an
        # embedding was generated for it.
        search_type = "hybrid" if outcome.vector_search_ok else "fts"
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
        requester_display_name=requester_display_name,
    )

    return {
        "query": q,
        "results": results,
        "count": len(results),
        "search_type": search_type,
        # Twin of routes/shared.py's own derivation. Hardcoded "ts_rank"
        # here regardless of search_type meant a hybrid admin search's
        # `score` field — actually the blended fts/vector score computed in
        # hybrid_search_chunks — was reported as a plain ts_rank, which is
        # not on the same scale and cannot be interpreted as one.
        "score_type": "hybrid" if search_type == "hybrid" else "ts_rank",
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
    # Cross-service sibling-drift sweep (app#445 family): every other route in
    # this file's api-side twin (routes/shared-knowledge.ts) derives owner from
    # scopeToOwner before proxying. This one didn't, so a non-admin caller saw
    # every user's top_collections/top_sources names. owner=None (admin) is
    # unchanged.
    owner: str | None = Query(None, description="Scope stats to this owner; omitted/None for admin (unscoped)"),
) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool
    return await shared_store.get_shared_stats(pool, since=since, owner=owner)

@router.get("/graph")
async def knowledge_graph(
    request: Request,
    limit: int = Query(100, ge=1, le=500),
    # Same fix as /stats above — see shared_store.knowledge_graph's docstring.
    owner: str | None = Query(None, description="Scope the graph to this owner; omitted/None for admin (unscoped)"),
) -> dict[str, Any]:
    """The shared-knowledge graph, from the service that owns the tables (#300)."""
    _verify_service_token(request)
    pool = request.app.state.pool
    return await shared_store.knowledge_graph(pool, limit, owner=owner)

