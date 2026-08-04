"""`/api/v1/search` must report how many MATCHED, not how many fit (#234).

THE TWIN OF #209, TWO FILES AWAY. `internal_admin.search_entries` was fixed to
return `total_matches` from a `COUNT(*)` over the same predicate; this handler
kept `count = len(serialized)` under a `LIMIT 20`, so a search over 500 matching
entries reported 20. The figure agreed with itself — twenty rows, the word
twenty — which is what makes this class invisible: there is nothing to notice.

WHY THIS ONE IS WORSE THAN ITS TWIN. `/api/v1/search` is agent-facing; it is
what `akm search` calls. Its consumer is a model reasoning over its own
knowledge base, which sees twenty results and a count of twenty and concludes
those are all the matches. That conclusion is load-bearing for whatever it does
next, and nothing downstream can correct it.

THE FIXTURE MUST HAVE MORE MATCHES THAN THE CAP, and that is the whole test
design. With fewer than twenty matches `count` and `total_matches` are equal and
the fixed and unfixed versions return identical bodies — a small fixture passes
on the defect. Same discipline as #186, #208 and the #209 test.

NOT EXERCISED: the pool is a stub. No Postgres was queried, no FTS index built.
What is asserted is which SQL the handler runs and what it puts in the body.
"""
from __future__ import annotations

from typing import Any

import pytest

from app.routes import search as search_route
from app.services import knowledge_store

CAP = knowledge_store.SEARCH_PAGE_LIMIT


class _Pool:
    """A full page from fetch, and a larger real total from fetchval."""

    def __init__(self, returned: int, matched: int):
        self._returned = returned
        self._matched = matched
        self.fetch_sql: str | None = None
        self.fetchval_sql: str | None = None

    async def fetch(self, sql: str, *_params: Any) -> list[dict[str, Any]]:
        self.fetch_sql = sql
        return [
            {"id": i, "path": f"n/{i}.md", "title": f"E{i}", "entry_type": "note",
             "tags": [], "score": 1.0, "headline": "x",
             "created_at": None, "updated_at": None}
            for i in range(self._returned)
        ]

    async def fetchval(self, sql: str, *_params: Any) -> int:
        self.fetchval_sql = sql
        return self._matched


class _Claims:
    sub = "scout"


class _Request:
    def __init__(self, pool: _Pool):
        self.app = type("A", (), {"state": type("AS", (), {"pool": pool})()})()
        self.state = type("S", (), {"agent_claims": _Claims()})()


@pytest.mark.asyncio
async def test_positive_control_total_matches_is_the_count_not_the_page():
    # 137 matched, 20 fit. The two numbers MUST disagree or this proves nothing.
    pool = _Pool(returned=CAP, matched=137)

    body = await search_route.search(_Request(pool), q="deploy")

    assert body["total_matches"] == 137
    assert body["count"] == CAP            # unchanged meaning: rows in THIS response
    assert body["truncated"] is True
    assert len(body["results"]) == CAP


@pytest.mark.asyncio
async def test_the_total_is_COUNT_over_the_same_predicate_never_len():
    pool = _Pool(returned=CAP, matched=137)

    await search_route.search(_Request(pool), q="deploy")

    assert pool.fetchval_sql is not None, "no COUNT(*) was issued at all"
    assert "COUNT(*)" in pool.fetchval_sql
    # The same WHERE as the page, or the total describes a different question.
    for predicate in ("agent_id = $1", "status = 'active'", "search_vector @@ websearch_to_tsquery"):
        assert predicate in pool.fetchval_sql, f"count predicate is missing {predicate!r}"
    # And it must not be the paged query itself.
    assert "LIMIT" not in pool.fetchval_sql


@pytest.mark.asyncio
async def test_TWIN_a_result_set_smaller_than_the_cap_agrees_with_itself():
    # The fixture that CANNOT distinguish the versions: with 7 matches, broken
    # and fixed return the same body. It is here to keep the case above honest —
    # if this one ever starts failing, `truncated` has begun over-reporting.
    pool = _Pool(returned=7, matched=7)

    body = await search_route.search(_Request(pool), q="deploy")

    assert body["count"] == 7
    assert body["total_matches"] == 7
    assert body["truncated"] is False


@pytest.mark.asyncio
async def test_no_matches_reports_zero_rather_than_nothing():
    pool = _Pool(returned=0, matched=0)

    body = await search_route.search(_Request(pool), q="nothing")

    assert body["results"] == []
    assert body["count"] == 0
    assert body["total_matches"] == 0
    assert body["truncated"] is False


@pytest.mark.asyncio
async def test_the_two_search_handlers_now_answer_the_same_question():
    # #234's actual complaint: two search handlers in one service gave two
    # different answers to "how many matched". Pinning the shared vocabulary so
    # a future change to one is visibly a divergence from the other.
    from app.routes import internal_admin  # noqa: PLC0415 — local by design

    agent_body = await search_route.search(_Request(_Pool(returned=CAP, matched=137)), q="deploy")

    admin_pool = _Pool(returned=CAP, matched=137)
    admin_request = type(
        "R", (), {
            "app": type("A", (), {"state": type("AS", (), {
                "pool": admin_pool,
                "settings": type("S", (), {"internal_service_token": "tok"})(),
            })()})(),
            "headers": {"Authorization": "Bearer tok"},
        },
    )()
    admin_body = await internal_admin.search_entries(admin_request, q="deploy", agent_id="scout")

    for key in ("count", "total_matches", "truncated"):
        assert key in agent_body, f"agent-facing body is missing {key}"
        assert key in admin_body, f"admin body is missing {key}"
        assert agent_body[key] == admin_body[key], f"the two handlers disagree on {key}"
