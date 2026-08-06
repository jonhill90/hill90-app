"""POST /internal/admin/shared/sources must refuse an oversized request
body based on its declared Content-Length, before reading it.

THE GAP. MAX_SOURCE_SIZE (text_chunker.py) was only ever checked in
ingest.py, on `raw_content` as an already-materialised Python string —
FastAPI had already read the entire request body and parsed it into the
SourceCreate model before that check, or any of this route's own code,
ever ran. This route is service-token gated and its one real caller today
is services/api's proxy, sitting behind Express's default 100KB
express.json() limit — a coincidence of two independent defaults landing
close together, not a designed bound. The moment that API-side limit is
raised, removed, or a second internal caller reaches this route without
Express in front of it, this service's own 100KB check becomes the ONLY
backstop, and it fires only after already allocating whatever was sent.

THE FIX is two cheap, non-streaming checks: reject based on the declared
Content-Length header before the body is read at all (this test), and
keep the existing post-parse check on the decoded raw_content as the
backstop for a request that lies about or omits its length (unchanged,
already covered by ingest.py's own existing tests).

PROVING "before the body is read" TURNED OUT TO NEED CARE. This app's own
auth middleware (`@app.middleware("http")` in main.py, Starlette's
BaseHTTPMiddleware) touches the ASGI `receive` channel for structural
reasons (disconnect-watching) on EVERY /internal/* request that reaches
call_next — verified directly by probing an unrelated GET route with no
body at all and observing the identical call count. A raw receive()-count
assertion is therefore uninformative on its own: it cannot tell "the
route read the body" from "the middleware's own plumbing touched receive()
twice regardless." The test below defeats that by feeding a body that
requires MULTIPLE explicit chunks (more_body=True) rather than
completing on the first one — a consumer that only asks for what the
middleware itself needs stops well short of it; a consumer that actually
tries to materialise the whole body (this route's pre-fix behavior) must
keep asking, hits the chunk that hangs, and times out. That is the
discriminating signal, verified in both directions below by mutation.
"""
from __future__ import annotations

import asyncio

import pytest

from app.main import create_app

INTERNAL_TOKEN = "test-internal-token"

# One HTTP round trip through this app's own middleware chain costs a few
# receive() calls before any route code runs at all (verified directly:
# an unrelated GET route with no body touches receive() the same number of
# times). Comfortably above that baseline, so a route that behaves means
# this is never reached; a route that tries to read the whole (never-
# ending) body reaches it and hangs until the outer timeout.
_CHUNKS_BEFORE_HANG = 2
_HANG_SECONDS = 30
_TEST_TIMEOUT_SECONDS = 4.0


async def _post_with_never_completing_body(app, *, path: str = "/internal/admin/shared/sources"):
    """Send a raw ASGI request whose declared Content-Length is huge and
    whose body never finishes arriving (`more_body` stays True past the
    point any well-behaved consumer needs to ask).

    Returns (status_code_or_None, receive_call_count). status is None if
    the call had to be aborted because it was still waiting on the (never
    arriving) rest of the body when the outer timeout fired.
    """
    receive_calls = {"count": 0}

    async def receive():
        receive_calls["count"] += 1
        if receive_calls["count"] <= _CHUNKS_BEFORE_HANG:
            return {"type": "http.request", "body": b"xxxxx", "more_body": True}
        # Reached only by a consumer that is still trying to read MORE of
        # the body after the middleware's own needs are already satisfied
        # — i.e. one that is materialising the whole thing.
        await asyncio.sleep(_HANG_SECONDS)
        return {"type": "http.request", "body": b"", "more_body": False}  # pragma: no cover

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", b"10485760"),  # 10MB declared, never actually sent
            (b"authorization", f"Bearer {INTERNAL_TOKEN}".encode()),
        ],
        "server": ("test", 80),
        "client": ("test", 12345),
        "scheme": "http",
    }

    messages: list[dict] = []

    async def send(message):
        messages.append(message)

    try:
        await asyncio.wait_for(app(scope, receive, send), timeout=_TEST_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        return None, receive_calls["count"]

    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    return status, receive_calls["count"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_declared_oversized_content_length_is_refused_without_reading_the_whole_body(
    test_settings, db_pool
):
    app = create_app(settings=test_settings, pool=db_pool)
    async with app.router.lifespan_context(app):
        status, receive_calls = await _post_with_never_completing_body(app)

    # THE ASSERTION THAT MATTERS: a 413 that arrives WITHOUT ever asking
    # for the body chunk beyond what the middleware itself already needed.
    # A version that reads the body before checking Content-Length would
    # keep asking for more (there always is "more" — more_body stays True),
    # reach the hang, and this call would time out instead of returning.
    assert status == 413, (
        f"expected 413 without ever fully reading the body; got status={status!r} "
        f"after {receive_calls} receive() calls (None means the call timed out "
        f"waiting on more of the body — i.e. it tried to read past what the "
        f"middleware itself needed)"
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_request_within_the_limit_is_read_normally(test_settings, db_pool):
    """Guard rail: the Content-Length check must not refuse legitimate,
    small requests — without it, a check that rejects everything would
    also pass the test above."""
    app = create_app(settings=test_settings, pool=db_pool)
    body = (
        b'{"collection_id": "not-a-uuid", "title": "x", "source_type": "text", '
        b'"raw_content": "hello", "created_by": "u"}'
    )

    receive_calls = {"count": 0}
    body_sent = False

    async def receive():
        nonlocal body_sent
        receive_calls["count"] += 1
        if not body_sent:
            body_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        # ASGI protocol: once a body completes (more_body=False), Starlette's
        # own disconnect-watcher calls receive() again expecting exactly
        # this message, not another http.request — the oversized-body test
        # above found this out by hitting it directly.
        return {"type": "http.disconnect"}

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/internal/admin/shared/sources",
        "raw_path": b"/internal/admin/shared/sources",
        "root_path": "",
        "query_string": b"",
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"authorization", f"Bearer {INTERNAL_TOKEN}".encode()),
        ],
        "server": ("test", 80),
        "client": ("test", 12345),
        "scheme": "http",
    }
    messages: list[dict] = []

    async def send(message):
        messages.append(message)

    async with app.router.lifespan_context(app):
        await asyncio.wait_for(app(scope, receive, send), timeout=5.0)

    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    # Invalid collection_id fails validation downstream — 422, not 413 —
    # proving the request reached that point rather than being refused
    # purely for its (well-within-limit) size.
    assert status == 422
