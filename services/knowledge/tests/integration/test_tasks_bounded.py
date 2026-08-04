"""Task listings are bounded and report a real total (#184).

`task_store.list_tasks` returned every matching row. On the agent-facing route
that is one agent's tasks; on `/internal/admin/tasks` the `agent_id` filter is
OPTIONAL, so omitting it returned **every task for every agent** — which is why
that path needed a bound more than its twin did, not less.

Every fixture below makes the page length and the real total DISAGREE: three
tasks, `limit=2`, `X-Total-Count: 3`. A fixture where the two numbers match is
passed by a `len(rows)` implementation, and that implementation is the defect.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

ADMIN = {"Authorization": "Bearer test-internal-token"}


async def _seed(client: AsyncClient, token: str, prefix: str, n: int = 3) -> None:
    for i in range(n):
        resp = await client.post(
            "/api/v1/tasks",
            json={"title": f"{prefix}-{i}"},
            headers={"Authorization": f"Bearer {token}"},
        )
        # POST /api/v1/tasks returns 200, not 201 — checked against the route
        # rather than assumed, after this fixture asserted 201 and failed.
        assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
class TestAgentFacingTaskList:
    async def test_page_is_capped_and_total_is_the_whole_set(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        await _seed(app_client, agent_token, "mine")

        resp = await app_client.get(
            "/api/v1/tasks",
            params={"limit": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200

        tasks = resp.json()
        # Still a bare JSON array — a body object would break any consumer
        # treating this as a list, and they deploy independently.
        assert isinstance(tasks, list)
        assert len(tasks) == 2
        assert resp.headers["X-Total-Count"] == "3"

    async def test_offset_pages_without_repeating_or_skipping(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        """Why the ORDER BY carries an id tiebreak.

        Neither sort_order nor updated_at is unique, and tasks created together
        share both. Paging over them alone can hand one task to two pages and
        no page to another.
        """
        await _seed(app_client, agent_token, "walk")

        first = await app_client.get(
            "/api/v1/tasks",
            params={"limit": 2, "offset": 0},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        second = await app_client.get(
            "/api/v1/tasks",
            params={"limit": 2, "offset": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert first.status_code == 200 and second.status_code == 200
        assert len(first.json()) == 2
        assert len(second.json()) == 1
        assert first.headers["X-Total-Count"] == "3"

        ids = [t["id"] for t in first.json()] + [t["id"] for t in second.json()]
        assert len(set(ids)) == 3, f"a task was repeated or skipped: {ids}"

    async def test_total_counts_only_the_callers_own_tasks(
        self, app_client: AsyncClient, agent_token: str, other_agent_token: str
    ) -> None:
        """A COUNT whose WHERE drifts from the page's leaks another agent's size."""
        await _seed(app_client, agent_token, "mine", n=3)
        await _seed(app_client, other_agent_token, "theirs", n=2)

        resp = await app_client.get(
            "/api/v1/tasks",
            params={"limit": 2},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        assert resp.headers["X-Total-Count"] == "3"

    async def test_default_limit_applies_without_explicit_paging(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        """An un-updated caller sends no paging params and must still be bounded."""
        await _seed(app_client, agent_token, "default")

        resp = await app_client.get(
            "/api/v1/tasks", headers={"Authorization": f"Bearer {agent_token}"}
        )
        assert resp.status_code == 200
        assert resp.headers["X-Total-Count"] == "3"

    @pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 2001}, {"offset": -1}])
    async def test_rejects_out_of_range_paging(
        self, app_client: AsyncClient, agent_token: str, params: dict[str, int]
    ) -> None:
        resp = await app_client.get(
            "/api/v1/tasks",
            params=params,
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 422


@pytest.mark.asyncio
class TestInternalAdminTaskList:
    """The unfiltered path — the reason this issue exists."""

    async def test_unfiltered_list_is_bounded_and_totals_every_agent(
        self, app_client: AsyncClient, agent_token: str, other_agent_token: str
    ) -> None:
        # Two agents, five tasks between them, and NO agent_id filter.
        await _seed(app_client, agent_token, "a", n=3)
        await _seed(app_client, other_agent_token, "b", n=2)

        resp = await app_client.get(
            "/internal/admin/tasks", params={"limit": 2}, headers=ADMIN
        )
        assert resp.status_code == 200

        tasks = resp.json()
        assert len(tasks) == 2
        # 5, not 2: omitting agent_id spans every agent, and the total must say
        # so rather than describe the page it happened to return.
        assert resp.headers["X-Total-Count"] == "5"

    async def test_filtered_by_agent_id_totals_only_that_agent(
        self, app_client: AsyncClient, agent_token: str, other_agent_token: str
    ) -> None:
        await _seed(app_client, agent_token, "a", n=3)
        await _seed(app_client, other_agent_token, "b", n=2)

        resp = await app_client.get(
            "/internal/admin/tasks",
            params={"agent_id": "test-agent", "limit": 2},
            headers=ADMIN,
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 2
        assert resp.headers["X-Total-Count"] == "3"

    async def test_status_filter_counts_the_same_scope_as_the_page(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        """The count's WHERE is built from the same conditions as the page's."""
        await _seed(app_client, agent_token, "s", n=3)

        resp = await app_client.get(
            "/internal/admin/tasks",
            params={"status": "backlog", "limit": 2},
            headers=ADMIN,
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 2
        assert resp.headers["X-Total-Count"] == "3"

        none_left = await app_client.get(
            "/internal/admin/tasks", params={"status": "done"}, headers=ADMIN
        )
        assert none_left.status_code == 200
        assert none_left.headers["X-Total-Count"] == "0"
