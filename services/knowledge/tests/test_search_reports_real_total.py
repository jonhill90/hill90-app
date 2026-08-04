"""`/internal/admin/search` must report how many MATCHED, not how many fit.

WHY THIS FILE EXISTS AT ALL. The fix it covers shipped in app#209 with no test.
Auditing today's merges for durability, I deleted the whole COUNT(*) block from
`internal_admin.search_entries` and ran the suite: 80 passed. Nothing anywhere
failed. The api-side tests that appear to cover it (`search-totals.test.ts`) mock
`akm-proxy`, so they exercise the api's merge arithmetic and never touch this
service's SQL — and #209's own PR body cited "knowledge 73 passed" as though that
were coverage, when it was only the pre-existing suite continuing to pass.

A fix with no test is a fix that can be deleted silently, which makes it a comment
with extra steps.

THE FIXTURE MUST HAVE MORE MATCHES THAN THE CAP. The query is `LIMIT 20`. With
fewer than twenty matches, `count` and `total_matches` are equal and the fixed and
unfixed versions return identical bodies — so a small fixture passes on the defect.
Eighth instance this session of that one test-design mistake.
"""
from __future__ import annotations

from typing import Any

import pytest

from app.routes import internal_admin

CAP = 20


class _Pool:
    """Returns a full page from fetch and a larger real total from fetchval."""

    def __init__(self, returned: int, matched: int):
        self._returned = returned
        self._matched = matched
        self.fetchval_sql: str | None = None

    async def fetch(self, _sql: str, *_params: Any) -> list[dict[str, Any]]:
        return [
            {"id": i, "agent_id": "scout", "path": f"n/{i}.md", "title": f"E{i}",
             "entry_type": "note", "tags": [], "score": 1.0, "headline": "x",
             "created_at": None, "updated_at": None}
            for i in range(self._returned)
        ]

    async def fetchval(self, sql: str, *_params: Any) -> int:
        self.fetchval_sql = sql
        return self._matched


class _Request:
    def __init__(self, pool: _Pool):
        settings = type("S", (), {"internal_service_token": "tok"})()
        self.app = type("A", (), {"state": type("AS", (), {"pool": pool, "settings": settings})()})()
        self.headers = {"Authorization": "Bearer tok"}


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_id", [None, "scout"], ids=["all-agents", "one-agent"])
async def test_total_matches_is_the_count_not_the_page(agent_id):
    """POSITIVE CONTROL, on both branches — the scoped query and the unscoped one.

    Covering both is the twin rule: they are separate SQL statements with separate
    COUNT(*)s, and a fix applied to one and not the other is exactly the drift this
    session kept finding.
    """
    pool = _Pool(returned=CAP, matched=137)

    result = await internal_admin.search_entries(_Request(pool), q="deploy", agent_id=agent_id)

    assert len(result["results"]) == CAP
    assert result["count"] == CAP           # how many are in THIS response
    assert result["total_matches"] == 137   # how many exist
    assert result["total_matches"] != result["count"]
    assert result["truncated"] is True


@pytest.mark.asyncio
async def test_counts_over_the_same_predicate_as_the_page():
    """A count over a different scope would describe a different set and still
    look like a plausible number — the hardest kind of wrong to notice."""
    pool = _Pool(returned=CAP, matched=137)

    await internal_admin.search_entries(_Request(pool), q="deploy", agent_id="scout")

    sql = pool.fetchval_sql or ""
    assert "COUNT(*)" in sql
    assert "search_vector @@ websearch_to_tsquery" in sql
    assert "agent_id = $1" in sql
    assert "status = 'active'" in sql
    # A LIMIT here would reintroduce the defect by another route.
    assert "LIMIT" not in sql.upper()


@pytest.mark.asyncio
async def test_not_truncated_when_everything_fit():
    """Guard rail. Note it passes on the BROKEN code too, which is why the
    fixture above — and not this one — is the control."""
    pool = _Pool(returned=3, matched=3)

    result = await internal_admin.search_entries(_Request(pool), q="deploy", agent_id=None)

    assert result["count"] == 3
    assert result["total_matches"] == 3
    assert result["truncated"] is False


@pytest.mark.asyncio
async def test_zero_matches_reports_zero_rather_than_omitting_the_field():
    """An empty result is an answer, and it still carries the total."""
    pool = _Pool(returned=0, matched=0)

    result = await internal_admin.search_entries(_Request(pool), q="nothing", agent_id=None)

    assert result["results"] == []
    assert result["total_matches"] == 0
    assert result["truncated"] is False


@pytest.mark.asyncio
async def test_rejects_a_bad_service_token():
    """The route is service-to-service; the auth check must not be bypassable by
    the stubs this file introduces."""
    from fastapi import HTTPException

    req = _Request(_Pool(1, 1))
    req.headers = {"Authorization": "Bearer wrong"}

    with pytest.raises(HTTPException) as exc:
        await internal_admin.search_entries(req, q="x", agent_id=None)
    assert exc.value.status_code == 401
