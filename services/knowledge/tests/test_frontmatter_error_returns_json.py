"""Malformed frontmatter must come back as JSON, not a plain-text 500.

THE DEFECT, confirmed in the code rather than taken from a summary.

There is no "FrontmatterError path". That is the whole problem: `FrontmatterError`
subclassed bare `Exception`, so it was caught by nothing. Every route that writes an
entry already catches `ValueError` and turns it into
`HTTPException(400, detail=str(e))` — proper JSON — but `FrontmatterError` sailed past
that handler, escaped the route, and Starlette's ServerErrorMiddleware answered with its
default body: the plain text `Internal Server Error`.

Measured before the fix:

    status       : 500
    content-type : text/plain; charset=utf-8
    body         : Internal Server Error
    json.loads   : RAISES JSONDecodeError

So a client submitting malformed frontmatter and calling `response.json()` got a
JSONDecodeError instead of being told what was wrong with its input. Every other error
on this surface is JSON.

Two things beyond the one-line description, both found by reading:

  1. It is not one surface, it is FIVE call sites across four routes —
     entries.create_entry, entries.update_entry, journal.py:52 and
     internal_admin.py:204/:253 — each with the same `except ValueError` that missed
     it. A per-route fix would have to touch all five and the sixth added later would
     be forgotten.

  2. 500 was the wrong STATUS too, not just the wrong content type. Malformed
     frontmatter is the client's input; reporting a server fault for it misattributes
     the blame, which is the same family of defect as the body format.

WHY httpx.ASGITransport AND NOT starlette's TestClient. The first version used
`TestClient(app, raise_server_exceptions=False)` and passed locally while failing in CI
with `TypeError: Client.__init__() got an unexpected keyword argument 'app'`. httpx 0.28
removed the `app=` shortcut; the starlette pinned here still passes it, and my local
environment happened to have a much newer starlette that does not. Driving the ASGI app
through ASGITransport directly depends on neither version's behaviour, and still
exercises the real HTTP semantics — status, content-type, body — which is the whole
point of the test.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from app.middleware.agent_auth import AgentClaims
from app.routes import entries

# The router carries prefix="/api/v1/entries". Getting this wrong is not a harmless
# typo: an earlier version posted to "" and got 404 {"detail":"Not Found"} — which is
# JSON, and 404 satisfies "4xx", so ten assertions passed without ever reaching the
# parser. Hence the not-404 guard in every test below.
PREFIX = "/api/v1/entries"

MALFORMED = [
    pytest.param("no frontmatter at all", id="missing-delimiter"),
    pytest.param("---\ntitle: x\n", id="unclosed-delimiter"),
    pytest.param("---\n: : :\n---\nbody", id="invalid-yaml"),
    pytest.param("---\ntitle: x\n---\nbody", id="missing-required-type"),
    pytest.param("---\ntitle: x\ntype: nonsense\n---\nbody", id="invalid-type"),
]


def _build_app():
    """The entries router with no database.

    parse_frontmatter runs before any query, so a pool that raises if touched is the
    right fixture: if a test ever reaches the database, that is a bug in the test rather
    than something to paper over with a mock.
    """
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(entries.router)

    class ExplodingPool:
        def __getattr__(self, name: str):  # pragma: no cover - must never run
            raise AssertionError(
                f"the database was touched ({name}); frontmatter should fail first"
            )

    app.state.pool = ExplodingPool()
    app.state.settings = SimpleNamespace(data_dir="/nonexistent")

    @app.middleware("http")
    async def inject_claims(request, call_next):
        request.state.agent_claims = AgentClaims(
            sub="agent-under-test",
            iss="test",
            aud="test",
            exp=9999999999,
            iat=0,
            jti="j",
            scopes=["knowledge:write"],
        )
        return await call_next(request)

    return app


def _client() -> httpx.AsyncClient:
    # raise_app_exceptions=False so an unhandled exception becomes the response the
    # CLIENT would actually see. ServerErrorMiddleware sends its plain-text 500 and then
    # re-raises; without this the re-raise reaches the test and hides the very body that
    # is the defect.
    transport = httpx.ASGITransport(app=_build_app(), raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


def _assert_json_client_error(r: httpx.Response) -> dict:
    assert r.status_code != 404, (
        "the request never reached the route — this test would otherwise pass on the "
        "404's JSON body without exercising the frontmatter parser at all"
    )
    try:
        payload = json.loads(r.text)
    except json.JSONDecodeError as e:
        pytest.fail(
            f"body is not JSON ({e}); a client calling response.json() gets this "
            f"exception instead of the error. status={r.status_code} "
            f"content-type={r.headers.get('content-type')!r} body={r.text[:80]!r}"
        )
    assert isinstance(payload, dict) and "detail" in payload, payload
    # And it must be attributed to the client, not reported as a server fault.
    assert 400 <= r.status_code < 500, (
        f"malformed client input reported as {r.status_code}; the input is the "
        f"client's, so the status should be 4xx"
    )
    return payload


@pytest.mark.parametrize("content", MALFORMED)
async def test_create_returns_json_for_malformed_frontmatter(content):
    async with _client() as c:
        r = await c.post(PREFIX, json={"path": "notes/x.md", "content": content})
    _assert_json_client_error(r)


@pytest.mark.parametrize("content", MALFORMED)
async def test_update_returns_json_for_malformed_frontmatter(content):
    """update_entry has its own copy of the same handler, so it needs its own test."""
    async with _client() as c:
        r = await c.put(f"{PREFIX}/notes/x.md", json={"content": content})
    _assert_json_client_error(r)


async def test_the_message_says_what_is_wrong_with_the_input():
    """A JSON body carrying a useless message would satisfy the assertions above."""
    async with _client() as c:
        r = await c.post(
            PREFIX, json={"path": "notes/x.md", "content": "no frontmatter at all"}
        )
    detail = _assert_json_client_error(r)["detail"]
    assert "frontmatter" in detail.lower(), (
        f"the message should name the problem, not just have the right shape: {detail!r}"
    )


def test_frontmatter_error_is_a_value_error():
    """Structural, and it is the fix.

    Every writing route already catches ValueError. Malformed input IS a value error,
    so saying so once fixes all five call sites at the same time — rather than adding
    `except FrontmatterError` in five places and missing the sixth one added later.
    """
    from app.services.frontmatter import FrontmatterError

    assert issubclass(FrontmatterError, ValueError), (
        "FrontmatterError subclasses bare Exception, so the existing "
        "`except ValueError` handlers do not see it and it escapes as a plain-text 500"
    )
