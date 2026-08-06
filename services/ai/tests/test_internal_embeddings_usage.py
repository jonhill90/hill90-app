"""/internal/embeddings must record usage the way every other model-router
path does.

THE GAP. This endpoint is authenticated by a shared internal service token,
not AgentClaims, and it proxies straight to LiteLLM — services/knowledge
calls it to embed ingested content. Unlike every agent-facing path
(/v1/chat/completions, /v1/embeddings), it never called check_rate_limit,
check_token_budget, OR log_usage: the spend happened and nothing recorded
that it did. Whether a LIMIT should apply here — whose budget it counts
against, what happens to ingestion when exhausted — is a real design
question, filed separately rather than decided here. This fix is the
uncontroversial half: the spend must be visible and attributable, which
needs no policy decision at all.

THE ASSERTION THAT MATTERS is not that the call succeeds — it always did.
It is that a model_usage row gets written, with the real token count
attributed, not merely that the request returned 200.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app import main as app_main


class FakeRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def conn_ctx(conn):
    @asynccontextmanager
    async def _ctx():
        yield conn
    return _ctx


class _Settings:
    model_router_internal_service_token = "svc-token"
    litellm_url = "http://litellm:4000"
    litellm_master_key = "master-key"


@pytest.mark.asyncio
async def test_internal_embeddings_records_usage_with_real_token_counts(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
    from app.config import get_settings
    get_settings.cache_clear()

    conn = AsyncMock()
    mock_log_usage = AsyncMock()
    mock_proxy = AsyncMock(return_value={
        "status_code": 200, "body": {"data": []}, "headers": {},
        "input_tokens": 1234, "output_tokens": 0, "cost_usd": 0.002,
    })

    with patch.object(app_main, "get_db_conn", conn_ctx(conn)), \
         patch.object(app_main, "log_usage", mock_log_usage), \
         patch.object(app_main, "proxy_embeddings", mock_proxy), \
         patch.object(app_main, "get_settings", lambda: _Settings()), \
         patch.object(app_main, "_http_client", MagicMock()):
        req = FakeRequest({"model": "text-embedding-3-small", "input": ["hello world"]})
        res = await app_main.internal_embeddings(req, authorization="Bearer svc-token")

    assert res.status_code == 200

    # THE ASSERTION THAT MATTERS: a usage row was actually written, with the
    # real token count attributed — not merely that the request succeeded.
    mock_log_usage.assert_called_once()
    _, kwargs = mock_log_usage.call_args
    assert kwargs["input_tokens"] == 1234
    assert kwargs["model_name"] == "text-embedding-3-small"
    assert kwargs["request_type"] == "embedding"
    assert kwargs["status"] == "success"


@pytest.mark.asyncio
async def test_internal_embeddings_records_usage_on_upstream_error(monkeypatch):
    """A proxy exception must also be recorded — same shape as /v1/embeddings'
    identical error path — so a failed internal call is not silently invisible
    either."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
    from app.config import get_settings
    get_settings.cache_clear()

    conn = AsyncMock()
    mock_log_usage = AsyncMock()

    with patch.object(app_main, "get_db_conn", conn_ctx(conn)), \
         patch.object(app_main, "log_usage", mock_log_usage), \
         patch.object(app_main, "proxy_embeddings", AsyncMock(side_effect=RuntimeError("litellm unreachable"))), \
         patch.object(app_main, "get_settings", lambda: _Settings()), \
         patch.object(app_main, "_http_client", MagicMock()):
        req = FakeRequest({"model": "text-embedding-3-small", "input": ["hello"]})
        with pytest.raises(Exception):
            await app_main.internal_embeddings(req, authorization="Bearer svc-token")

    mock_log_usage.assert_called_once()
    _, kwargs = mock_log_usage.call_args
    assert kwargs["status"] == "error"
