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


# The agent fixture's JWT carries owner="test-user-sub". A collection owned by
# anyone else is invisible to it, and a coverage figure scoped to that agent
# would correctly read zero — which is right behaviour and a useless fixture.
AGENT_OWNER = "test-user-sub"


async def _collection(client: AsyncClient, name: str, owner: str = AGENT_OWNER) -> str:
    resp = await client.post(
        "/internal/admin/shared/collections",
        headers=HEADERS,
        json={"name": name, "description": "", "visibility": "private",
              "created_by": owner},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


async def _ingest(client: AsyncClient, collection_id: str, title: str):
    return await client.post(
        "/internal/admin/shared/sources",
        headers=HEADERS,
        json={"collection_id": collection_id, "title": title,
              "source_type": "text", "raw_content": CONTENT,
              "created_by": AGENT_OWNER},
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

        async def half(texts, **_kwargs):
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

        async def all_of_them(texts, **_kwargs):
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
            params={"q": "Paragraph", "requester_id": AGENT_OWNER},
            headers=HEADERS,
        )
        assert found.status_code == 200
        assert found.json()["count"] > 0


@pytest.mark.asyncio
class TestSearchReportsCorpusCoverage:
    """`search_type: hybrid` is a claim about the QUERY, not the CORPUS.

    A caller reads it as the latter. These assert that the response now
    separates the two claims, so "hybrid ran" can never be mistaken for
    "everything was semantically searchable".
    """

    async def test_hybrid_does_not_imply_a_fully_embedded_corpus(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        cid = await _collection(app_client, "coverage")

        # Ingested during an outage: chunks exist, vectors do not.
        with patch("app.services.embeddings.generate_embeddings", return_value=None):
            assert (await _ingest(app_client, cid, "Unembedded")).status_code == 200

        # The QUERY embeds fine — this is exactly the misleading case.
        async def one_vector(_q, **_kwargs):
            return [0.03] * 1536

        with patch("app.services.embeddings.generate_embedding", side_effect=one_vector):
            resp = await app_client.get(
                "/api/v1/shared/search",
                params={"q": "Paragraph"},
                headers={"Authorization": f"Bearer {agent_token}"},
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()

        # The query embedded, so the search ran hybrid…
        assert body["search_type"] == "hybrid"
        # …and the response says plainly that the corpus did not.
        assert body["vector_coverage"]["complete"] is False
        assert body["vector_coverage"]["embedded_chunks"] == 0
        assert body["vector_coverage"]["chunks"] > 0
        # The two numbers disagree, which is the whole signal.
        assert (
            body["vector_coverage"]["embedded_chunks"]
            != body["vector_coverage"]["chunks"]
        )

    async def test_coverage_is_reported_even_when_complete(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        """Absence must never need interpreting.

        If the field only appeared when coverage was incomplete, a caller
        seeing nothing could not distinguish an older build from a healthy
        corpus — the same ambiguity that made an absent X-Total-Count hard to
        reason about one hop at a time.
        """
        cid = await _collection(app_client, "complete")

        async def all_of_them(texts, **_kwargs):
            return [[0.04] * 1536 for _ in texts]

        with patch("app.services.embeddings.generate_embeddings", side_effect=all_of_them):
            assert (await _ingest(app_client, cid, "Embedded")).status_code == 200

        async def one_vector(_q, **_kwargs):
            return [0.04] * 1536

        with patch("app.services.embeddings.generate_embedding", side_effect=one_vector):
            resp = await app_client.get(
                "/api/v1/shared/search",
                params={"q": "Paragraph"},
                headers={"Authorization": f"Bearer {agent_token}"},
            )

        assert resp.status_code == 200
        cov = resp.json()["vector_coverage"]
        assert cov["complete"] is True
        assert cov["embedded_chunks"] == cov["chunks"] > 0

    async def test_coverage_is_scoped_like_the_search_that_reports_it(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        """A coverage figure over the wrong scope leaks another owner's size.

        Same failure as a COUNT whose WHERE drifts from its page's.
        """
        mine = await _collection(app_client, "mine")

        # Another owner's PRIVATE collection, which this agent cannot see.
        other = await app_client.post(
            "/internal/admin/shared/collections",
            headers=HEADERS,
            json={"name": "theirs", "description": "", "visibility": "private",
                  "created_by": "someone-else"},
        )
        assert other.status_code == 200

        async def all_of_them(texts, **_kwargs):
            return [[0.05] * 1536 for _ in texts]

        with patch("app.services.embeddings.generate_embeddings", side_effect=all_of_them):
            assert (await _ingest(app_client, mine, "Mine")).status_code == 200
            assert (
                await _ingest(app_client, other.json()["id"], "Theirs")
            ).status_code == 200

        async def one_vector(_q, **_kwargs):
            return [0.05] * 1536

        with patch("app.services.embeddings.generate_embedding", side_effect=one_vector):
            resp = await app_client.get(
                "/api/v1/shared/search",
                params={"q": "Paragraph"},
                headers={"Authorization": f"Bearer {agent_token}"},
            )

        assert resp.status_code == 200
        cov = resp.json()["vector_coverage"]

        # Only this owner's chunks are counted. Both collections were ingested
        # with identical content, so an unscoped count would be exactly double.
        mine_only = await app_client.get(
            "/internal/admin/shared/sources",
            params={"collection_id": mine},
            headers=HEADERS,
        )
        assert mine_only.status_code == 200
        assert cov["chunks"] > 0
        assert cov["complete"] is True


@pytest.mark.asyncio
class TestBackfillConverges:
    """The recovery half. Report is worthless if the gap can never close."""

    async def test_backfill_repairs_a_document_ingested_during_an_outage(
        self, app_client: AsyncClient
    ) -> None:
        cid = await _collection(app_client, "repairable")

        with patch("app.services.embeddings.generate_embeddings", return_value=None):
            resp = await _ingest(app_client, cid, "Degraded")
        assert resp.json()["document"]["embedding_status"] == "pending"

        async def all_of_them(texts, **_kwargs):
            return [[0.06] * 1536 for _ in texts]

        with patch("app.services.embeddings.generate_embeddings", side_effect=all_of_them):
            run = await app_client.post(
                "/internal/admin/shared/embeddings/backfill", headers=HEADERS
            )

        assert run.status_code == 200, run.text
        body = run.json()
        assert body["documents_repaired"] == 1
        assert body["chunks_embedded"] > 0

        stats = await app_client.get("/internal/admin/shared/stats", headers=HEADERS)
        cov = stats.json()["embedding_coverage"]
        assert cov["complete"] is True
        assert cov["by_document_status"].get("embedded", 0) >= 1

    async def test_a_still_failing_embedder_leaves_the_status_honest(
        self, app_client: AsyncClient
    ) -> None:
        """A backfill that cannot fix it must not mark it fixed."""
        cid = await _collection(app_client, "still-down")

        with patch("app.services.embeddings.generate_embeddings", return_value=None):
            assert (await _ingest(app_client, cid, "Still degraded")).status_code == 200

            run = await app_client.post(
                "/internal/admin/shared/embeddings/backfill", headers=HEADERS
            )

        assert run.status_code == 200
        assert run.json()["documents_repaired"] == 0
        assert run.json()["documents_still_incomplete"] == 1

        stats = await app_client.get("/internal/admin/shared/stats", headers=HEADERS)
        assert stats.json()["embedding_coverage"]["complete"] is False

    async def test_a_partial_backfill_applies_what_it_got(
        self, app_client: AsyncClient
    ) -> None:
        """Same correction as create_chunks: a short answer is a prefix, not a
        failure. Discarding it would leave the corpus no better and the log no
        clearer."""
        cid = await _collection(app_client, "partial-repair")

        with patch("app.services.embeddings.generate_embeddings", return_value=None):
            ing = await _ingest(app_client, cid, "Partly repairable")
        total_chunks = ing.json()["document"]["chunk_count"]
        assert total_chunks > 2

        async def only_two(texts, **_kwargs):
            return [[0.07] * 1536 for _ in texts[:2]]

        with patch("app.services.embeddings.generate_embeddings", side_effect=only_two):
            run = await app_client.post(
                "/internal/admin/shared/embeddings/backfill", headers=HEADERS
            )

        assert run.status_code == 200
        assert run.json()["chunks_embedded"] == 2
        assert run.json()["documents_still_incomplete"] == 1

        stats = await app_client.get("/internal/admin/shared/stats", headers=HEADERS)
        cov = stats.json()["embedding_coverage"]
        # Progress recorded, completeness not claimed.
        assert cov["embedded_chunks"] == 2
        assert cov["complete"] is False
        assert cov["by_document_status"].get("partial", 0) == 1

    async def test_stats_report_coverage_even_when_complete(
        self, app_client: AsyncClient
    ) -> None:
        cid = await _collection(app_client, "healthy-stats")

        async def all_of_them(texts, **_kwargs):
            return [[0.08] * 1536 for _ in texts]

        with patch("app.services.embeddings.generate_embeddings", side_effect=all_of_them):
            assert (await _ingest(app_client, cid, "Fine")).status_code == 200

        stats = await app_client.get("/internal/admin/shared/stats", headers=HEADERS)
        cov = stats.json()["embedding_coverage"]
        assert cov["complete"] is True
        assert cov["chunks"] == cov["embedded_chunks"] > 0
