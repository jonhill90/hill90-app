"""Database operations for the Shared Knowledge Base.

Collections, sources, ingest jobs, documents, chunks, and retrieval audit.
Follows patterns established in knowledge_store.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from typing import Any
from uuid import UUID

import asyncpg
import structlog

logger = structlog.get_logger()


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    """Serialize DB row for JSON response."""
    result = {}
    for key, value in row.items():
        if hasattr(value, "hex"):  # UUID
            result[key] = str(value)
        elif hasattr(value, "isoformat"):  # datetime
            result[key] = value.isoformat()
        elif isinstance(value, list):
            result[key] = [str(v) if hasattr(v, "hex") else v for v in value]
        else:
            result[key] = value
    return result


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------


async def create_collection(
    pool: asyncpg.Pool,
    *,
    name: str,
    description: str,
    visibility: str,
    created_by: str,
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_collections (name, description, visibility, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING *""",
        name,
        description,
        visibility,
        created_by,
    )
    return _serialize(dict(row))


async def list_collections(
    pool: asyncpg.Pool,
    *,
    owner: str | None = None,
    include_shared: bool = True,
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """List one page of collections visible to the given owner, and the total.

    Returns ``(rows, total)`` where ``total`` is a ``COUNT(*)`` over the SAME
    ``WHERE`` as the page — never ``len(rows)``. A total derived from the page
    agrees with itself and reports truncation as completeness (#207).

    If owner is None, all collections (admin). Otherwise the owner's own plus,
    when ``include_shared``, everything marked shared.

    This is read by an AGENT, via ``GET /api/v1/shared/collections``. An agent
    has no scrollbar and no sense that a list ended early — it reasons over
    what it received and reports success — so the bound and the total matter
    more here than on a surface a human reads, not less.
    """
    base = """SELECT c.*,
               COUNT(DISTINCT s.id) AS source_count,
               COUNT(DISTINCT d.id) AS document_count
           FROM shared_collections c
           LEFT JOIN shared_sources s ON s.collection_id = c.id
           LEFT JOIN shared_documents d ON d.source_id = s.id"""

    # updated_at is not unique for collections created in the same instant, so
    # the ORDER BY carries an id tiebreak. Paging over a non-unique sort key
    # hands one row to two pages and no page to another.
    order = "GROUP BY c.id ORDER BY c.updated_at DESC, c.id DESC"

    if owner is None:
        where, params = "", []
    elif include_shared:
        where, params = "WHERE c.created_by = $1 OR c.visibility = 'shared'", [owner]
    else:
        where, params = "WHERE c.created_by = $1", [owner]

    page_params = [*params, limit, offset]
    rows = await pool.fetch(
        f"""{base}
           {where}
           {order}
           LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}""",
        *page_params,
    )
    # Counted over the same WHERE as the page. The DISTINCT joins above are
    # only there for the per-row aggregates, so the count needs the base table
    # alone — a JOIN here would multiply rows and inflate the total.
    total = await pool.fetchval(
        f"SELECT COUNT(*) FROM shared_collections c {where}",
        *params,
    )
    return [_serialize(dict(r)) for r in rows], total


async def get_collection(
    pool: asyncpg.Pool, collection_id: str
) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT * FROM shared_collections WHERE id = $1",
        UUID(collection_id),
    )
    return _serialize(dict(row)) if row else None


async def update_collection(
    pool: asyncpg.Pool,
    collection_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
    visibility: str | None = None,
) -> dict[str, Any] | None:
    # Build dynamic SET clause
    sets: list[str] = ["updated_at = NOW()"]
    params: list[Any] = []
    idx = 1

    if name is not None:
        sets.append(f"name = ${idx}")
        params.append(name)
        idx += 1
    if description is not None:
        sets.append(f"description = ${idx}")
        params.append(description)
        idx += 1
    if visibility is not None:
        sets.append(f"visibility = ${idx}")
        params.append(visibility)
        idx += 1

    params.append(UUID(collection_id))
    row = await pool.fetchrow(
        f"UPDATE shared_collections SET {', '.join(sets)} WHERE id = ${idx} RETURNING *",
        *params,
    )
    return _serialize(dict(row)) if row else None


async def delete_collection(pool: asyncpg.Pool, collection_id: str) -> bool:
    result = await pool.execute(
        "DELETE FROM shared_collections WHERE id = $1",
        UUID(collection_id),
    )
    return result == "DELETE 1"


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


