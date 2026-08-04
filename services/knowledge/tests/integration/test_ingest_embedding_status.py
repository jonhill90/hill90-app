"""A half-completed ingest must not report as done (#210).

Embedding is best-effort inside `ingest_source`: `generate_embeddings` returns
None on every failure mode — AI service unreachable, non-200, timeout, no
credentials — and only logs a warning. The job was then marked 'completed', the
source 'active', and the response carried `chunk_count: N` with nothing
distinguishing a fully-embedded source from one with zero embeddings.

`chunk_count` was TRUE. The implication that those chunks are searchable the
way every other source is was FALSE — `vector_search_chunks` filters
`embedding IS NOT NULL`, so they carry vec_score 0.0 forever and can never be
found by a paraphrase.

The controls below therefore never assert on chunk_count alone: each one makes
the reported state DISAGREE with what a chunk-count-only implementation would
say. An ingest with 3 chunks and 0 vectors must not look like an ingest with 3
chunks and 3 vectors.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

HEADERS = {"Authorization": "Bearer test-internal-token"}

# The chunker targets 500 tokens per chunk, so the fixture has to be big
# enough to produce SEVERAL — a single-chunk fixture cannot express "partial"
# at all, and would have let the partial-embedding bug pass unnoticed.
_PARA = " ".join(f"word{i}" for i in range(220))
CONTENT = "\n\n".join(f"Paragraph {p}. {_PARA}" for p in range(8))


async def _collection(client: AsyncClient, name: str) -> str:
    resp = await client.post(
        "/internal/admin/shared/collections",
        headers=HEADERS,
        json={"name": name, "description": "", "visibility": "private",
              "created_by": "user-a"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


async def _ingest(client: AsyncClient, collection_id: str, title: str):
    return await client.post(
        "/internal/admin/shared/sources",
        headers=HEADERS,
        json={"collection_id": collection_id, "title": title,
              "source_type": "text", "raw_content": CONTENT,
              "created_by": "user-a"},
    )


@pytest.mark.asyncio
class TestIngestReportsEmbeddingState:
    async def test_embedding_failure_is_reported_not_hidden(
        self, app_client: AsyncClient
    ) -> None:
        """The exact scenario: embedder returns None, ingest still succeeds."""
        cid = await _collection(app_client, "outage")

        with patch("app.services.embeddings.generate_embeddings", return_value=None):
            resp = await _ingest(app_client, cid, "During an outage")

        assert resp.status_code == 200, resp.text
        body = resp.json()

        # Still ingested — keyword-searchable content is worth keeping, and a
        # transient outage must not discard good work.
        assert body["ingest_job"]["status"] == "completed"
        assert body["document"]["chunk_count"] > 0

        # …but the response SAYS the chunks are not embedded. This is the
        # assertion the old implementation could not satisfy at all: there was
        # no field to carry it.
        assert body["document"]["embedding_status"] == "pending"
        assert body["document"]["embedded_chunk_count"] == 0
        # The two numbers disagree, which is the whole point.
        assert body["document"]["embedded_chunk_count"] != body["document"]["chunk_count"]

    async def test_partial_embeddings_are_KEPT_and_reported_as_partial(
        self, app_client: AsyncClient
    ) -> None:
        """A short response must not discard the vectors that did arrive.

        `if embeddings and len(embeddings) == len(chunks)` treated "30 vectors
        for 42 chunks" identically to "nothing came back" and threw all 30
        away. The next person debugging a coverage gap would have gone looking
        for a total outage that never happened.
        """
        cid = await _collection(app_client, "partial")

        async def half(texts):
            # Answer for the first two chunks only.
            return [[0.01] * 1536 for _ in texts[:2]]

        with patch("app.services.embeddings.generate_embeddings", side_effect=half):
            resp = await _ingest(app_client, cid, "Half embedded")

        assert resp.status_code == 200, resp.text
        doc = resp.json()["document"]

        assert doc["embedding_status"] == "partial"
        assert doc["embedded_chunk_count"] == 2
        assert doc["chunk_count"] > 2
        # Not discarded: the old code would have reported 0 here.
        assert doc["embedded_chunk_count"] > 0

    async def test_full_embeddings_report_embedded(self, app_client: AsyncClient) -> None:
        cid = await _collection(app_client, "healthy")

        async def all_of_them(texts):
            return [[0.02] * 1536 for _ in texts]

        with patch("app.services.embeddings.generate_embeddings", side_effect=all_of_them):
            resp = await _ingest(app_client, cid, "Fully embedded")

        assert resp.status_code == 200, resp.text
        doc = resp.json()["document"]
        assert doc["embedding_status"] == "embedded"
        assert doc["embedded_chunk_count"] == doc["chunk_count"]

    async def test_partial_chunks_remain_findable_by_keyword(
        self, app_client: AsyncClient
    ) -> None:
        """The cost is precise: not invisibility, but no paraphrase match.

        Hybrid search always runs its FTS arm, so an un-embedded chunk is still
        surfaced by literal overlap. Asserting this keeps the fix honest — if a
        later change made un-embedded content unreachable entirely, that would
        be a REGRESSION, not extra safety.
        """
        cid = await _collection(app_client, "keyword")

        with patch("app.services.embeddings.generate_embeddings", return_value=None):
            resp = await _ingest(app_client, cid, "Findable")
        assert resp.status_code == 200

        found = await app_client.get(
            "/internal/admin/shared/search",
            params={"q": "Paragraph", "requester_id": "user-a"},
            headers=HEADERS,
        )
        assert found.status_code == 200
        assert found.json()["count"] > 0
