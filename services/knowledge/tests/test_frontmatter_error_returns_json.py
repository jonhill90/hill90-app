"""Malformed frontmatter must come back as JSON, not a plain-text 500.

THE DEFECT, confirmed in the code rather than taken from a summary.

There is no "FrontmatterError path". That is the whole problem: `FrontmatterError`
subclasses bare `Exception`, so it is caught by nothing. Every route that writes an
entry already catches `ValueError` and turns it into
`HTTPException(400, detail=str(e))` — proper JSON — but `FrontmatterError` sails past
that handler, escapes the route, and Starlette's ServerErrorMiddleware answers with its
default body: the plain text `Internal Server Error`.

So a client that submits malformed frontmatter and calls `response.json()` gets a
JSONDecodeError instead of being told what is wrong with its input. Every other error
on this surface is JSON.

Two things beyond the one-line description, both found by reading:

  1. It is not one surface, it is FOUR. parse_frontmatter runs under
     entries.create_entry, entries.update_entry, journal.py:52 and
     internal_admin.py:204/:253 — each with the same `except ValueError` that misses
     it. A per-route fix would have to touch all of them and one would be forgotten.

  2. 500 is the wrong STATUS too, not just the wrong content type. Malformed
     frontmatter is the client's input; reporting a server fault for it misattributes
     the blame, which is the same family of defect as the body format.

These tests assert the client-visible contract: a 4xx, and a body that parses as JSON.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware.agent_auth import AgentClaims
from app.routes import entries

# The router carries prefix="/api/v1/entries". Getting this wrong is not a harmless
# typo: the first version of this file posted to "" and got 404 {"detail":"Not Found"}
# — which is JSON, and 404 satisfies "4xx", so ten assertions passed without ever
# reaching the parser. Hence the not-404 guard in every test below.
PREFIX = "/api/v1/entries"

MALFORMED = [
    pytest.param("no frontmatter at all", id="missing-delimiter"),
    pytest.param("---\ntitle: x\n", id="unclosed-delimiter"),
    pytest.param("---\n: : :\n---\nbody", id="invalid-yaml"),
    pytest.param("---\ntitle: x\n---\nbody", id="missing-required-type"),
    pytest.param("---\ntitle: x\ntype: nonsense\n---\nbody", id="invalid-type"),
]


@pytest.fixture
def client() -> TestClient:
    """The entries router with no database.

    parse_frontmatter runs before any query, so a pool that would explode if touched
    is the right fixture: if a test ever reaches the database, that is a bug in the
    test rather than something to paper over with a mock.
    """
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

    # raise_server_exceptions=False so an unhandled exception becomes the response the
    # CLIENT would actually see, instead of being re-raised into the test. Without this
    # the test would report an exception and hide the plain-text body that is the defect.
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("content", MALFORMED)
def test_create_returns_json_for_malformed_frontmatter(client, content):
    r = client.post(PREFIX, json={"path": "notes/x.md", "content": content})

    assert r.status_code != 404, (
        "the request never reached the route — this test would otherwise pass on the "
        "404's JSON body without exercising the frontmatter parser at all"
    )

    # The body must be JSON. This is the assertion that fails today: the response is
    # `Internal Server Error` as text/plain, so json.loads raises.
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
        f"malformed client input reported as {r.status_code}; "
        f"the input is the client's, so the status should be 4xx"
    )


@pytest.mark.parametrize("content", MALFORMED)
def test_update_returns_json_for_malformed_frontmatter(client, content):
    """update_entry has its own copy of the same handler, so it needs its own test."""
    r = client.put(f"{PREFIX}/notes/x.md", json={"content": content})

    assert r.status_code != 404, "the request never reached the route (see above)"

    try:
        payload = json.loads(r.text)
    except json.JSONDecodeError as e:
        pytest.fail(
            f"body is not JSON ({e}). status={r.status_code} "
            f"content-type={r.headers.get('content-type')!r} body={r.text[:80]!r}"
        )

    assert isinstance(payload, dict) and "detail" in payload, payload
    assert 400 <= r.status_code < 500, r.status_code


def test_the_message_says_what_is_wrong_with_the_input():
    """A JSON body carrying a useless message would satisfy the tests above."""
    app = FastAPI()
    app.include_router(entries.router)
    app.state.pool = object()
    app.state.settings = SimpleNamespace(data_dir="/nonexistent")

    @app.middleware("http")
    async def inject_claims(request, call_next):
        request.state.agent_claims = AgentClaims(
            sub="a", iss="t", aud="t", exp=9999999999, iat=0, jti="j", scopes=[]
        )
        return await call_next(request)

    c = TestClient(app, raise_server_exceptions=False)
    r = c.post(PREFIX, json={"path": "notes/x.md", "content": "no frontmatter at all"})
    assert r.status_code != 404, "never reached the route"
    detail = json.loads(r.text)["detail"]
    assert "frontmatter" in detail.lower(), (
        f"the message should name the problem, not just have the right shape: {detail!r}"
    )


def test_frontmatter_error_is_a_value_error():
    """Structural, and it is the fix.

    Every writing route already catches ValueError. Malformed input IS a value error,
    so saying so once fixes all four surfaces at the same time — rather than adding
    `except FrontmatterError` in four places and missing the fifth one added later.
    """
    from app.services.frontmatter import FrontmatterError

    assert issubclass(FrontmatterError, ValueError), (
        "FrontmatterError subclasses bare Exception, so the existing "
        "`except ValueError` handlers do not see it and it escapes as a plain-text 500"
    )
