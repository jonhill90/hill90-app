"""Tests for app.ws_terminal — WebSocket PTY relay."""

import asyncio
import json
import logging
import os
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute

from app.ws_terminal import _pty_reader, ws_terminal_handler


WORK_TOKEN = "test-token-123"


def _create_test_app():
    async def ws_endpoint(websocket):
        await ws_terminal_handler(websocket, WORK_TOKEN)

    return Starlette(routes=[
        WebSocketRoute("/terminal/ws", ws_endpoint),
    ])


class TestWsTerminalAuth:
    def test_rejects_missing_token(self):
        app = _create_test_app()
        client = TestClient(app)
        with pytest.raises(Exception):
            with client.websocket_connect("/terminal/ws"):
                pass

    def test_rejects_wrong_token(self):
        app = _create_test_app()
        client = TestClient(app)
        with pytest.raises(Exception):
            with client.websocket_connect("/terminal/ws?token=wrong"):
                pass

    def test_rejects_no_work_token_configured(self):
        async def ws_endpoint(websocket):
            await ws_terminal_handler(websocket, None)

        app = Starlette(routes=[
            WebSocketRoute("/terminal/ws", ws_endpoint),
        ])
        client = TestClient(app)
        with pytest.raises(Exception):
            with client.websocket_connect("/terminal/ws?token=anything"):
                pass

    # THE ASSERTION THAT MATTERS (cross-service sibling-drift sweep, same
    # finding as runtime.py's _check_auth — see that file's identical
    # comment). Plain `token != work_token` is a timing side-channel on the
    # same WORK_TOKEN secret; the api's own comparable check
    # (chat.ts, crypto.timingSafeEqual) is constant-time. Functional
    # correctness is already covered above; this is the only test that can
    # tell "constant-time" from "happens to return the same answer."
    def test_auth_uses_constant_time_comparison(self):
        import hmac as hmac_module
        from unittest.mock import patch

        app = _create_test_app()
        client = TestClient(app)
        with patch.object(hmac_module, "compare_digest", wraps=hmac_module.compare_digest) as spy:
            # A correct token passes auth and proceeds to spawn a PTY, which
            # may itself fail in a sandboxed test environment for reasons
            # unrelated to auth — irrelevant here, only whether the auth
            # check itself used a constant-time comparison.
            try:
                with client.websocket_connect(f"/terminal/ws?token={WORK_TOKEN}"):
                    pass
            except Exception:
                pass
        assert spy.called, "expected the token check to call hmac.compare_digest, not a plain !="


class TestWsTerminalResize:
    def test_resize_message_format(self):
        """Verify resize control message is valid JSON with expected fields."""
        msg = json.dumps({"type": "resize", "cols": 80, "rows": 24})
        parsed = json.loads(msg)
        assert parsed["type"] == "resize"
        assert parsed["cols"] == 80
        assert parsed["rows"] == 24


class TestPtyReaderUnexpectedFailureIsVisible:
    """#347 Defect 1: _pty_reader's catch-all logged at DEBUG while
    server.py runs the process at INFO (logging.basicConfig(level=logging.INFO)),
    so an unexpected reader failure was caught — no crash — but never reached
    any log output. Reproduces the real logger name and the real process log
    level rather than a generic default.
    """

    @pytest.mark.asyncio
    async def test_unexpected_exception_is_visible_at_process_log_level(self, caplog):
        caplog.set_level(logging.INFO, logger="app.ws_terminal")

        with patch("app.ws_terminal.select.select", side_effect=RuntimeError("boom")):
            await _pty_reader(master_fd=0, websocket=None)

        assert any("PTY reader stopped" in r.message for r in caplog.records), (
            "the failure was logged below the process's configured level and "
            "never reached output — see #347 Defect 1"
        )


class _HangingWebSocket:
    """A fake WebSocket whose `receive()` blocks forever — the shape of a
    real client that is sitting there, connected, having sent nothing
    further. `close()` and `send_bytes()` are recorded so the test can
    assert on whether the client was ever actually told anything.
    """

    def __init__(self, token: str):
        self.query_params = {"token": token}
        self.closed_with: tuple[int, str] | None = None
        self.sent_bytes: list[bytes] = []
        self._accepted = asyncio.Event()

    async def accept(self):
        self._accepted.set()

    async def receive(self):
        # A real client that has gone quiet — this is the state the main
        # WebSocket -> PTY loop sits in indefinitely once nothing more
        # arrives from the browser.
        await asyncio.sleep(3600)

    async def send_bytes(self, data: bytes):
        self.sent_bytes.append(data)

    async def close(self, code: int = 1000, reason: str = ""):
        self.closed_with = (code, reason)


