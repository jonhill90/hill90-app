"""Integration tests for GET /internal/admin/shared/graph.

No integration coverage of this route existed before this file — the graph
endpoint's assembly logic is pinned against a stubbed pool in
tests/test_shared_graph.py, but nothing here proved the owner-scoping
predicate actually filters rows against a real Postgres. This file covers
that gap for the fix in this same change (cross-service sibling-drift sweep,
app#445 family): /graph never called scopeToOwner on the api side and took
no owner at all here, unlike every other route in this file's api-side twin
(routes/shared-knowledge.ts).
"""

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
INTERNAL_HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


async def _create_collection(app_client, name, owner, visibility="shared"):
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=INTERNAL_HEADERS,
        json={"name": name, "created_by": owner, "visibility": visibility},
    )
    assert resp.status_code == 200, f"collection create failed: {resp.text}"
    return resp.json()["id"]


async def _ingest_source(app_client, collection_id, title, content, owner):
    resp = await app_client.post(
        "/internal/admin/shared/sources",
        headers=INTERNAL_HEADERS,
        json={
            "collection_id": collection_id,
            "title": title,
            "source_type": "text",
            "raw_content": content,
            "created_by": owner,
        },
    )
    assert resp.status_code == 200, f"ingest failed: {resp.text}"
    return resp.json()


class TestSharedGraphOwnerScoping:
    async def test_graph_requires_auth(self, app_client):
        resp = await app_client.get("/internal/admin/shared/graph")
        assert resp.status_code == 401

    async def test_admin_unscoped_sees_all_private_collections(self, app_client):
        await _create_collection(app_client, "Graph Owner A Private", "graph-owner-a", visibility="private")
        await _create_collection(app_client, "Graph Owner B Private", "graph-owner-b", visibility="private")

        resp = await app_client.get("/internal/admin/shared/graph", headers=INTERNAL_HEADERS)
        assert resp.status_code == 200
        names = {n["label"] for n in resp.json()["nodes"] if n["type"] == "collection"}
        assert {"Graph Owner A Private", "Graph Owner B Private"} <= names

    async def test_owner_scoped_caller_cannot_see_another_owners_private_collection_or_source(self, app_client):
        cid_a = await _create_collection(app_client, "Graph Scoped A Private", "graph-scoped-a", visibility="private")
        await _ingest_source(
            app_client, cid_a, "Graph Scoped A Doc",
            "Content only owner A should see in the graph.",
            "graph-scoped-a",
        )
        await _create_collection(app_client, "Graph Scoped B Private", "graph-scoped-b", visibility="private")
        await _ingest_source(
            app_client,
            await _create_collection(app_client, "Graph Scoped B Private 2", "graph-scoped-b", visibility="private"),
            "Graph Scoped B Doc",
            "Content only owner B should see in the graph.",
            "graph-scoped-b",
        )

        resp = await app_client.get(
            "/internal/admin/shared/graph",
            headers=INTERNAL_HEADERS,
            params={"owner": "graph-scoped-a"},
        )
        assert resp.status_code == 200
        data = resp.json()
        collection_labels = {n["label"] for n in data["nodes"] if n["type"] == "collection"}
        source_labels = {n["label"] for n in data["nodes"] if n["type"] == "source"}

        assert "Graph Scoped A Private" in collection_labels
        assert "Graph Scoped B Private" not in collection_labels
        assert "Graph Scoped B Private 2" not in collection_labels
        assert "Graph Scoped A Doc" in source_labels
        assert "Graph Scoped B Doc" not in source_labels

    async def test_a_shared_collection_is_visible_to_a_scoped_caller_who_does_not_own_it(self, app_client):
        await _create_collection(app_client, "Graph Explicitly Shared", "graph-scoped-owner", visibility="shared")

        resp = await app_client.get(
            "/internal/admin/shared/graph",
            headers=INTERNAL_HEADERS,
            params={"owner": "someone-else-entirely"},
        )
        assert resp.status_code == 200
        collection_labels = {n["label"] for n in resp.json()["nodes"] if n["type"] == "collection"}
        assert "Graph Explicitly Shared" in collection_labels
