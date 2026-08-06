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
from app.limits import BudgetResult, RateLimitResult


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
    internal_embeddings_max_rpm = 300
    internal_embeddings_max_tokens_per_day = 5_000_000


_ALLOWED_RATE = AsyncMock(return_value=RateLimitResult(allowed=True, count=1, limit=300, retry_after=0))
_ALLOWED_BUDGET = AsyncMock(
    return_value=BudgetResult(allowed=True, tokens_used=100, limit=5_000_000, resets_at="2026-01-01T00:00:00+00:00")
)


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
         patch.object(app_main, "check_rate_limit", _ALLOWED_RATE), \
         patch.object(app_main, "check_token_budget", _ALLOWED_BUDGET), \
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
async def test_internal_embeddings_propagates_upstream_error_status(monkeypatch):
    """app#454. This is the producer side of the fix, not the consumer's

    reaction to it: proxy_embeddings returning a non-200 result must make
    THIS endpoint's own response carry that status, not silently default to
    200 because FastAPI's JSONResponse does when status_code is omitted.
    (The 429 arms above are this endpoint raising its OWN rate limit before
    ever calling proxy_embeddings — they say nothing about propagating a
    status LiteLLM itself returned.) Reverting the status_code=... argument
    at the JSONResponse call in main.py must fail this exact assertion.
    """
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
    from app.config import get_settings
    get_settings.cache_clear()

    conn = AsyncMock()
    mock_log_usage = AsyncMock()
    mock_proxy = AsyncMock(return_value={
        "status_code": 500, "body": {"error": {"message": "upstream failure"}}, "headers": {},
        "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0,
    })

    with patch.object(app_main, "get_db_conn", conn_ctx(conn)), \
         patch.object(app_main, "log_usage", mock_log_usage), \
         patch.object(app_main, "proxy_embeddings", mock_proxy), \
         patch.object(app_main, "check_rate_limit", _ALLOWED_RATE), \
         patch.object(app_main, "check_token_budget", _ALLOWED_BUDGET), \
         patch.object(app_main, "get_settings", lambda: _Settings()), \
         patch.object(app_main, "_http_client", MagicMock()):
        req = FakeRequest({"model": "text-embedding-3-small", "input": ["hello world"]})
        res = await app_main.internal_embeddings(req, authorization="Bearer svc-token")

    assert res.status_code == 500

    mock_log_usage.assert_called_once()
    _, kwargs = mock_log_usage.call_args
    assert kwargs["status"] == "error"


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
         patch.object(app_main, "check_rate_limit", _ALLOWED_RATE), \
         patch.object(app_main, "check_token_budget", _ALLOWED_BUDGET), \
         patch.object(app_main, "get_settings", lambda: _Settings()), \
         patch.object(app_main, "_http_client", MagicMock()):
        req = FakeRequest({"model": "text-embedding-3-small", "input": ["hello"]})
        with pytest.raises(Exception):
            await app_main.internal_embeddings(req, authorization="Bearer svc-token")

    mock_log_usage.assert_called_once()
    _, kwargs = mock_log_usage.call_args
    assert kwargs["status"] == "error"


# app#548 — THE ENFORCEMENT GAP ITSELF. Before this fix, nothing here ever
# called check_rate_limit or check_token_budget at all, so no value of
# either could ever block a call. THE ASSERTION THAT MATTERS is that
# proxy_embeddings — the thing that actually spends money — is never
# reached when either check denies, not just that a 429 comes back.
@pytest.mark.asyncio
async def test_internal_embeddings_blocks_when_rate_limited(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
    from app.config import get_settings
    get_settings.cache_clear()

    conn = AsyncMock()
    mock_log_usage = AsyncMock()
    mock_proxy = AsyncMock()
    denied_rate = AsyncMock(return_value=RateLimitResult(allowed=False, count=300, limit=300, retry_after=42))

    with patch.object(app_main, "get_db_conn", conn_ctx(conn)), \
         patch.object(app_main, "log_usage", mock_log_usage), \
         patch.object(app_main, "proxy_embeddings", mock_proxy), \
         patch.object(app_main, "check_rate_limit", denied_rate), \
         patch.object(app_main, "check_token_budget", _ALLOWED_BUDGET), \
         patch.object(app_main, "get_settings", lambda: _Settings()), \
         patch.object(app_main, "_http_client", MagicMock()):
        req = FakeRequest({"model": "text-embedding-3-small", "input": ["hello"]})
        res = await app_main.internal_embeddings(req, authorization="Bearer svc-token")

    assert res.status_code == 429
    mock_proxy.assert_not_called()
    mock_log_usage.assert_called_once()
    _, kwargs = mock_log_usage.call_args
    assert kwargs["status"] == "rate_limited"
    assert kwargs["agent_id"] == app_main.INTERNAL_EMBEDDINGS_AGENT_ID


@pytest.mark.asyncio
async def test_internal_embeddings_blocks_when_budget_exhausted(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
    from app.config import get_settings
    get_settings.cache_clear()

    conn = AsyncMock()
    mock_log_usage = AsyncMock()
    mock_proxy = AsyncMock()
    denied_budget = AsyncMock(
        return_value=BudgetResult(
            allowed=False, tokens_used=5_000_000, limit=5_000_000, resets_at="2026-01-01T00:00:00+00:00"
        )
    )

    with patch.object(app_main, "get_db_conn", conn_ctx(conn)), \
         patch.object(app_main, "log_usage", mock_log_usage), \
         patch.object(app_main, "proxy_embeddings", mock_proxy), \
         patch.object(app_main, "check_rate_limit", _ALLOWED_RATE), \
         patch.object(app_main, "check_token_budget", denied_budget), \
         patch.object(app_main, "get_settings", lambda: _Settings()), \
         patch.object(app_main, "_http_client", MagicMock()):
        req = FakeRequest({"model": "text-embedding-3-small", "input": ["hello"]})
        res = await app_main.internal_embeddings(req, authorization="Bearer svc-token")

    assert res.status_code == 429
    mock_proxy.assert_not_called()
    mock_log_usage.assert_called_once()
    _, kwargs = mock_log_usage.call_args
    assert kwargs["status"] == "budget_exceeded"
