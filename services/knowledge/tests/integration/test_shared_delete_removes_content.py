"""Deleting shared knowledge must remove it from SEARCH, not just from a list.

Deletion already existed when these were written — `DELETE /collections/{id}` and
`DELETE /sources/{id}` at the AKM, proxied by the api with owner-or-admin scoping,
and the schema cascades collection -> source -> document -> chunk. What did not
exist was any proof that a deleted source stops being *retrievable*.

That distinction is the whole point. A source that vanishes from a listing while
its chunks stay searchable is worse than no deletion at all: search keeps
returning citations to content the user believes they removed, and the user has
no way to tell. `test_delete_collection_cascades` asserted only that the parent
returned 404 — it never checked the source, the chunks, or search.

Every test here uses a POSITIVE CONTROL: it asserts the content IS findable
before deleting it. Without that, "not found afterwards" is equally consistent
with a query that never matched anything, which is the failure mode this estate
has hit repeatedly.
"""

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}

# Deliberately unusual, so a match cannot come from other fixtures' content.
NEEDLE = "quokka"


async def _collection(app_client, name, owner, visibility="shared"):
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=HEADERS,
        json={"name": name, "created_by": owner, "visibility": visibility},
    )
    assert resp.status_code == 200, f"collection create failed: {resp.text}"
    return resp.json()["id"]


async def _source(app_client, collection_id, title, content, owner):
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
    assert resp.status_code == 200, f"source create failed: {resp.text}"
    # ingest_source returns {"source": {...}, "ingest_job": {...}, "document": {...}}
    # — the source id is nested, not top level.
    return resp.json()["source"]


async def _search(app_client, query, requester):
    resp = await app_client.get(
        "/internal/admin/shared/search",
        headers=HEADERS,
        params={"q": query, "requester_id": requester},
    )
    assert resp.status_code == 200, f"search failed: {resp.text}"
    return resp.json()


def _hit_ids(payload):
    return {r.get("source_id") for r in payload.get("results", [])}


class TestDeletedSourceLeavesSearch:
    async def test_deleted_source_is_not_retrievable(self, app_client, db_pool):
        cid = await _collection(app_client, "Delete Search Col", "user-del-search")
        src = await _source(
            app_client, cid, "Marsupial Notes",
            f"The {NEEDLE} is a small macropod found in Western Australia.",
            "user-del-search",
        )
        sid = src["id"]

        # POSITIVE CONTROL — the query must match before deletion, or the
        # assertion after it proves nothing at all.
        before = await _search(app_client, NEEDLE, "user-del-search")
        assert sid in _hit_ids(before), (
            "positive control failed: the source was not searchable before deletion, "
            "so its absence afterwards would prove nothing"
        )

        # And its chunks really exist, so "gone" below is a change of state.
        async with db_pool.acquire() as conn:
            chunks_before = await conn.fetchval(
                """SELECT count(*) FROM shared_chunks c
                   JOIN shared_documents d ON d.id = c.document_id
                   WHERE d.source_id = $1""", sid,
            )
        assert chunks_before > 0, "no chunks were produced; the ingest never happened"

        resp = await app_client.delete(
            f"/internal/admin/shared/sources/{sid}", headers=HEADERS
        )
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

        # The actual claim.
        after = await _search(app_client, NEEDLE, "user-del-search")
        assert sid not in _hit_ids(after), "a deleted source is still returned by search"

        # And the dependents went with it, rather than being orphaned.
        async with db_pool.acquire() as conn:
            assert await conn.fetchval(
                "SELECT count(*) FROM shared_documents WHERE source_id = $1", sid) == 0
            assert await conn.fetchval(
                """SELECT count(*) FROM shared_chunks c
                   JOIN shared_documents d ON d.id = c.document_id
                   WHERE d.source_id = $1""", sid) == 0

    async def test_deleting_one_source_leaves_its_siblings_searchable(
        self, app_client, db_pool
    ):
        """Deletion must be scoped to the source, not a blanket wipe."""
        cid = await _collection(app_client, "Sibling Col", "user-sibling")
        doomed = await _source(
            app_client, cid, "Doomed", f"A {NEEDLE} lives here.", "user-sibling")
        keeper = await _source(
            app_client, cid, "Keeper", f"Another {NEEDLE} lives here too.", "user-sibling")

        before = _hit_ids(await _search(app_client, NEEDLE, "user-sibling"))
        assert doomed["id"] in before and keeper["id"] in before, "positive control failed"

        await app_client.delete(
            f"/internal/admin/shared/sources/{doomed['id']}", headers=HEADERS)

        after = _hit_ids(await _search(app_client, NEEDLE, "user-sibling"))
        assert doomed["id"] not in after, "the deleted source is still searchable"
        assert keeper["id"] in after, "deleting one source removed a sibling's content"


