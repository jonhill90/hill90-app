"""A stream that breaks partway must not end like one that finished (#259).

THE QUESTION THIS FILE ANSWERS. When the upstream breaks mid-response, does the
consumer receive an ending indistinguishable from a normal one? Before this
change: yes. `proxy.py` set `streaming_result.error` and re-raised; `main.py`
caught it with `except Exception: pass`; the generator then returned normally,
so the response body terminated normally and the caller saw a well-formed SSE
stream that simply stopped — no `[DONE]`, no `finish_reason`, no error event.
The failure was recorded for us, in a `usage_logs` row, and the caller was told
nothing.

THIS IS THE STREAMING TWIN OF #263, and the marker matters more here, because
the consumer has already begun acting on the tokens it received. So the fix is
the same shape: MARK the ending, do not discard the content.

WHY THE FIXTURES STOP WITHOUT THE TERMINAL EVENT. A complete stream cannot tell
the versions apart — with `data: [DONE]` on the end, the swallowing version and
this one emit identical bytes. The only fixture that measures anything is one
that stops without it, so every positive control below breaks mid-stream and is
paired with a completing twin that must stay byte-identical.

NOT EXERCISED: no real upstream was made to drop a connection, and NO CLIENT WAS
RUN against either ending — what an OpenAI-compatible SDK does with the emitted
event is unverified here. `can` means the code permits it.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.proxy import StreamOpenResult, StreamingResult, stream_error_event


def _events(chunks: list[bytes]) -> str:
    return b"".join(chunks).decode()


class TestStreamErrorEvent:
    """The marker itself."""

    def test_it_is_a_parseable_sse_data_event(self):
        raw = stream_error_event(httpx.ReadError("connection reset")).decode()
        assert raw.startswith("data: ")
        assert raw.endswith("\n\n")
        payload = json.loads(raw[len("data: ") :].strip())
        assert payload["error"]["type"] == "upstream_stream_error"
        assert payload["error"]["code"] == "stream_incomplete"

    def test_it_names_the_transport_failure(self):
        raw = stream_error_event(httpx.ReadError("connection reset")).decode()
        assert "ReadError" in raw
        assert "connection reset" in raw

    def test_it_is_NOT_the_done_sentinel(self):
        # `[DONE]` is the upstream's statement that the answer is whole. This is
        # the opposite statement, and emitting both would be incoherent.
        assert b"[DONE]" not in stream_error_event(RuntimeError("boom"))

    def test_the_detail_is_bounded(self):
        raw = stream_error_event(RuntimeError("x" * 5000)).decode()
        assert len(raw) < 600


def _streaming_response_chunks(generator, streaming_result):
    """Drive `_handle_streaming`'s wrapper over a prepared generator."""
    from app.main import _handle_streaming

    open_result = StreamOpenResult(
        generator=generator, streaming_result=streaming_result, status_code=200
    )
    claims = MagicMock(sub="agent-uuid-1")

    async def _run():
        with patch("app.main.stream_chat_completion", AsyncMock(return_value=open_result)), \
             patch("app.main.get_db_conn") as mock_conn, \
             patch("app.main.log_usage", AsyncMock()):
            mock_conn.return_value.__aenter__ = AsyncMock(return_value=MagicMock())
            mock_conn.return_value.__aexit__ = AsyncMock(return_value=False)
            response = await _handle_streaming(
                MagicMock(litellm_url="http://litellm:4000", litellm_master_key="k"),
                {"model": "gpt-4o-mini", "messages": [], "stream": True},
                claims,
                "gpt-4o-mini",
            )
            return [chunk async for chunk in response.body_iterator]

    return _run


class TestTheEndingTheCallerSees:
    @pytest.mark.asyncio
    async def test_positive_control_a_broken_stream_ends_with_an_error_event(self):
        # The fixture that stops WITHOUT the terminal event.
        async def breaks_midway():
            yield b'data: {"choices":[{"delta":{"content":"The three main"}}]}\n\n'
            raise httpx.ReadError("peer closed connection")

        chunks = await _streaming_response_chunks(breaks_midway(), StreamingResult(error=True))()
        body = _events(chunks)

        # The tokens already delivered are still delivered — marked, not discarded.
        assert "The three main" in body
        # And the ending SAYS it is not an ending.
        assert "stream_incomplete" in body
        assert "upstream_stream_error" in body
        # Never claiming completion.
        assert "[DONE]" not in body
        # The marker is last.
        assert json.loads(chunks[-1].decode()[len("data: ") :].strip())["error"]

    @pytest.mark.asyncio
    async def test_twin_a_complete_stream_is_passed_through_untouched(self):
        # The completing fixture, which cannot distinguish the versions: it must
        # stay byte-identical or the marker has started firing on healthy
        # streams, and then it means nothing.
        async def completes():
            yield b'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        chunks = await _streaming_response_chunks(completes(), StreamingResult(completed=True))()
        body = _events(chunks)

        assert body == (
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
            "data: [DONE]\n\n"
        )
        assert "stream_incomplete" not in body

    @pytest.mark.asyncio
    async def test_a_stream_that_breaks_before_any_content_still_says_so(self):
        async def breaks_immediately():
            raise httpx.ConnectError("upstream refused")
            yield b""  # pragma: no cover — makes this an async generator

        chunks = await _streaming_response_chunks(breaks_immediately(), StreamingResult(error=True))()
        body = _events(chunks)

        assert "stream_incomplete" in body
        assert "ConnectError" in body

    @pytest.mark.asyncio
    async def test_the_usage_row_still_records_the_error(self):
        # The half that already worked keeps working: marking the ending must not
        # cost the accounting that #259 credited this path with.
        from app.main import _handle_streaming

        async def breaks_midway():
            yield b'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
            raise httpx.ReadError("peer closed connection")

        open_result = StreamOpenResult(
            generator=breaks_midway(),
            streaming_result=StreamingResult(error=True),
            status_code=200,
        )
        logged = AsyncMock()
        with patch("app.main.stream_chat_completion", AsyncMock(return_value=open_result)), \
             patch("app.main.get_db_conn") as mock_conn, \
             patch("app.main.log_usage", logged):
            mock_conn.return_value.__aenter__ = AsyncMock(return_value=MagicMock())
            mock_conn.return_value.__aexit__ = AsyncMock(return_value=False)
            response = await _handle_streaming(
                MagicMock(litellm_url="http://litellm:4000", litellm_master_key="k"),
                {"model": "gpt-4o-mini", "messages": [], "stream": True},
                MagicMock(sub="agent-uuid-1"),
                "gpt-4o-mini",
            )
            async for _ in response.body_iterator:
                pass

        assert logged.await_count == 1
        assert logged.await_args.kwargs["status"] == "error"