async def create_source(
    pool: asyncpg.Pool,
    *,
    collection_id: str,
    title: str,
    source_type: str,
    raw_content: str | None,
    content_hash: str,
    source_url: str | None = None,
    created_by: str,
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_sources
           (collection_id, title, source_type, source_url, raw_content, content_hash, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *""",
        UUID(collection_id),
        title,
        source_type,
        source_url,
        raw_content,
        content_hash,
        created_by,
    )
    return _serialize(dict(row))


async def get_source(pool: asyncpg.Pool, source_id: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT * FROM shared_sources WHERE id = $1",
        UUID(source_id),
    )
    return _serialize(dict(row)) if row else None


SOURCES_PAGE_LIMIT = 200


async def list_sources(
    pool: asyncpg.Pool,
    collection_id: str,
    limit: int = SOURCES_PAGE_LIMIT,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """One page of a collection's sources, and how many there are (#180).

    THE TWIN of `list_entries`, and it was left behind when that was bounded.
    This returned every row, and `SharedKnowledgeClient.tsx:886` renders
    `{sources.length} source(s)` from it — a figure that was correct only
    because nothing capped the query. #180 says exactly that: a length correct
    only because nothing is bounded is a defect waiting for someone to bound it,
    and #188 is the time this estate shipped that regression.

    THE TOTAL IS A COUNT(*) over the same WHERE, never `len(rows)`, and it
    travels with the page — bounding without telling the caller would turn "300
    sources" into a confident "50", which is the defect wearing a fix (#215).

    The `id` tiebreak matters for the same reason it does in `list_entries`:
    sources created in the same instant share a `created_at`, and paging over a
    non-unique sort key can hand one row to two pages and no page to another.
    """
    rows = await pool.fetch(
        """SELECT id, collection_id, title, source_type, source_url,
                  content_hash, status, error_message, created_by, created_at, updated_at
           FROM shared_sources
           WHERE collection_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2 OFFSET $3""",
        UUID(collection_id),
        limit,
        offset,
    )
    total = await pool.fetchval(
        """SELECT count(*) FROM shared_sources WHERE collection_id = $1""",
        UUID(collection_id),
    )
    return [_serialize(dict(r)) for r in rows], int(total or 0)


async def update_source_status(
    pool: asyncpg.Pool,
    source_id: str,
    *,
    status: str,
    error_message: str | None = None,
) -> None:
    await pool.execute(
        """UPDATE shared_sources
           SET status = $2, error_message = $3, updated_at = NOW()
           WHERE id = $1""",
        UUID(source_id),
        status,
        error_message,
    )


async def delete_source(pool: asyncpg.Pool, source_id: str) -> bool:
    result = await pool.execute(
        "DELETE FROM shared_sources WHERE id = $1",
        UUID(source_id),
    )
    return result == "DELETE 1"


# ---------------------------------------------------------------------------
# Ingest Jobs
# ---------------------------------------------------------------------------


async def create_ingest_job(
    pool: asyncpg.Pool, source_id: str
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_ingest_jobs (source_id)
           VALUES ($1) RETURNING *""",
        UUID(source_id),
    )
    return _serialize(dict(row))


async def update_ingest_job(
    pool: asyncpg.Pool,
    job_id: str,
    *,
    status: str,
    chunk_count: int | None = None,
    error_message: str | None = None,
) -> None:
    if status == "running":
        await pool.execute(
            """UPDATE shared_ingest_jobs
               SET status = 'running', started_at = NOW()
               WHERE id = $1""",
            UUID(job_id),
        )
    elif status == "completed":
        await pool.execute(
            """UPDATE shared_ingest_jobs
               SET status = 'completed', completed_at = NOW(), chunk_count = $2
               WHERE id = $1""",
            UUID(job_id),
            chunk_count or 0,
        )
    elif status == "failed":
        await pool.execute(
            """UPDATE shared_ingest_jobs
               SET status = 'failed', completed_at = NOW(), error_message = $2
               WHERE id = $1""",
            UUID(job_id),
            error_message,
        )


# ---------------------------------------------------------------------------
# Documents & Chunks
# ---------------------------------------------------------------------------


async def create_document(
    pool: asyncpg.Pool,
    *,
    source_id: str,
    ingest_job_id: str,
    title: str,
    content_hash: str,
    chunk_count: int,
    embedding_status: str = "pending",
) -> dict[str, Any]:
    """Insert a document row.

    ``embedding_status`` defaults to 'pending' rather than 'embedded' on
    purpose: at the moment this row is created the chunks do not exist yet, so
    claiming coverage here would be asserting something not yet true (#210).
    The ingest sets the real value once it knows what the embedder returned.
    """
    row = await pool.fetchrow(
        """INSERT INTO shared_documents
           (source_id, ingest_job_id, title, content_hash, chunk_count, embedding_status)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *""",
        UUID(source_id),
        UUID(ingest_job_id),
        title,
        content_hash,
        chunk_count,
        embedding_status,
    )
    return _serialize(dict(row))


async def set_document_embedding_status(
    pool: asyncpg.Pool, document_id: str, status: str
) -> None:
    """Record what the embedder actually achieved for this document."""
    await pool.execute(
        "UPDATE shared_documents SET embedding_status = $2 WHERE id = $1",
        UUID(document_id),
        status,
    )


async def create_chunks(
    pool: asyncpg.Pool,
    document_id: str,
    chunks: list[tuple[int, str, int]],
    embeddings: list[list[float]] | None = None,
) -> tuple[int, int]:
    """Bulk-insert chunks. Each tuple is (chunk_index, content, token_estimate).

    Returns ``(inserted, embedded)`` — how many chunks were written and how
    many of them carry a vector. The caller needs the second number to record
    an honest embedding_status; it cannot infer it from the first (#210).

    A PARTIAL embedding response is stored, not discarded. This used to be
    ``if embeddings and len(embeddings) == len(chunks)``, which treated "the
    embedder returned 30 vectors for 42 chunks" identically to "the embedder
    returned nothing" and threw away all 30. The next person debugging a
    coverage gap would have gone looking for a total outage that never
    happened.
    """
    doc_uuid = UUID(document_id)
    vectors = embeddings or []

    if len(vectors) != len(chunks):
        # Distinguished in the log, because the two have different causes:
        # none at all means the embedder was unreachable or unconfigured; a
        # mismatch means it answered and answered short.
        if not vectors:
            logger.warning(
                "chunk_embeddings_absent",
                document_id=document_id,
                chunks=len(chunks),
            )
        else:
            logger.warning(
                "chunk_embeddings_partial",
                document_id=document_id,
                chunks=len(chunks),
                embeddings=len(vectors),
            )

    import json

    embedded = 0
    with_vec: list[tuple[Any, ...]] = []
    without_vec: list[tuple[Any, ...]] = []

    for i, (idx, content, tokens) in enumerate(chunks):
        # Positional pairing is what the embedding API contract gives us: the
        # nth vector belongs to the nth input. A short response therefore
        # covers a PREFIX of the chunks, and the rest are genuinely unembedded.
        if i < len(vectors):
            with_vec.append((doc_uuid, idx, content, tokens, json.dumps(vectors[i])))
            embedded += 1
        else:
            without_vec.append((doc_uuid, idx, content, tokens))

    if with_vec:
        await pool.executemany(
            """INSERT INTO shared_chunks (document_id, chunk_index, content, token_estimate, embedding)
               VALUES ($1, $2, $3, $4, $5::vector)""",
            with_vec,
        )
    if without_vec:
        await pool.executemany(
            """INSERT INTO shared_chunks (document_id, chunk_index, content, token_estimate)
               VALUES ($1, $2, $3, $4)""",
            without_vec,
        )

    return len(chunks), embedded


async def vector_coverage(
    pool: asyncpg.Pool, *, owner: str | None = None, collection_id: str | None = None
) -> dict[str, int]:
    """How much of the searchable corpus can be reached by the vector arm.

    ``search_type: "hybrid"`` says the QUERY embedded. It says nothing about
    whether the CORPUS did, and a caller reads it as if it did (#210).
    vector_search_chunks filters `embedding IS NOT NULL`, so chunks ingested
    during an embedding outage are excluded from the vector arm permanently —
    they still match on keywords, but can never be found by a paraphrase.

    Scoped exactly like the search it describes: a coverage figure computed
    over a different visibility scope would tell one owner about another's
    corpus, which is the same leak a mis-scoped COUNT would be.
    """
    conditions: list[str] = []
    params: list[Any] = []
    idx = 1

    if owner is not None:
        conditions.append(f"(sc.created_by = ${idx} OR sc.visibility = 'shared')")
        params.append(owner)
        idx += 1
    if collection_id is not None:
        conditions.append(f"sc.id = ${idx}")
        params.append(UUID(collection_id))
        idx += 1

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    row = await pool.fetchrow(
        f"""SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE sch.embedding IS NOT NULL) AS embedded
            FROM shared_chunks sch
            JOIN shared_documents sd ON sch.document_id = sd.id
            JOIN shared_sources ss ON sd.source_id = ss.id
            JOIN shared_collections sc ON ss.collection_id = sc.id
            {where}""",
        *params,
    )
    return {"chunks": int(row["total"]), "embedded_chunks": int(row["embedded"])}


def embedding_status_for(total: int, embedded: int) -> str:
    """Map coverage onto the column's four states.

    A document with no chunks at all is 'embedded' rather than 'pending':
    there is nothing missing, and marking it pending would put a permanent
    entry on the backfill's work list that can never be satisfied.
    """
    if embedded >= total:
        return "embedded"
    if embedded == 0:
        return "pending"
    return "partial"


async def search_chunks(
    pool: asyncpg.Pool,
    query: str,
    *,
    owner: str | None = None,
    collection_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Full-text search across shared chunks with visibility scoping.

    owner=None means admin (sees all).
    owner=<sub> means see owner's private + all shared.
    """
    params: list[Any] = [query]
    conditions = [
        "sch.search_vector @@ websearch_to_tsquery('english', $1)",
    ]
    idx = 2

    if owner is not None:
        conditions.append(
            f"(sc.created_by = ${idx} OR sc.visibility = 'shared')"
        )
        params.append(owner)
        idx += 1

    if collection_id is not None:
        conditions.append(f"sc.id = ${idx}")
        params.append(UUID(collection_id))
        idx += 1

    where = " AND ".join(conditions)
    params.append(limit)

    rows = await pool.fetch(
        f"""SELECT
                sch.id AS chunk_id,
                sch.content,
                sch.chunk_index,
                sch.token_estimate,
                ts_rank(sch.search_vector, websearch_to_tsquery('english', $1)) AS score,
                ts_headline('english', sch.content, websearch_to_tsquery('english', $1),
                            'StartSel=**, StopSel=**, MaxFragments=3, MaxWords=50') AS headline,
                sd.id AS document_id,
                sd.title AS document_title,
                ss.id AS source_id,
                ss.title AS source_title,
                ss.source_url,
                sc.id AS collection_id,
                sc.name AS collection_name
            FROM shared_chunks sch
            JOIN shared_documents sd ON sch.document_id = sd.id
            JOIN shared_sources ss ON sd.source_id = ss.id
            JOIN shared_collections sc ON ss.collection_id = sc.id
            WHERE {where}
              AND ss.status = 'active'
            ORDER BY score DESC
            LIMIT ${idx}""",
        *params,
    )

    return [_serialize(dict(r)) for r in rows]


async def vector_search_chunks(
    pool: asyncpg.Pool,
    query_embedding: list[float],
    *,
    owner: str | None = None,
    collection_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Semantic vector search using pgvector cosine similarity.

    Raises on failure — genuinely zero matches (no rows) is a normal return,
    a broken query is not, and the two must stay distinguishable to the one
    caller (hybrid_search_chunks), which is where the graceful FTS fallback
    belongs. Swallowing it here made "the column doesn't exist yet" and "the
    connection just died" indistinguishable to every caller, forever.
    """
    import json

    params: list[Any] = [json.dumps(query_embedding)]
    conditions = ["sch.embedding IS NOT NULL"]
    idx = 2

    if owner is not None:
        conditions.append(
            f"(sc.created_by = ${idx} OR sc.visibility = 'shared')"
        )
        params.append(owner)
        idx += 1

    if collection_id is not None:
        conditions.append(f"sc.id = ${idx}")
        params.append(UUID(collection_id))
        idx += 1

    where = " AND ".join(conditions)
    params.append(limit)

    rows = await pool.fetch(
        f"""SELECT
                sch.id AS chunk_id,
                sch.content,
                sch.chunk_index,
                sch.token_estimate,
                1 - (sch.embedding <=> $1::vector) AS score,
                sd.id AS document_id,
                sd.title AS document_title,
                ss.id AS source_id,
                ss.title AS source_title,
                ss.source_url,
                sc.id AS collection_id,
                sc.name AS collection_name
            FROM shared_chunks sch
            JOIN shared_documents sd ON sch.document_id = sd.id
            JOIN shared_sources ss ON sd.source_id = ss.id
            JOIN shared_collections sc ON ss.collection_id = sc.id
            WHERE {where}
              AND ss.status = 'active'
            ORDER BY sch.embedding <=> $1::vector
            LIMIT ${idx}""",
        *params,
    )
    return [_serialize(dict(r)) for r in rows]


@dataclass
class HybridSearchOutcome:
    """`vector_search_ok` distinguishes "the vector arm ran and matched
    nothing" from "the vector arm never ran, or died". vector_search_chunks
    itself raises on any failure now — it does not swallow exceptions or
    decide gracefully-vs-not on its own. hybrid_search_chunks is what catches
    that and decides: it is the one place with enough context to tell "ran,
    matched zero rows" (vector_search_ok=True) apart from "the query itself
    broke" (vector_search_ok=False), and it is the only place this
    distinction survives — not because vector_search_chunks hides it, but
    because vector_search_chunks's own contract is "raise or return real
    rows", nothing softer. Callers use vector_search_ok to report an honest
    search_type instead of one inferred from "was an embedding generated",
    which stays true even when the vector query itself failed after a real
    embedding was produced.
    """

    results: list[dict[str, Any]]
    vector_search_ok: bool


async def hybrid_search_chunks(
    pool: asyncpg.Pool,
    query: str,
    query_embedding: list[float] | None = None,
    *,
    owner: str | None = None,
    collection_id: str | None = None,
    limit: int = 20,
    vector_weight: float = 0.6,
) -> HybridSearchOutcome:
    """Hybrid search combining FTS keyword matching and vector similarity.

    If no embedding is provided, falls back to FTS-only.
    Deduplicates results and blends scores with configurable weighting.
    """
    # Always run FTS
    fts_results = await search_chunks(
        pool, query, owner=owner, collection_id=collection_id, limit=limit
    )

    if not query_embedding:
        return HybridSearchOutcome(results=fts_results, vector_search_ok=False)

    # vector_search_chunks raises on a real failure now — caught HERE,
    # specifically, so "ran and matched zero rows" (vector_search_ok=True,
    # empty list) stays distinguishable from "the query itself broke"
    # (vector_search_ok=False). Collapsing those two into the same "empty"
    # value is exactly the shape this function used to have.
    try:
        vec_results = await vector_search_chunks(
            pool, query_embedding, owner=owner, collection_id=collection_id, limit=limit
        )
    except Exception as exc:
        logger.warning("Vector search failed (falling back to FTS): %s", exc)
        return HybridSearchOutcome(results=fts_results, vector_search_ok=False)

    if not vec_results:
        # Ran fine, genuinely nothing to merge — still a real hybrid search.
        return HybridSearchOutcome(results=fts_results, vector_search_ok=True)

    # Merge: build a map of chunk_id -> result, blend scores
    merged: dict[str, dict[str, Any]] = {}
    fts_weight = 1.0 - vector_weight

    for r in fts_results:
        cid = str(r["chunk_id"])
        merged[cid] = {**r, "fts_score": float(r.get("score", 0)), "vec_score": 0.0}

    for r in vec_results:
        cid = str(r["chunk_id"])
        if cid in merged:
            merged[cid]["vec_score"] = float(r.get("score", 0))
        else:
            merged[cid] = {**r, "fts_score": 0.0, "vec_score": float(r.get("score", 0))}
            # No headline for vector-only results
            if "headline" not in merged[cid]:
                merged[cid]["headline"] = r.get("content", "")[:200]

    # Compute blended score
    for item in merged.values():
        item["score"] = (
            fts_weight * item["fts_score"] + vector_weight * item["vec_score"]
        )
        item["search_type"] = (
            "hybrid" if item["fts_score"] > 0 and item["vec_score"] > 0
            else "vector" if item["vec_score"] > 0
            else "fts"
        )

    results = sorted(merged.values(), key=lambda x: x["score"], reverse=True)[:limit]
    return HybridSearchOutcome(results=results, vector_search_ok=True)


# ---------------------------------------------------------------------------
# Retrieval Audit
# ---------------------------------------------------------------------------


async def documents_needing_embeddings(
    pool: asyncpg.Pool, limit: int = 50
) -> list[dict[str, Any]]:
    """Documents with at least one chunk missing a vector.

    Driven off the chunks rather than off embedding_status, deliberately: the
    status column is a report, and a backfill that trusted the report would be
    unable to repair a row whose status was wrong. The chunks are the fact.
    """
    rows = await pool.fetch(
        """SELECT d.id, d.title, d.chunk_count,
                  COUNT(*) FILTER (WHERE c.embedding IS NULL) AS missing
           FROM shared_documents d
           JOIN shared_chunks c ON c.document_id = d.id
           GROUP BY d.id, d.title, d.chunk_count
           HAVING COUNT(*) FILTER (WHERE c.embedding IS NULL) > 0
           ORDER BY d.created_at ASC
           LIMIT $1""",
        limit,
    )
    return [_serialize(dict(r)) for r in rows]


async def chunks_missing_embeddings(
    pool: asyncpg.Pool, document_id: str
) -> list[dict[str, Any]]:
    """The un-embedded chunks of one document, oldest first."""
    rows = await pool.fetch(
        """SELECT id, chunk_index, content
           FROM shared_chunks
           WHERE document_id = $1 AND embedding IS NULL
           ORDER BY chunk_index ASC""",
        UUID(document_id),
    )
    return [_serialize(dict(r)) for r in rows]


async def set_chunk_embeddings(
    pool: asyncpg.Pool, pairs: list[tuple[str, list[float]]]
) -> int:
    """Attach vectors to chunks that had none. Returns how many were set."""
    if not pairs:
        return 0
    import json

    await pool.executemany(
        "UPDATE shared_chunks SET embedding = $2::vector WHERE id = $1",
        [(UUID(cid), json.dumps(vec)) for cid, vec in pairs],
    )
    return len(pairs)


async def recompute_document_embedding_status(
    pool: asyncpg.Pool, document_id: str
) -> str:
    """Recompute the status from the chunks and store it.

    The same recomputation migration 013 runs. Deriving it rather than setting
    it from what the backfill believes it did is what keeps the column a
    measurement instead of a second opinion.
    """
    row = await pool.fetchrow(
        """SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
           FROM shared_chunks WHERE document_id = $1""",
        UUID(document_id),
    )
    status = embedding_status_for(int(row["total"]), int(row["embedded"]))
    await set_document_embedding_status(pool, document_id, status)
    return status


async def record_retrieval(
    pool: asyncpg.Pool,
    *,
    query: str,
    requester_type: str,
    requester_id: str,
    agent_owner: str | None = None,
    result_count: int,
    chunk_ids: list[str],
    duration_ms: int | None = None,
    collection_id: str | None = None,
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_retrievals
           (query, requester_type, requester_id, agent_owner, result_count, chunk_ids, duration_ms, collection_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *""",
        query,
        requester_type,
        requester_id,
        agent_owner,
        result_count,
        [UUID(cid) for cid in chunk_ids],
        duration_ms,
        UUID(collection_id) if collection_id else None,
    )
    return _serialize(dict(row))


# ---------------------------------------------------------------------------
# Stats (aggregate-only — no raw query text, no requester IDs)
# ---------------------------------------------------------------------------


async def get_shared_stats(
    pool: asyncpg.Pool,
    *,
    since: datetime | None = None,
    owner: str | None = None,
) -> dict[str, Any]:
    """Return aggregate quality/ops metrics. No PII, no raw queries.

    OWNER SCOPING, applied to the WHOLE function, closing the gap app#445
    left. app#445 scoped only usage.top_collections/top_sources — this
    docstring said so itself: "top_collections/top_sources are the ONE
    place this 'aggregate-only' file header was not actually true," which
    was wrong by omission, not by design. The other five blocks below
    (search, ingest, sources, corpus, embedding_coverage) ran unscoped
    regardless of what owner this function was called with, so a
    non-admin's /stats response carried two correctly-scoped fields next to
    five blocks of PLATFORM-WIDE totals: how many collections, sources,
    chunks and tokens exist across every OTHER user, and how much they
    searched and ingested. No row content crosses the boundary — this
    function's contract has never returned names or bodies outside
    top_collections/top_sources — but the SCALE of other users' private
    activity did, which is a real disclosure an aggregate count is not
    exempt from. owner=None (admin) is unchanged; every block below now
    uses the identical `(created_by = $N OR visibility = 'shared')`
    predicate already established for top_collections/top_sources,
    knowledge_graph and list_collections/search_chunks — applying it to the
    remaining queries, not inventing a new rule.

    shared_retrievals.collection_id is nullable (only populated since
    migration 010, and left NULL for a search whose results matched zero
    collections). A retrieval a scoped caller cannot attribute to any
    visible collection is EXCLUDED from their scoped search totals rather
    than counted anyway — "I cannot tell which collection this touched" is
    not the same claim as "you may see it," the same fail-closed reasoning
    already applied throughout this service's other owner-scoped queries.
    The unscoped (admin) count is unaffected and still counts every row.
    """
    collections_pred = "created_by = $1 OR visibility = 'shared'"
    # Sources belong to a collection; scoping them means scoping through it.
    sources_owner_where = (
        "" if owner is None
        else f"WHERE collection_id IN (SELECT id FROM shared_collections WHERE {collections_pred})"
    )
    # Chunks belong to a document, which belongs to a source, which belongs
    # to a collection — same three-hop join vector_coverage already uses.
    chunks_owner_where = (
        "" if owner is None
        else f"""WHERE document_id IN (
                    SELECT sd.id FROM shared_documents sd
                    JOIN shared_sources ss ON sd.source_id = ss.id
                    JOIN shared_collections sc ON ss.collection_id = sc.id
                    WHERE sc.{collections_pred}
                )"""
    )
    documents_owner_where = (
        "" if owner is None
        else f"""WHERE source_id IN (
                    SELECT ss.id FROM shared_sources ss
                    JOIN shared_collections sc ON ss.collection_id = sc.id
                    WHERE sc.{collections_pred}
                )"""
    )
    owner_params = () if owner is None else (owner,)

    # Search aggregates. Scoped through the collection a retrieval touched —
    # see the fail-closed NULL-collection_id note in the docstring above.
    search_owner_clause = (
        "" if owner is None
        else "AND collection_id IN (SELECT id FROM shared_collections WHERE created_by = $2 OR visibility = 'shared')"
    )
    search_row = await pool.fetchrow(
        f"""SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE result_count = 0) AS zero_result_count,
                  ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS avg_duration_ms
           FROM shared_retrievals
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)
             {search_owner_clause}""",
        *((since,) if owner is None else (since, owner)),
    )
    total = search_row["total"]
    zero_result_count = search_row["zero_result_count"]
    zero_result_rate = round(zero_result_count / total, 3) if total > 0 else 0.0

    # By requester type (aggregate counts + zero-result breakdown, no IDs).
    # Same predicate as the search block above — its twin, not a second rule.
    type_rows = await pool.fetch(
        f"""SELECT requester_type,
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE result_count = 0) AS zero_result_count
           FROM shared_retrievals
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)
             {search_owner_clause}
           GROUP BY requester_type""",
        *((since,) if owner is None else (since, owner)),
    )
    by_requester_type = []
    for r in type_rows:
        t = r["total"]
        zrc = r["zero_result_count"]
        by_requester_type.append({
            "requester_type": r["requester_type"],
            "total": t,
            "zero_result_count": zrc,
            "zero_result_rate": round(zrc / t, 3) if t > 0 else 0.0,
        })

    # Ingest aggregates. Scoped through source -> collection.
    ingest_owner_clause = (
        "" if owner is None
        else """AND source_id IN (
                    SELECT ss.id FROM shared_sources ss
                    JOIN shared_collections sc ON ss.collection_id = sc.id
                    WHERE sc.created_by = $2 OR sc.visibility = 'shared'
                )"""
    )
    ingest_row = await pool.fetchrow(
        f"""SELECT COUNT(*) AS total_jobs,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                  COUNT(*) FILTER (WHERE status = 'running') AS running,
                  COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                  ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
                        FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL))::int
                    AS avg_processing_ms
           FROM shared_ingest_jobs
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)
             {ingest_owner_clause}""",
        *((since,) if owner is None else (since, owner)),
    )
    total_jobs = ingest_row["total_jobs"]
    failed = ingest_row["failed"]
    ingest_error_rate = round(failed / total_jobs, 3) if total_jobs > 0 else 0.0

    # Source breakdown (current state, not time-scoped).
    status_rows = await pool.fetch(
        f"SELECT status, COUNT(*) AS count FROM shared_sources {sources_owner_where} GROUP BY status",
        *owner_params,
    )
    by_status = {r["status"]: r["count"] for r in status_rows}

    type_source_rows = await pool.fetch(
        f"SELECT source_type, COUNT(*) AS count FROM shared_sources {sources_owner_where} GROUP BY source_type",
        *owner_params,
    )
    by_type = {r["source_type"]: r["count"] for r in type_source_rows}

    # Embedding coverage (#210). Without this, "how much of the corpus is
    # semantically searchable" was unanswerable without a SQL prompt, so a
    # source degraded by a transient outage stayed degraded silently and
    # indefinitely. by_document_status is what the backfill works from.
    coverage_row = await pool.fetchrow(
        f"""SELECT COUNT(*) AS chunks,
                  COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded_chunks
           FROM shared_chunks
           {chunks_owner_where}""",
        *owner_params,
    )
    doc_status_rows = await pool.fetch(
        f"SELECT embedding_status, COUNT(*) AS count FROM shared_documents {documents_owner_where} GROUP BY embedding_status",
        *owner_params,
    )

    # Corpus totals (current state).
    corpus_row = await pool.fetchrow(
        f"""SELECT (SELECT COUNT(*) FROM shared_collections {"" if owner is None else f"WHERE {collections_pred}"}) AS total_collections,
                  (SELECT COUNT(*) FROM shared_sources {sources_owner_where}) AS total_sources,
                  (SELECT COUNT(*) FROM shared_chunks {chunks_owner_where}) AS total_chunks,
                  (SELECT COALESCE(SUM(token_estimate), 0) FROM shared_chunks {chunks_owner_where}) AS total_tokens""",
        *owner_params,
    )

    # Usage analytics — top collections and sources by retrieval count.
    # Same owner/visibility predicate as knowledge_graph and
    # list_collections/search_chunks: owner=None (admin) sees everything, a
    # scoped caller only sees their own or explicitly-shared collections.
    owner_clause = "" if owner is None else "AND (sc.created_by = $2 OR sc.visibility = 'shared')"
    top_collections = await pool.fetch(
        f"""SELECT sc.id, sc.name, COUNT(*) AS retrieval_count
           FROM shared_retrievals sr
           JOIN shared_collections sc ON sr.collection_id = sc.id
           WHERE ($1::timestamptz IS NULL OR sr.created_at >= $1)
             AND sr.collection_id IS NOT NULL
             {owner_clause}
           GROUP BY sc.id, sc.name
           ORDER BY retrieval_count DESC
           LIMIT 10""",
        *((since,) if owner is None else (since, owner)),
    )

    top_sources = await pool.fetch(
        f"""SELECT ss.id, ss.title, sc.name AS collection_name, COUNT(*) AS retrieval_count
           FROM shared_retrievals sr,
                LATERAL unnest(sr.chunk_ids) AS cid
           JOIN shared_chunks sch ON sch.id = cid
           JOIN shared_documents sd ON sch.document_id = sd.id
           JOIN shared_sources ss ON sd.source_id = ss.id
           JOIN shared_collections sc ON ss.collection_id = sc.id
           WHERE ($1::timestamptz IS NULL OR sr.created_at >= $1)
             {owner_clause}
           GROUP BY ss.id, ss.title, sc.name
           ORDER BY retrieval_count DESC
           LIMIT 10""",
        *((since,) if owner is None else (since, owner)),
    )

    return {
        "search": {
            "total": total,
            "zero_result_count": zero_result_count,
            "zero_result_rate": zero_result_rate,
            "avg_duration_ms": search_row["avg_duration_ms"],
            "by_requester_type": by_requester_type,
        },
        "ingest": {
            "total_jobs": total_jobs,
            "completed": ingest_row["completed"],
            "failed": failed,
            "running": ingest_row["running"],
            "pending": ingest_row["pending"],
            "error_rate": ingest_error_rate,
            "avg_processing_ms": ingest_row["avg_processing_ms"],
        },
        "sources": {
            "by_status": by_status,
            "by_type": by_type,
        },
        "corpus": {
            "total_collections": corpus_row["total_collections"],
            "total_sources": corpus_row["total_sources"],
            "total_chunks": corpus_row["total_chunks"],
            "total_tokens": corpus_row["total_tokens"],
        },
        # How much of the corpus the vector arm can actually reach (#210).
        # Reported unconditionally, including when it is complete, so its
        # absence never has to be interpreted.
        "embedding_coverage": {
            "chunks": int(coverage_row["chunks"]),
            "embedded_chunks": int(coverage_row["embedded_chunks"]),
            "complete": int(coverage_row["embedded_chunks"]) >= int(coverage_row["chunks"]),
            "by_document_status": {
                r["embedding_status"]: r["count"] for r in doc_status_rows
            },
        },
        "usage": {
            "top_collections": [
                {"id": str(r["id"]), "name": r["name"], "retrieval_count": r["retrieval_count"]}
                for r in top_collections
            ],
            "top_sources": [
                {
                    "id": str(r["id"]),
                    "title": r["title"],
                    "collection_name": r["collection_name"],
                    "retrieval_count": r["retrieval_count"],
                }
                for r in top_sources
            ],
        },
        "since": since,
    }

# app#380: the producer half of a contract with services/ui's graph renderer
# (KnowledgeGraph.tsx's TYPE_COLORS/TYPE_BASE_RADIUS). #379 added `user` here
# in one PR while a different lane's #378, merged the same night with no
# visibility into it, styled only the three types that existed when it was
# written — both renderer maps have a defensive fallback, so the new type
# rendered as a small grey dot with a raw UUID label instead of erroring. The
# fourth time in one night a producer and a consumer disagreed about a name
# and nothing caught it.
#
# GRAPH_NODE_TYPES is DECLARED, not scraped from the literals below by static
# analysis — a grep works today but breaks the moment this construction is
# refactored into a shared node-builder or the type comes from a variable.
# Declaring it is the honest answer to "can this be reliably extracted."
#
# docs/contracts/graph-node-types.json is the actual contract — both this
# constant and services/ui's styling maps are checked AGAINST that file, not
# against each other directly, since the two services share no package.
class GraphNodeType:
    COLLECTION = "collection"
    SOURCE = "source"
    AGENT = "agent"
    USER = "user"


GRAPH_NODE_TYPES: frozenset[str] = frozenset({
    GraphNodeType.COLLECTION, GraphNodeType.SOURCE, GraphNodeType.AGENT, GraphNodeType.USER,
})


async def knowledge_graph(
    pool: asyncpg.Pool, limit: int, *, owner: str | None = None
) -> dict[str, Any]:
    """Nodes, edges and totals for the shared-knowledge graph (#300, #377).

    OWNER SCOPING (cross-service sibling-drift sweep, app#445 family). Every
    OTHER route in this file's api-side twin (routes/shared-knowledge.ts)
    calls scopeToOwner before proxying — list_collections/search_chunks
    apply `created_by = $owner OR visibility = 'shared'` for a non-admin
    caller. This endpoint took no owner at all: a plain `user`-role caller
    could see every OTHER user's private collection and source names (and,
    via the retrieved-edge dangling rule below, could no longer reach
    retrieval edges into collections/sources this filter now hides).

    RETRIEVER IDENTITY (app#460, resolved). Whether showing "who searched
    what" is a leak or an intended transparency feature was left open by
    the fix above and re-raised repeatedly against this docstring. Decided:
    it is intended — the UI gives requester nodes dedicated hub styling and
    a "You" label specifically to surface team activity (#379/#380), a
    deliberately-built feature, not an accident. What was NOT intended, and
    is fixed here, is that the requester NODE (and its accumulated
    meta.retrieval_count) was built from EVERY row `retrieval_edges`
    returned, before the same visibility a scoped caller gets for every
    other node in this graph — only the EDGE was scoped, by checking
    `source_id in source_ids` after the fact. Fixed at the query itself,
    not by filtering rows in Python against `source_ids`: that set is
    bounded by THIS PAGE's LIMIT, not by visibility, so a Python-side
    filter would have hidden a requester's node just because their
    retrieved source didn't fit on the current page, conflating "invisible
    to this caller" with "on the next page" — see the retrieval_edges
    query's own comment below. A requester whose retrievals are entirely
    into collections this caller cannot see now produces no row at all and
    no node; a requester with a mix is still shown, with a count reflecting
    only what this caller could already see by other means. Agent
    knowledge_entries (the separate agent_entries query above) stay
    unscoped — this service has no owner mapping for an agent_id, agent
    identities are already visible platform-wide via GET /agents, and nesting
    scoping there is a different question with no chunk_ids/source_id
    predicate to reuse anyway.

    MOVED HERE FROM THE API, which queried `shared_collections`,
    `shared_sources` and `knowledge_entries` through its own pool — tables that
    live in THIS service's database and do not exist in that one. The endpoint
    answered 500 on every call and the page rendered "Failed to load graph".

    The bounded lists and the COUNT(*) totals came with it unchanged. Each count
    is over the same WHERE as the list it describes, and the agent figure is
    COUNT(DISTINCT agent_id) because its list is grouped — a plain COUNT(*)
    there would count entries rather than agents (#215, #188).

    #377 ADDED retrieval-derived requester -> source edges. Measured on the
    real corpus before this was written, not estimated: the `contains` edges
    alone are a FOREST — three collections with nothing connecting them, so a
    force-directed layout has no reason to place them near each other. One
    real requester's retrievals resolve (via chunk_ids -> shared_chunks ->
    shared_documents -> shared_sources) to sources in ALL THREE collections —
    a single hub node of degree 4 that merges the whole graph into one
    connected component. That is the entire justification for this addition;
    it is not a decoration.

    Deliberately NOT added, with reasons recorded so they are not re-litigated:
    chunk-level nodes (the corpus is 1 chunk per source today — a chunk node
    would duplicate its source's single edge, not add structure), duplicate
    content_hash edges (zero duplicate groups exist), and source-source
    co-occurrence within a retrieval's chunk_ids (rejected outright, not
    deferred — two sources retrieved by the same requester already connect
    two hops through that requester's node once this ships, so a direct edge
    encodes the same fact twice, and it is the one candidate with real
    quadratic-in-result-count blowup risk).
    """
    # Same predicate as list_collections/search_chunks: an admin (owner=None)
    # sees everything, a scoped caller sees their own collections plus
    # anything explicitly shared. Sources are filtered by their PARENT
    # collection's same predicate — a source cannot be visible if the
    # collection containing it is not.
    collections_where = "" if owner is None else "WHERE (created_by = $2 OR visibility = 'shared')"
    sources_where = (
        "WHERE ss.status = 'active'" if owner is None
        else "WHERE ss.status = 'active' AND (sc.created_by = $2 OR sc.visibility = 'shared')"
    )
    collections_params = (limit,) if owner is None else (limit, owner)
    sources_params = (limit,) if owner is None else (limit, owner)

    async with pool.acquire() as conn:
        collections = await conn.fetch(
            f"SELECT id, name, visibility FROM shared_collections {collections_where} ORDER BY name LIMIT $1",
            *collections_params,
        )
        sources = await conn.fetch(
            f"""SELECT ss.id, ss.title, ss.source_type, ss.collection_id,
                      (SELECT count(*) FROM shared_chunks sc
                        JOIN shared_documents sd ON sc.document_id = sd.id
                       WHERE sd.source_id = ss.id) AS chunk_count
                 FROM shared_sources ss
                 JOIN shared_collections sc ON sc.id = ss.collection_id
                {sources_where}
             ORDER BY ss.title LIMIT $1""",
            *sources_params,
        )
        agent_entries = await conn.fetch(
            """SELECT agent_id, count(*) AS entry_count, max(updated_at) AS last_updated
                 FROM knowledge_entries WHERE status = 'active'
             GROUP BY agent_id ORDER BY agent_id LIMIT $1""",
            limit,
        )
        # Resolved through chunk_ids, not the collection_id column: collection_id
        # is nullable and only populated since migration 010, while chunk_ids has
        # been written by every retrieval since the table was created — resolving
        # this way means every row contributes, not just the ones written after
        # the column existed. `CROSS JOIN LATERAL unnest(...)` is required here,
        # not an implicit comma-join with an explicit JOIN chained onto it — that
        # shape binds the JOIN to the unnest alone and either fails or silently
        # joins wrong, rather than to the (retrieval, chunk_id) pair intended.
        #
        # app#460, resolved: joined through to shared_collections and scoped
        # by the SAME predicate as collections/sources above, at the SQL
        # level rather than by filtering rows in Python against `source_ids`
        # after the fact. That distinction matters: `source_ids` is bounded
        # by THIS PAGE's LIMIT, not by visibility, so a Python-side filter
        # against it would have hidden a requester's node just because their
        # retrieved source didn't fit on the current page — conflating
        # "invisible to this caller" with "on the next page", the exact
        # confusion #215/#188 already ruled out elsewhere in this function.
        # Scoping the SOURCE ROWS here, before GROUP BY, means a requester
        # whose retrievals are entirely into invisible collections never
        # produces a row at all — their node correctly never appears — while
        # a requester with a mix of visible and invisible retrievals is
        # still shown, with a count reflecting only what this caller could
        # already see by other means.
        retrieval_scope_where = (
            "" if owner is None
            else "WHERE (sc.created_by = $2 OR sc.visibility = 'shared')"
        )
        retrieval_edges_params = (limit,) if owner is None else (limit, owner)
        retrieval_edges = await conn.fetch(
            f"""SELECT r.requester_id, r.requester_type, s.id AS source_id,
                      count(*) AS chunk_hits
                 FROM shared_retrievals r
                 CROSS JOIN LATERAL unnest(r.chunk_ids) AS cid
                 JOIN shared_chunks sc2 ON sc2.id = cid
                 JOIN shared_documents sd ON sd.id = sc2.document_id
                 JOIN shared_sources s ON s.id = sd.source_id
                 JOIN shared_collections sc ON sc.id = s.collection_id
                 {retrieval_scope_where}
             GROUP BY r.requester_id, r.requester_type, s.id
             ORDER BY r.requester_id, s.id LIMIT $1""",
            *retrieval_edges_params,
        )
        # Scoped identically to collections/sources above — an unscoped total
        # next to a scoped page would always read as "truncated" for a
        # non-admin with any hidden private data, which conflates "there is
        # more on the next page" with "there is more you cannot see". #215/
        # #188 already established that total and shown must agree on the
        # same predicate; this is that same discipline applied to the newly
        # scoped query rather than a fresh defect introduced while fixing one.
        totals_collections_where = "" if owner is None else "WHERE (created_by = $1 OR visibility = 'shared')"
        totals_sources_where = (
            "WHERE status = 'active'" if owner is None
            else "WHERE status = 'active' AND collection_id IN (SELECT id FROM shared_collections WHERE created_by = $1 OR visibility = 'shared')"
        )
        # Same predicate, same reason, as retrieval_edges above — joined
        # through to shared_collections rather than filtered against a
        # bounded page's source_ids. Missing until h#603's review: this
        # count was the one total in the block still counting every
        # requester in shared_retrievals unconditionally, three lines below
        # its two scoped siblings, in the PR whose purpose is closing this
        # exact class of leak.
        totals_requesters_where = (
            "" if owner is None
            else "WHERE (sc.created_by = $1 OR sc.visibility = 'shared')"
        )
        totals = await conn.fetchrow(
            f"""SELECT
                 (SELECT count(*) FROM shared_collections {totals_collections_where}) AS collections,
                 (SELECT count(*) FROM shared_sources {totals_sources_where}) AS sources,
                 (SELECT count(DISTINCT agent_id) FROM knowledge_entries WHERE status = 'active')
                   AS agents_with_knowledge,
                 (SELECT count(DISTINCT r.requester_id)
                    FROM shared_retrievals r
                    CROSS JOIN LATERAL unnest(r.chunk_ids) AS cid
                    JOIN shared_chunks sc2 ON sc2.id = cid
                    JOIN shared_documents sd ON sd.id = sc2.document_id
                    JOIN shared_sources s ON s.id = sd.source_id
                    JOIN shared_collections sc ON sc.id = s.collection_id
                    {totals_requesters_where})
                   AS requesters_with_retrievals""",
            *(() if owner is None else (owner,)),
        )

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    collection_ids = set()
    for c in collections:
        collection_ids.add(str(c["id"]))
        nodes.append({
            "id": f"col-{c['id']}", "type": GraphNodeType.COLLECTION, "label": c["name"],
            "meta": {"visibility": c["visibility"]},
        })

    # An edge is emitted only when its collection node is present. Truncating
    # the collections but not the sources would otherwise point edges at nodes
    # that do not exist, which is worse than a smaller graph: a renderer either
    # drops them silently or lays out around a phantom.
    dangling_edges = 0
    source_ids = set()
    for s in sources:
        source_ids.add(str(s["id"]))
        nodes.append({
            "id": f"src-{s['id']}", "type": GraphNodeType.SOURCE, "label": s["title"],
            "meta": {"source_type": s["source_type"], "chunk_count": int(s["chunk_count"])},
        })
        if str(s["collection_id"]) in collection_ids:
            edges.append({"source": f"col-{s['collection_id']}", "target": f"src-{s['id']}", "label": "contains"})
        else:
            dangling_edges += 1

    # A dict, not a list-append, because a requester can appear in this
    # service's `agent_entries` (knowledge_entries-derived) AND in the
    # retrieval-derived rows below under the identical id (`agent-{agent_id}`)
    # — those must merge into one node, not produce two nodes sharing an id.
    agent_or_user_nodes: dict[str, dict[str, Any]] = {}
    for a in agent_entries:
        node_id = f"agent-{a['agent_id']}"
        agent_or_user_nodes[node_id] = {
            "id": node_id, "type": GraphNodeType.AGENT, "label": a["agent_id"],
            "meta": {"entry_count": int(a["entry_count"])},
        }

    # requester_type is 'agent' or 'user' (the column's own CHECK constraint) —
    # 'agent' reuses the id scheme above so it merges with any knowledge_entries
    # node for the same agent_id; 'user' is a genuinely new, self-describing
    # node type so the legend can tell human search activity from agent
    # activity apart, rather than lumping them under "agent".
    # app#460, resolved. The requester ROWS returned by the retrieval_edges
    # query below are now pre-scoped at the SQL level (same predicate as
    # collections/sources, joined through to shared_collections) — a row
    # for a source this caller cannot see never reaches this loop at all.
    # Deliberately NOT filtered again here against `source_ids`: that set
    # is bounded by THIS PAGE's LIMIT, not by visibility, and conflating
    # the two would hide a requester's node just because their retrieved
    # source didn't fit on this page — the same page-truncation case the
    # source-node loop above already handles the OPPOSITE way (the node
    # stays; only the edge to a truncated collection is dropped). See the
    # query's own comment for why the visibility scoping had to move
    # there instead of being reproduced as a second filter here.
    requesters_shown: set[str] = set()
    for r in retrieval_edges:
        requester_id = r["requester_id"]
        requesters_shown.add(requester_id)
        node_type = GraphNodeType.AGENT if r["requester_type"] == "agent" else GraphNodeType.USER
        node_id = f"{node_type}-{requester_id}"
        # setdefault does not help meta specifically: a requester_type='agent'
        # row can hit an EXISTING node already inserted by the agent_entries
        # loop above, whose meta has entry_count but no retrieval_count yet —
        # so the increment itself must tolerate the key being absent.
        node = agent_or_user_nodes.setdefault(node_id, {
            "id": node_id, "type": node_type, "label": requester_id, "meta": {},
        })
        node["meta"]["retrieval_count"] = node["meta"].get("retrieval_count", 0) + int(r["chunk_hits"])

        if str(r["source_id"]) in source_ids:
            edges.append({
                "source": node_id, "target": f"src-{r['source_id']}", "label": "retrieved",
                "meta": {"retrieval_count": int(r["chunk_hits"])},
            })
        else:
            dangling_edges += 1

    nodes.extend(agent_or_user_nodes.values())

    total = {
        "collections": int(totals["collections"]),
        "sources": int(totals["sources"]),
        "agents_with_knowledge": int(totals["agents_with_knowledge"]),
        "requesters_with_retrievals": int(totals["requesters_with_retrievals"]),
    }
    shown = {
        "collections": len(collections),
        "sources": len(sources),
        "agents_with_knowledge": len(agent_entries),
        # Distinct requesters actually represented on this page, not the row
        # count of retrieval_edges — the same #215/#188 discipline as
        # agents_with_knowledge above: a requester can produce several edge
        # rows (one per source), and counting rows here would let `shown`
        # exceed `total` rather than agree with it when the page is complete.
        "requesters_with_retrievals": len(requesters_shown),
    }
    return {
        "nodes": nodes,
        "edges": edges,
        "total": total,
        "shown": shown,
        "dangling_edges": dangling_edges,
        "truncated": any(shown[k] < total[k] for k in total),
    }
