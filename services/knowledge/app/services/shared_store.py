"""Database operations for the Shared Knowledge Base.

Collections, sources, ingest jobs, documents, chunks, and retrieval audit.
Follows patterns established in knowledge_store.py.
"""

from __future__ import annotations

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


async def list_sources(
    pool: asyncpg.Pool, collection_id: str
) -> list[dict[str, Any]]:
    rows = await pool.fetch(
        """SELECT id, collection_id, title, source_type, source_url,
                  content_hash, status, error_message, created_by, created_at, updated_at
           FROM shared_sources
           WHERE collection_id = $1
           ORDER BY created_at DESC""",
        UUID(collection_id),
    )
    return [_serialize(dict(r)) for r in rows]


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

    Falls back gracefully if embedding column doesn't exist or has no data.
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

    try:
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
    except Exception as exc:
        logger.warning("Vector search failed (falling back to FTS): %s", exc)
        return []


async def hybrid_search_chunks(
    pool: asyncpg.Pool,
    query: str,
    query_embedding: list[float] | None = None,
    *,
    owner: str | None = None,
    collection_id: str | None = None,
    limit: int = 20,
    vector_weight: float = 0.6,
) -> list[dict[str, Any]]:
    """Hybrid search combining FTS keyword matching and vector similarity.

    If no embedding is provided, falls back to FTS-only.
    Deduplicates results and blends scores with configurable weighting.
    """
    # Always run FTS
    fts_results = await search_chunks(
        pool, query, owner=owner, collection_id=collection_id, limit=limit
    )

    if not query_embedding:
        return fts_results

    # Run vector search
    vec_results = await vector_search_chunks(
        pool, query_embedding, owner=owner, collection_id=collection_id, limit=limit
    )

    if not vec_results:
        return fts_results

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
    return results


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
) -> dict[str, Any]:
    """Return aggregate quality/ops metrics. No PII, no raw queries."""

    # Search aggregates
    search_row = await pool.fetchrow(
        """SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE result_count = 0) AS zero_result_count,
                  ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS avg_duration_ms
           FROM shared_retrievals
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)""",
        since,
    )
    total = search_row["total"]
    zero_result_count = search_row["zero_result_count"]
    zero_result_rate = round(zero_result_count / total, 3) if total > 0 else 0.0

    # By requester type (aggregate counts + zero-result breakdown, no IDs)
    type_rows = await pool.fetch(
        """SELECT requester_type,
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE result_count = 0) AS zero_result_count
           FROM shared_retrievals
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)
           GROUP BY requester_type""",
        since,
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

    # Ingest aggregates
    ingest_row = await pool.fetchrow(
        """SELECT COUNT(*) AS total_jobs,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                  COUNT(*) FILTER (WHERE status = 'running') AS running,
                  COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                  ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
                        FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL))::int
                    AS avg_processing_ms
           FROM shared_ingest_jobs
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)""",
        since,
    )
    total_jobs = ingest_row["total_jobs"]
    failed = ingest_row["failed"]
    ingest_error_rate = round(failed / total_jobs, 3) if total_jobs > 0 else 0.0

    # Source breakdown (current state, not time-scoped)
    status_rows = await pool.fetch(
        "SELECT status, COUNT(*) AS count FROM shared_sources GROUP BY status"
    )
    by_status = {r["status"]: r["count"] for r in status_rows}

    type_source_rows = await pool.fetch(
        "SELECT source_type, COUNT(*) AS count FROM shared_sources GROUP BY source_type"
    )
    by_type = {r["source_type"]: r["count"] for r in type_source_rows}

    # Embedding coverage (#210). Without this, "how much of the corpus is
    # semantically searchable" was unanswerable without a SQL prompt, so a
    # source degraded by a transient outage stayed degraded silently and
    # indefinitely. by_document_status is what the backfill works from.
    coverage_row = await pool.fetchrow(
        """SELECT COUNT(*) AS chunks,
                  COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded_chunks
           FROM shared_chunks"""
    )
    doc_status_rows = await pool.fetch(
        "SELECT embedding_status, COUNT(*) AS count FROM shared_documents GROUP BY embedding_status"
    )

    # Corpus totals (current state)
    corpus_row = await pool.fetchrow(
        """SELECT (SELECT COUNT(*) FROM shared_collections) AS total_collections,
                  (SELECT COUNT(*) FROM shared_sources) AS total_sources,
                  (SELECT COUNT(*) FROM shared_chunks) AS total_chunks,
                  (SELECT COALESCE(SUM(token_estimate), 0) FROM shared_chunks) AS total_tokens"""
    )

    # Usage analytics — top collections and sources by retrieval count
    top_collections = await pool.fetch(
        """SELECT sc.id, sc.name, COUNT(*) AS retrieval_count
           FROM shared_retrievals sr
           JOIN shared_collections sc ON sr.collection_id = sc.id
           WHERE ($1::timestamptz IS NULL OR sr.created_at >= $1)
             AND sr.collection_id IS NOT NULL
           GROUP BY sc.id, sc.name
           ORDER BY retrieval_count DESC
           LIMIT 10""",
        since,
    )

    top_sources = await pool.fetch(
        """SELECT ss.id, ss.title, sc.name AS collection_name, COUNT(*) AS retrieval_count
           FROM shared_retrievals sr,
                LATERAL unnest(sr.chunk_ids) AS cid
           JOIN shared_chunks sch ON sch.id = cid
           JOIN shared_documents sd ON sch.document_id = sd.id
           JOIN shared_sources ss ON sd.source_id = ss.id
           JOIN shared_collections sc ON ss.collection_id = sc.id
           WHERE ($1::timestamptz IS NULL OR sr.created_at >= $1)
           GROUP BY ss.id, ss.title, sc.name
           ORDER BY retrieval_count DESC
           LIMIT 10""",
        since,
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
