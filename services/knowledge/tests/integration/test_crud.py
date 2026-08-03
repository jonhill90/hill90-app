"""Integration tests for CRUD entry operations."""

import pytest

pytestmark = pytest.mark.integration


class TestCreateEntry:
    async def test_create_entry(self, app_client, agent_token):
        resp = await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "plans/test-plan.md",
                "content": "---\ntitle: Test Plan\ntype: plan\n---\n# Test Plan\n\nContent here.",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["path"] == "plans/test-plan.md"
        assert data["title"] == "Test Plan"
        assert data["entry_type"] == "plan"
        assert data["sync_status"] in ("pending", "synced")

    async def test_create_entry_without_auth_returns_401(self, app_client):
        resp = await app_client.post(
            "/api/v1/entries",
            json={
                "path": "plans/test.md",
                "content": "---\ntitle: T\ntype: plan\n---\nBody.",
            },
        )
        assert resp.status_code == 401

    async def test_create_entry_path_traversal_returns_400(self, app_client, agent_token):
        resp = await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "../etc/passwd",
                "content": "---\ntitle: Evil\ntype: plan\n---\nBody.",
            },
        )
        assert resp.status_code == 400


class TestListEntriesIsBounded:
    """GET /api/v1/entries — the agent-facing twin of the admin endpoint (#183).

    The admin endpoint was bounded in #182 and this one was left unbounded for
    the length of that PR. Both now carry the same bound, the same real total,
    and the same tiebreak.
    """

    ENTRY = "---\ntitle: Paged\ntype: note\n---\nBody."

    async def _seed(self, app_client, agent_token, prefix, n=3):
        for i in range(n):
            resp = await app_client.post(
                "/api/v1/entries",
                headers={"Authorization": f"Bearer {agent_token}"},
                json={"path": f"notes/{prefix}-{i}.md", "content": self.ENTRY},
            )
            assert resp.status_code == 201, resp.text

    async def test_page_is_capped_and_total_is_the_whole_set(self, app_client, agent_token):
        """3 rows, limit=2, header says 3 — the two numbers must DISAGREE.

        A fixture with fewer rows than the limit makes them equal, and an
        ``X-Total-Count: len(rows)`` implementation passes that weaker fixture
        unnoticed: a total derived from the page agrees with itself and
        reports truncation as completeness.
        """
        await self._seed(app_client, agent_token, "cap")

        resp = await app_client.get(
            "/api/v1/entries",
            params={"limit": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200

        entries = resp.json()
        # Still a bare JSON array. cli/client/akm.go:198 unmarshals into
        # []map[string]interface{} — a body object is a hard decode error
        # there, not merely an empty render.
        assert isinstance(entries, list)
        assert len(entries) == 2
        assert resp.headers["X-Total-Count"] == "3"

    async def test_type_filtered_page_is_capped_and_totalled(self, app_client, agent_token):
        """The filtered branch is its own SQL string and needs its own control."""
        await self._seed(app_client, agent_token, "typed")

        resp = await app_client.get(
            "/api/v1/entries",
            params={"type": "note", "limit": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        entries = resp.json()
        assert len(entries) == 2
        assert all(e["entry_type"] == "note" for e in entries)
        assert resp.headers["X-Total-Count"] == "3"

    async def test_offset_pages_without_repeating_or_skipping(self, app_client, agent_token):
        """Why the ORDER BY carries an id tiebreak.

        Entries written in the same instant share an ``updated_at``. Paging
        over a non-unique sort key can hand one row to two pages and no page
        to another — the same silent wrong answer as truncation, arriving
        through pagination instead.
        """
        await self._seed(app_client, agent_token, "walk")

        first = await app_client.get(
            "/api/v1/entries",
            params={"limit": 2, "offset": 0},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        second = await app_client.get(
            "/api/v1/entries",
            params={"limit": 2, "offset": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert first.status_code == 200 and second.status_code == 200
        assert len(first.json()) == 2
        assert len(second.json()) == 1
        assert first.headers["X-Total-Count"] == "3"
        assert second.headers["X-Total-Count"] == "3"

        paths = [e["path"] for e in first.json()] + [e["path"] for e in second.json()]
        assert len(set(paths)) == 3, f"a row was repeated or skipped: {paths}"

    async def test_default_limit_applies_without_an_explicit_limit(self, app_client, agent_token):
        """An un-updated caller sends no paging params and must still be bounded."""
        await self._seed(app_client, agent_token, "default")

        resp = await app_client.get(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)
        assert resp.headers["X-Total-Count"] == "3"

    @pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 2001}, {"offset": -1}])
    async def test_rejects_out_of_range_paging(self, app_client, agent_token, params):
        resp = await app_client.get(
            "/api/v1/entries",
            params=params,
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 422

    async def test_isolation_holds_under_paging(
        self, app_client, agent_token, other_agent_token
    ):
        """The total counts the caller's OWN entries, not everyone's.

        A COUNT(*) whose WHERE drifts from the page's WHERE leaks the size of
        another agent's namespace even though no row crosses the boundary.
        """
        await self._seed(app_client, agent_token, "mine", n=3)
        await self._seed(app_client, other_agent_token, "theirs", n=2)

        resp = await app_client.get(
            "/api/v1/entries",
            params={"limit": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        assert resp.headers["X-Total-Count"] == "3"
        assert all("mine" in e["path"] for e in resp.json())


class TestReadEntry:
    async def test_read_entry(self, app_client, agent_token):
        # Create first
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/read-test.md",
                "content": "---\ntitle: Read Test\ntype: note\n---\n# Read Test\n\nReadable content.",
            },
        )
        # Read back
        resp = await app_client.get(
            "/api/v1/entries/notes/read-test.md",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Read Test"
        assert "Readable content" in data["content"]


class TestUpdateEntry:
    async def test_update_entry(self, app_client, agent_token):
        # Create
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/update-test.md",
                "content": "---\ntitle: Original\ntype: note\n---\nOriginal body.",
            },
        )
        # Update
        resp = await app_client.put(
            "/api/v1/entries/notes/update-test.md",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "content": "---\ntitle: Updated\ntype: note\n---\nUpdated body.",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Updated"


class TestArchiveEntry:
    async def test_archive_entry(self, app_client, agent_token):
        # Create
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/archive-test.md",
                "content": "---\ntitle: Archive Me\ntype: note\n---\nBody.",
            },
        )
        # Archive (soft delete)
        resp = await app_client.delete(
            "/api/v1/entries/notes/archive-test.md",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["archived"] is True

        # Reading archived entry returns 404
        resp = await app_client.get(
            "/api/v1/entries/notes/archive-test.md",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 404


class TestCrossAgentIsolation:
    async def test_cross_agent_read_returns_404(
        self, app_client, agent_token, other_agent_token
    ):
        # Create entry as test-agent
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/secret.md",
                "content": "---\ntitle: Secret\ntype: note\n---\nAgent A's secret.",
            },
        )
        # Try to read as other-agent
        resp = await app_client.get(
            "/api/v1/entries/notes/secret.md",
            headers={"Authorization": f"Bearer {other_agent_token}"},
        )
        # Returns 404 (not 403) to avoid information leakage about other agents' entries
        assert resp.status_code == 404
