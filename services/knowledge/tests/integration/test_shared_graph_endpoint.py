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


async def _admin_search(app_client, q, requester_id, collection_id=None):
    params = {"q": q, "requester_id": requester_id}
    if collection_id:
        params["collection_id"] = collection_id
    resp = await app_client.get(
        "/internal/admin/shared/search",
        headers=INTERNAL_HEADERS,
        params=params,
    )
    assert resp.status_code == 200, f"search failed: {resp.text}"
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

    # app#460, resolved: a requester's NODE (and its retrieval_count) used
    # to be built from every retrieval_edges row unconditionally — only the
    # EDGE was owner-scoped. A caller who could not see a collection at all
    # could still see a real person's identity and a real retrieval count
    # for activity into it. Proved end-to-end against a real Postgres, not
    # just the stubbed-pool assembly logic in tests/test_shared_graph.py,
    # because the fix moved into the SQL query itself.
    async def test_requester_node_is_invisible_to_a_caller_who_cannot_see_the_only_collection_they_searched(self, app_client):
        cid = await _create_collection(app_client, "Graph Requester Private", "graph-req-owner", visibility="private")
        await _ingest_source(
            app_client, cid, "Graph Requester Private Doc",
            "Content that only the owner of this private collection should surface in search.",
            "graph-req-owner",
        )
        # A human searches the private collection — this is the retrieval
        # whose requester node must not leak to a caller who cannot see cid.
        await _admin_search(app_client, "private collection surface", "human-graph-req-x", collection_id=cid)

        # A caller who is neither the owner nor has this collection shared
        # with them must never see human-graph-req-x's node at all — their
        # only retrieval was into a collection this caller cannot see.
        resp = await app_client.get(
            "/internal/admin/shared/graph",
            headers=INTERNAL_HEADERS,
            params={"owner": "someone-entirely-unrelated"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "Graph Requester Private" not in {n["label"] for n in data["nodes"] if n["type"] == "collection"}
        assert "human-graph-req-x" not in {n["label"] for n in data["nodes"] if n["type"] == "user"}

        # TWIN: the actual owner, scoped, still sees it — the fix removes
        # the leak, it does not remove the feature for the people it's
        # actually meant for.
        owner_resp = await app_client.get(
            "/internal/admin/shared/graph",
            headers=INTERNAL_HEADERS,
            params={"owner": "graph-req-owner"},
        )
        assert owner_resp.status_code == 200
        owner_data = owner_resp.json()
        user_nodes = [n for n in owner_data["nodes"] if n["type"] == "user" and n["label"] == "human-graph-req-x"]
        assert len(user_nodes) == 1
        assert user_nodes[0]["meta"]["retrieval_count"] > 0

        # And the admin (unscoped) view still shows it too — confirms the
        # fix is a scoping change, not an accidental drop of the row.
        admin_resp = await app_client.get("/internal/admin/shared/graph", headers=INTERNAL_HEADERS)
        assert admin_resp.status_code == 200
        assert "human-graph-req-x" in {n["label"] for n in admin_resp.json()["nodes"] if n["type"] == "user"}

    # h#603 review, resolved: the node/edge fix above scoped retrieval_edges
    # and its requester nodes at the SQL level, but the totals block's
    # `requesters_with_retrievals` count sat three lines below its two
    # scoped siblings (collections, sources) with no WHERE clause at all —
    # a magnitude leak, not an identity leak: a scoped caller couldn't see
    # WHO searched an invisible collection, but could still learn HOW MANY
    # distinct people, platform-wide, had ever searched anything. Proved
    # against a real Postgres because the fix is in the SQL, same as #460.
    async def test_totals_requesters_with_retrievals_is_scoped_not_platform_wide(self, app_client):
        cid = await _create_collection(app_client, "Graph Totals Private", "graph-totals-owner", visibility="private")
        await _ingest_source(
            app_client, cid, "Graph Totals Private Doc",
            "Content that only the owner of this private collection should surface in search.",
            "graph-totals-owner",
        )
        # A requester the scoped caller below must never learn exists,
        # searching a collection that caller cannot see.
        await _admin_search(app_client, "surface in search", "human-graph-totals-hidden", collection_id=cid)

        # A second requester into a collection the scoped caller DOES own,
        # so the scoped total is not simply zero — it must count exactly
        # the one requester visible to it, not zero and not the platform total.
        cid_visible = await _create_collection(app_client, "Graph Totals Visible", "graph-totals-scoped", visibility="private")
        await _ingest_source(
            app_client, cid_visible, "Graph Totals Visible Doc",
            "Content the scoped caller owns and can see in the graph totals.",
            "graph-totals-scoped",
        )
        await _admin_search(app_client, "scoped caller owns", "human-graph-totals-visible", collection_id=cid_visible)

        admin_resp = await app_client.get("/internal/admin/shared/graph", headers=INTERNAL_HEADERS)
        assert admin_resp.status_code == 200
        admin_total = admin_resp.json()["total"]["requesters_with_retrievals"]
        # Platform-wide total must include both requesters just created.
        assert admin_total >= 2

        scoped_resp = await app_client.get(
            "/internal/admin/shared/graph",
            headers=INTERNAL_HEADERS,
            params={"owner": "graph-totals-scoped"},
        )
        assert scoped_resp.status_code == 200
        scoped_total = scoped_resp.json()["total"]["requesters_with_retrievals"]

        # The load-bearing assertion: the scoped total must be strictly less
        # than the admin total (it excludes the hidden requester) and must
        # equal exactly the one requester into the collection this caller
        # owns — not zero (which would just mean the query dropped
        # everything) and not the platform-wide count (the leak).
        assert scoped_total == 1
        assert scoped_total < admin_total
