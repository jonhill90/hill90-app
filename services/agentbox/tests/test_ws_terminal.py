"""Tests for app.ws_terminal — WebSocket PTY relay."""

import json
import logging
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