class TestReaderTaskDeathIsInvisibleToTheSession:
    """services/agentbox/app/ws_terminal.py:125 — the per-session PTY reader
    task, one per live terminal a human is actually watching. Different in
    kind from the two background daemon loops #402/#403 already fixed:
    those were about an unretrieved exception risking the whole process:
    this is about whether a SINGLE SESSION notices its own reader dying.

    Mocks only what's needed to drive ws_terminal_handler's real control
    flow without an actual fork: os.fork always returns a fake nonzero pid
    (the child branch, which would os.execvpe and replace this test
    process, must never execute), pty.openpty returns a real pipe pair so
    fd operations succeed naturally, fcntl.ioctl is a no-op because a pipe
    is not a tty. _pty_reader itself is replaced with a stub that returns
    almost immediately — modelling PTY EOF, a caught-and-logged exception,
    or any other way the real reader ends without raising past its own
    top-level try/except (which #347 already proved happens for every
    failure mode it can hit).
    """

    @pytest.mark.asyncio
    async def test_reader_task_ending_does_not_close_the_socket_or_notify_the_client(self):
        read_fd, write_fd = os.pipe()

        async def dead_reader(master_fd, websocket):
            # The reader ends immediately — PTY EOF, or any exception
            # already caught and logged inside the real _pty_reader.
            return

        ws = _HangingWebSocket(WORK_TOKEN)

        with (
            patch("app.ws_terminal.os.fork", return_value=424242),
            patch("app.ws_terminal.pty.openpty", return_value=(read_fd, write_fd)),
            patch("app.ws_terminal.fcntl.ioctl", return_value=None),
            patch("app.ws_terminal._pty_reader", dead_reader),
        ):
            handler_task = asyncio.create_task(ws_terminal_handler(ws, WORK_TOKEN))
            try:
                # Give the (stubbed) reader every chance to finish and the
                # event loop every chance to react to it.
                await asyncio.sleep(0.2)

                # THE ASSERTION THAT MATTERS, stated as the FIXED behaviour
                # this test is written to demand — not the current one.
                # Before the fix: the reader has already ended (dead_reader
                # returns instantly), and nothing in ws_terminal_handler
                # looks at reader_task again until its own teardown
                # `finally`, which only runs once the main receive() loop
                # exits on its own. The main loop stays parked in
                # receive(), so the client is never closed, never sent an
                # error, never told anything — a "frozen but connected"
                # session. This assertion fails against that code and
                # passes once the handler notices the reader ending and
                # closes the socket instead of waiting indefinitely.
                assert ws.closed_with is not None, (
                    "the reader task ended and the socket was never closed — "
                    "the client is left connected to a dead relay with no "
                    "error and no close frame"
                )
                assert handler_task.done(), (
                    "the handler is still parked in receive() with a dead "
                    "reader — it should have noticed and torn the session "
                    "down"
                )
            finally:
                handler_task.cancel()
                try:
                    await handler_task
                except asyncio.CancelledError:
                    pass
                for fd in (read_fd, write_fd):
                    try:
                        os.close(fd)
                    except OSError:
                        pass


class _ScriptedWebSocket:
    """A fake WebSocket that yields a fixed sequence of client messages,
    then hangs — like a real client that sent a couple of things and is now
    just sitting there. Used to prove the new receive()-vs-reader_task race
    in the main loop still relays real messages normally when the reader is
    alive and well, not just that it reacts correctly when the reader dies.
    """

    def __init__(self, token: str, messages: list[dict]):
        self.query_params = {"token": token}
        self._messages = list(messages)
        self.closed_with: tuple[int, str] | None = None

    async def accept(self):
        pass

    async def receive(self):
        if self._messages:
            return self._messages.pop(0)
        await asyncio.sleep(3600)

    async def send_bytes(self, data: bytes):
        pass

    async def close(self, code: int = 1000, reason: str = ""):
        self.closed_with = (code, reason)


class TestNormalRelayStillWorksWithTheReaderRace:
    """Regression cover for the fix above: racing receive() against
    reader_task must not change behaviour for the ordinary case where the
    reader is alive and the client is sending real input.
    """

    @pytest.mark.asyncio
    async def test_bytes_message_is_still_written_to_the_pty_while_the_reader_lives(self):
        read_fd, master_fd = os.pipe()  # master_fd is the "PTY" the main loop writes into
        throwaway_r, throwaway_w = os.pipe()  # stands in for slave_fd, just needs closing

        async def alive_reader(master_fd, websocket):
            await asyncio.sleep(3600)  # never completes during the test

        ws = _ScriptedWebSocket(WORK_TOKEN, [{"type": "websocket.receive", "bytes": b"echo hi\n"}])

        with (
            patch("app.ws_terminal.os.fork", return_value=424243),
            patch("app.ws_terminal.pty.openpty", return_value=(master_fd, throwaway_w)),
            patch("app.ws_terminal.fcntl.ioctl", return_value=None),
            patch("app.ws_terminal._pty_reader", alive_reader),
        ):
            handler_task = asyncio.create_task(ws_terminal_handler(ws, WORK_TOKEN))
            try:
                await asyncio.sleep(0.2)

                # THE ASSERTION THAT MATTERS: the bytes the client sent
                # really were written to the fd the shell would read from —
                # the new receive()-vs-reader_task race did not swallow or
                # delay a real message.
                written = os.read(read_fd, 4096)
                assert written == b"echo hi\n"

                # And with the reader still alive and no disconnect, the
                # session is exactly as open as before — this fix only acts
                # when the reader has actually ended.
                assert ws.closed_with is None
                assert not handler_task.done()
            finally:
                handler_task.cancel()
                try:
                    await handler_task
                except asyncio.CancelledError:
                    pass
                for fd in (read_fd, master_fd, throwaway_r, throwaway_w):
                    try:
                        os.close(fd)
                    except OSError:
                        pass
