"""Shared collections are bounded and report a real total (#207).

`shared_store.list_collections` returned every matching row on all three
branches. It is reached two ways, and the AGENT one is why this matters most:

  * `GET /api/v1/shared/collections` — agent JWT. An agent has no scrollbar and
    no instinct that something is missing. It reasons over a short list and
    reports success, which is the silent-success family with the one caller
    that can never notice.
  * `GET /internal/admin/shared/collections` — service token, `owner` optional,
    so omitting it spans every owner.

Every fixture below makes the page length and the real total DISAGREE: three
collections, `limit=2`, `X-Total-Count: 3`. A fixture where the two numbers
match is passed by a `len(rows)` implementation, and that implementation is the
defect it is meant to catch.
"""

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


async def _seed(client, owner: str, prefix: str, n: int = 3, visibility: str = "private"):
    for i in range(n):
        resp = await client.post(
            "/internal/admin/shared/collections",
            headers=HEADERS,
            json={
                "name": f"{prefix}-{i}",
                "description": "",
                "visibility": visibility,
                "created_by": owner,
            },
        )
        assert resp.status_code == 200, resp.text


class TestAgentFacingCollections:
    """The surface an agent reads. The half that matters most."""

    async def test_page_is_capped_and_total_is_the_whole_set(
        self, app_client, agent_token
    ):
        await _seed(app_client, "test-user-sub", "mine")

        resp = await app_client.get(
            "/api/v1/shared/collections",
            params={"limit": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200

        collections = resp.json()
        # Still a bare JSON array. The total travels in a header for the same
        # reason as /entries: a body object would break every consumer that
        # treats this as a list, and they deploy independently.
        assert isinstance(collections, list)
        assert len(collections) == 2
        assert resp.headers["X-Total-Count"] == "3"

    async def test_offset_pages_without_repeating_or_skipping(
        self, app_client, agent_token
    ):
        await _seed(app_client, "test-user-sub", "walk")

        first = await app_client.get(
            "/api/v1/shared/collections",
            params={"limit": 2, "offset": 0},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        second = await app_client.get(
            "/api/v1/shared/collections",
            params={"limit": 2, "offset": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert first.status_code == 200 and second.status_code == 200
        assert len(first.json()) == 2
        assert len(second.json()) == 1
        assert first.headers["X-Total-Count"] == "3"

        # updated_at is not unique for rows created in the same instant, so the
        # ORDER BY carries an id tiebreak. Without it one collection lands on
        # two pages and another on none.
        ids = [c["id"] for c in first.json()] + [c["id"] for c in second.json()]
        assert len(set(ids)) == 3, f"a collection was repeated or skipped: {ids}"

    async def test_total_counts_only_what_this_agent_can_see(
        self, app_client, agent_token
    ):
        """A COUNT whose WHERE drifts from the page's leaks another owner's size."""
        await _seed(app_client, "test-user-sub", "mine", n=3)
        await _seed(app_client, "someone-else", "theirs", n=2)

        resp = await app_client.get(
            "/api/v1/shared/collections",
            params={"limit": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        # 3, not 5: the other owner's private collections are neither returned
        # nor counted.
        assert resp.headers["X-Total-Count"] == "3"

    async def test_shared_visibility_is_counted_as_well_as_returned(
        self, app_client, agent_token
    ):
        """The include_shared branch is its own SQL and needs its own control."""
        await _seed(app_client, "test-user-sub", "mine", n=2)
        await _seed(app_client, "someone-else", "open", n=2, visibility="shared")

        resp = await app_client.get(
            "/api/v1/shared/collections",
            params={"limit": 1},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 1
        # 2 own + 2 shared-by-another-owner.
        assert resp.headers["X-Total-Count"] == "4"

    async def test_default_limit_applies_without_explicit_paging(
        self, app_client, agent_token
    ):
        await _seed(app_client, "test-user-sub", "default")

        resp = await app_client.get(
            "/api/v1/shared/collections",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        assert resp.headers["X-Total-Count"] == "3"

    @pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 2001}, {"offset": -1}])
    async def test_rejects_out_of_range_paging(self, app_client, agent_token, params):
        resp = await app_client.get(
            "/api/v1/shared/collections",
            params=params,
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 422


class TestAdminCollections:
    """The twin. `owner` is optional here, so omitting it spans every owner."""

    async def test_unfiltered_list_is_bounded_and_totals_every_owner(self, app_client):
        await _seed(app_client, "user-a", "a", n=3)
        await _seed(app_client, "user-b", "b", n=2)

        resp = await app_client.get(
            "/internal/admin/shared/collections", params={"limit": 2}, headers=HEADERS
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 2
        # 5, not 2: with no owner filter the scope is every owner, and the
        # total must describe that rather than the page it happened to return.
        assert resp.headers["X-Total-Count"] == "5"

    async def test_owner_scoped_total_matches_the_scoped_page(self, app_client):
        await _seed(app_client, "user-a", "a", n=3)
        await _seed(app_client, "user-b", "b", n=2)

        resp = await app_client.get(
            "/internal/admin/shared/collections",
            params={"owner": "user-a", "limit": 2},
            headers=HEADERS,
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 2
        assert resp.headers["X-Total-Count"] == "3"
