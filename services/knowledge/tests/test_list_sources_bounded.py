"""`list_sources` must be bounded, and must say how many there are (#180).

WHERE THIS CAME FROM. #180 is about `list_entries` returning every row — and
that chain is now complete end to end: the store bounds and returns a
`COUNT(*)`, both routes send `X-Total-Count`, the api proxy reads it, the api
route forwards it, and both UI pages and the Go CLI render "N of M". Verified
before writing this.

WHAT WAS NEVER DONE IS THE TWIN. `list_sources` has no LIMIT, no total, and
`SharedKnowledgeClient.tsx:886` renders `{sources.length} source(s)` from it. So
a rendered figure is fed by an unbounded query — correct today only because
nothing caps it, which is #180's own warning and the exact regression #188
shipped once:

    "a length that is correct only because nothing is bounded is a defect
     waiting for someone to bound it"

BOUNDING IT WITHOUT SAYING SO WOULD BE THE DEFECT WEARING A FIX (#215). A cap
the caller cannot detect turns "300 sources" into a confident "50", so the total
travels with the page and the page carries the limit that produced it.

THE FIXTURE HAS MORE ROWS THAN THE CAP. With fewer, the bounded and unbounded
versions return identical lists and an identical count — the same test-design
mistake this repository has now recorded a dozen times.
"""
from __future__ import annotations

from typing import Any

import pytest

from app.services import shared_store


class _Pool:
    def __init__(self, returned: int, matched: int):
        self._returned = returned
        self._matched = matched
        self.sql: list[str] = []
        self.args: list[tuple] = []

    async def fetch(self, sql: str, *a: Any) -> list[dict[str, Any]]:
        self.sql.append(sql)
        self.args.append(a)
        return [
            {"id": f"s{i}", "collection_id": "c1", "title": f"Source {i}",
             "source_type": "web", "source_url": "http://x", "content_hash": "h",
             "status": "active", "error_message": None, "created_by": "dev",
             "created_at": None, "updated_at": None}
            for i in range(self._returned)
        ]

    async def fetchval(self, sql: str, *a: Any) -> int:
        self.sql.append(sql)
        self.args.append(a)
        return self._matched


COLLECTION = "11111111-1111-1111-1111-111111111111"


@pytest.mark.asyncio
async def test_POSITIVE_CONTROL_the_page_is_capped_and_the_total_is_the_real_one():
    # 300 sources, a page of 50. The two numbers MUST disagree or this proves
    # nothing about either half.
    pool = _Pool(returned=50, matched=300)

    rows, total = await shared_store.list_sources(pool, COLLECTION, limit=50, offset=0)

    assert len(rows) == 50
    assert total == 300


@pytest.mark.asyncio
async def test_the_total_is_COUNT_over_the_same_predicate_never_len():
    pool = _Pool(returned=50, matched=300)

    await shared_store.list_sources(pool, COLLECTION, limit=50, offset=0)

    count_sql = [s for s in pool.sql if "count(" in s.lower()]
    assert count_sql, "no COUNT(*) was issued — the total would be the page length"
    assert "collection_id = $1" in count_sql[0], "the count must use the page's WHERE"
    assert "LIMIT" not in count_sql[0], "the count must not be capped by the page"


@pytest.mark.asyncio
async def test_the_page_query_carries_the_limit_and_offset():
    pool = _Pool(returned=10, matched=10)

    await shared_store.list_sources(pool, COLLECTION, limit=10, offset=20)

    page_sql = [s for s in pool.sql if "FROM shared_sources" in s and "count(" not in s.lower()]
    assert page_sql, "no page query"
    assert "LIMIT" in page_sql[0] and "OFFSET" in page_sql[0]
    assert pool.args[0][1:] == (10, 20)


@pytest.mark.asyncio
async def test_TWIN_a_collection_smaller_than_the_cap_agrees_with_itself():
    # The fixture that cannot distinguish the versions — kept so the controls
    # above cannot be satisfied by something that always reports truncation.
    pool = _Pool(returned=3, matched=3)

    rows, total = await shared_store.list_sources(pool, COLLECTION, limit=50, offset=0)

    assert len(rows) == 3
    assert total == 3


@pytest.mark.asyncio
async def test_the_default_is_bounded_too():
    # An unbounded default is how the old behaviour survives a bounded API: the
    # caller that does not pass a limit is exactly the one that was broken.
    pool = _Pool(returned=50, matched=300)

    await shared_store.list_sources(pool, COLLECTION)

    page_sql = [s for s in pool.sql if "FROM shared_sources" in s and "count(" not in s.lower()]
    assert "LIMIT" in page_sql[0]
