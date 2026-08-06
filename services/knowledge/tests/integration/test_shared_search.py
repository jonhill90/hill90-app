"""Integration tests for shared knowledge FTS search."""

from unittest.mock import patch

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


async def _setup_collection(app_client, name, owner, visibility="private"):
    """Helper to create a collection. Returns the collection ID."""
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=HEADERS,
        json={"name": name, "created_by": owner, "visibility": visibility},
    )
    assert resp.status_code == 200, f"collection create failed: {resp.text}"
    cid = resp.json()["id"]
    return cid


async def _ingest_source(app_client, collection_id, title, content, owner):
    resp = await app_client.post(
        "/internal/admin/shared/sources",
        headers=HEADERS,
        json={
            "collection_id": collection_id,
            "title": title,
            "source_type": "text",
            "raw_content": content,
            "created_by": owner,
        },
    )
    assert resp.status_code == 200
    return resp.json()


class TestFtsSearchRanked:
    async def test_fts_search_ranked(self, app_client):
        cid = await _setup_collection(app_client, "Search Ranked Col", "user-search", "shared")

        await _ingest_source(
            app_client, cid, "FastAPI Guide",
            "A comprehensive guide to FastAPI web framework and API design.",
            "user-search",
        )
        await _ingest_source(
            app_client, cid, "Python Basics",
            "Introduction to Python programming language fundamentals.",
            "user-search",
        )

        resp = await app_client.get(
            "/internal/admin/shared/search",
            headers=HEADERS,
            params={"q": "FastAPI", "requester_id": "user-search"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1
        assert data["search_type"] == "fts"
        # FastAPI results should be present
        contents = [r["content"] for r in data["results"]]
        assert any("FastAPI" in c for c in contents)


class TestFtsSearchVisibilityScoped:
    async def test_fts_search_visibility_scoped(self, app_client):
        # Private collection owned by user-priv
        priv_cid = await _setup_collection(
            app_client, "Private Search Col", "user-priv", "private"
        )
        await _ingest_source(
            app_client, priv_cid, "Secret Doc",
            "This document contains classified information about unicorns.",
            "user-priv",
        )

        # Search as a different user should NOT find it
        resp = await app_client.get(
            "/internal/admin/shared/search",
            headers=HEADERS,
            params={"q": "unicorns", "owner": "user-other", "requester_id": "user-other"},
        )
        assert resp.status_code == 200
        assert resp.json()["count"] == 0

        # Search as owner should find it
        resp2 = await app_client.get(
            "/internal/admin/shared/search",
            headers=HEADERS,
            params={"q": "unicorns", "owner": "user-priv", "requester_id": "user-priv"},
        )
        assert resp2.status_code == 200
        assert resp2.json()["count"] >= 1


class TestSearchReturnsProvenance:
    async def test_search_returns_provenance(self, app_client):
        cid = await _setup_collection(
            app_client, "Provenance Col", "user-prov", "shared"
        )
        await _ingest_source(
            app_client, cid, "Provenance Source",
            "Specific content about quantum computing for provenance test.",
            "user-prov",
        )

        resp = await app_client.get(
            "/internal/admin/shared/search",
            headers=HEADERS,
            params={"q": "quantum computing", "requester_id": "user-prov"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1

        result = data["results"][0]
        # Verify provenance fields
        assert "chunk_id" in result
        assert "source_id" in result
        assert "source_title" in result
        assert "document_id" in result
        assert "document_title" in result
        assert "collection_id" in result
        assert "collection_name" in result
        assert "chunk_index" in result
        assert "score" in result
        assert "headline" in result


class TestAdminSearchScoreTypeMatchesSearchType:
    """The knowledge sweep's retrieval pass (app#442 family): a caller reading
    score_type learns how to interpret the `score` field on each result — a
    raw ts_rank is not on the same scale as a blended hybrid score, and the
    twin agent-facing route (routes/shared.py) already derives score_type
    from search_type: `"hybrid" if search_type == "hybrid" else "ts_rank"`.

    This admin route hardcoded `"score_type": "ts_rank"` unconditionally,
    even when search_type == "hybrid" and every result's `score` field is
    actually the blended fts/vector score computed in
    hybrid_search_chunks — not a ts_rank at all. A caller trusting
    score_type to interpret score would misread the number's meaning and
    scale on every hybrid admin search, exactly the twin-drift shape #234's
    own rule exists to catch.
    """

    async def test_score_type_reflects_hybrid_when_search_type_is_hybrid(
        self, app_client
    ):
        cid = await _setup_collection(
            app_client, "Score Type Col", "user-score-type", "shared"
        )
        await _ingest_source(
            app_client, cid, "Score Type Source",
            "Specific content about distributed systems for score type test.",
            "user-score-type",
        )

        async def one_vector(_q, **_kwargs):
            return [0.05] * 1536

        with patch("app.services.embeddings.generate_embedding", side_effect=one_vector):
            resp = await app_client.get(
                "/internal/admin/shared/search",
                headers=HEADERS,
                params={"q": "distributed systems", "requester_id": "user-score-type"},
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["search_type"] == "hybrid", (
            "test setup did not actually exercise the hybrid path"
        )
        assert data["score_type"] == "hybrid", (
            f"search_type is 'hybrid' but score_type reported "
            f"{data['score_type']!r} — a caller cannot tell the score field "
            f"is a blended hybrid score, not a raw ts_rank"
        )

    async def test_score_type_is_ts_rank_for_a_genuine_fts_only_search(self, app_client):
        # POSITIVE CONTROL — a fix that hardcoded score_type="hybrid" would
        # also pass the test above for the wrong reason.
        cid = await _setup_collection(
            app_client, "FTS Only Score Type Col", "user-fts-score-type", "shared"
        )
        await _ingest_source(
            app_client, cid, "FTS Only Source",
            "Specific content about relational databases for fts only test.",
            "user-fts-score-type",
        )

        with patch("app.services.embeddings.generate_embedding", return_value=None):
            resp = await app_client.get(
                "/internal/admin/shared/search",
                headers=HEADERS,
                params={"q": "relational databases", "requester_id": "user-fts-score-type"},
            )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["search_type"] == "fts"
        assert data["score_type"] == "ts_rank"
