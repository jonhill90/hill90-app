"""POST /internal/usage — a recording-only endpoint for spend that never
passes through this service at all.

THE GAP IT CLOSES. services/knowledge's embeddings client has a fallback
that calls LiteLLM directly (bypassing /internal/embeddings entirely) when
this service's own path is unavailable or unconfigured. That fallback has
no database connection of its own — services/knowledge's DATABASE_URL is a
different Postgres database (hill90_akm), not the one model_usage lives in
— so there is no way for it to write that row itself. This endpoint gives
it one, service-token authenticated exactly like /internal/embeddings.

THIS IS NOT AN ENFORCEMENT POINT. It runs no check_rate_limit, no
check_token_budget — it is asked to record something that already
happened, by a caller that had no policy to check against for the same
reason /internal/embeddings didn't (a service token carries no agent
claims). That question is filed separately.

THE ASSERTION THAT MATTERS is that a model_usage row is actually written
with the real token count and, when supplied, the real owner — not that
the endpoint returns 200.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest

from app import main as app_main


def conn_ctx(conn):
    @asynccontextmanager
    async def _ctx():
        yield conn
    return _ctx


class _Settings:
    model_router_internal_service_token = "svc-token"


@pytest.mark.asyncio
async def test_internal_usage_records_a_row_with_real_tokens_and_owner(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
    from app.config import get_settings
    get_settings.cache_clear()

    conn = AsyncMock()
    mock_log_usage = AsyncMock()

    with patch.object(app_main, "get_db_conn", conn_ctx(conn)), \
         patch.object(app_main, "log_usage", mock_log_usage), \
         patch.object(app_main, "get_settings", lambda: _Settings()):
        body = app_main.LogUsageRequest(
            model_name="text-embedding-3-small",
            request_type="embedding",
            status="success",
            input_tokens=777,
            output_tokens=0,
            cost_usd=0.0015,
            owner="user-42",
        )
        res = await app_main.log_usage_endpoint(body, authorization="Bearer svc-token")

    assert res["status"] == "recorded"

    # THE ASSERTION THAT MATTERS: the real token count and owner landed in
    # the call to log_usage, not merely that the endpoint answered 200.
    mock_log_usage.assert_called_once()
    _, kwargs = mock_log_usage.call_args
    assert kwargs["input_tokens"] == 777
    assert kwargs["owner"] == "user-42"
    assert kwargs["model_name"] == "text-embedding-3-small"


@pytest.mark.asyncio
async def test_internal_usage_rejects_a_bad_service_token(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
    from app.config import get_settings
    get_settings.cache_clear()

    mock_log_usage = AsyncMock()
    from fastapi import HTTPException

    with patch.object(app_main, "log_usage", mock_log_usage), \
         patch.object(app_main, "get_settings", lambda: _Settings()):
        body = app_main.LogUsageRequest(model_name="m", input_tokens=1)
        with pytest.raises(HTTPException) as exc_info:
            await app_main.log_usage_endpoint(body, authorization="Bearer wrong-token")

    assert exc_info.value.status_code == 403
    mock_log_usage.assert_not_called()