class TestDeletedCollectionLeavesSearch:
    async def test_collection_delete_cascades_out_of_search(self, app_client, db_pool):
        """The cascade the existing test names but never verifies."""
        cid = await _collection(app_client, "Cascade Search Col", "user-cascade")
        src = await _source(
            app_client, cid, "Cascade Source",
            f"A {NEEDLE} appears in this collection.", "user-cascade",
        )
        sid = src["id"]

        before = await _search(app_client, NEEDLE, "user-cascade")
        assert sid in _hit_ids(before), "positive control failed"

        resp = await app_client.delete(
            f"/internal/admin/shared/collections/{cid}", headers=HEADERS)
        assert resp.status_code == 200

        after = await _search(app_client, NEEDLE, "user-cascade")
        assert sid not in _hit_ids(after), (
            "content from a deleted collection is still searchable"
        )

        async with db_pool.acquire() as conn:
            assert await conn.fetchval(
                "SELECT count(*) FROM shared_sources WHERE collection_id = $1", cid) == 0
            assert await conn.fetchval(
                "SELECT count(*) FROM shared_documents WHERE source_id = $1", sid) == 0


class TestAuditTrailSurvivesDeletion:
    """The retrieval log is a record of what happened. Deleting content must not
    rewrite that history — someone searched, and that remains true afterwards."""

    async def test_retrieval_rows_survive_and_keep_their_chunk_ids(
        self, app_client, db_pool
    ):
        cid = await _collection(app_client, "Audit Survive Col", "user-audit-del")
        src = await _source(
            app_client, cid, "Audited Source",
            f"The {NEEDLE} was retrieved before deletion.", "user-audit-del",
        )

        found = await _search(app_client, NEEDLE, "user-audit-del")
        assert src["id"] in _hit_ids(found), "positive control failed"

        async with db_pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT id, chunk_ids, collection_id FROM shared_retrievals
                   WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 1""",
                "user-audit-del",
            )
        assert row is not None, "no audit row was written for the search"
        retrieval_id = row["id"]
        chunk_ids_before = list(row["chunk_ids"])
        assert chunk_ids_before, "the audit row recorded no chunks"

        await app_client.delete(
            f"/internal/admin/shared/collections/{cid}", headers=HEADERS)

        async with db_pool.acquire() as conn:
            after = await conn.fetchrow(
                "SELECT id, chunk_ids, collection_id FROM shared_retrievals WHERE id = $1",
                retrieval_id,
            )

        assert after is not None, (
            "the audit row was deleted with the content — retrieval history must survive"
        )
        assert list(after["chunk_ids"]) == chunk_ids_before, (
            "the recorded chunk ids were rewritten; the audit row must stay as written"
        )
        # collection_id is ON DELETE SET NULL by design: the row survives, and the
        # dangling link is cleared rather than left pointing at nothing.
        assert after["collection_id"] is None, (
            "collection_id should be nulled by ON DELETE SET NULL, not retained"
        )
