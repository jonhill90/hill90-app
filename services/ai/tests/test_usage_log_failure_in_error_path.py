"""app.main's non-streaming error paths (chat_completions, embeddings) —
code that only runs once the upstream LiteLLM proxy call has already failed.

THE DEFECT. usage.py's own docstring states the invariant plainly: "Every
caller wraps this in a handler that logs and continues — correct, because a
metering failure must not fail an inference the user is waiting on." Both
success-path calls in this file honour that. The two ERROR-path calls
(inside `except Exception as e:` after `proxy_chat_completion`/
`proxy_embeddings` itself raises) did not — a bare, unguarded `await
log_usage(...)` sat between catching the real failure and raising the
deliberate `HTTPException(502, "LiteLLM proxy error")`. If log_usage raised
(the same DB-blip class it's meant to survive), that new exception replaced
the intended 502 entirely — an unhandled crash instead of a clean, correct
error response, and the operator loses the actual "LiteLLM proxy error"
diagnostic.

WHAT THIS TEST PROVES. That a failing usage-log write in the error path
does not replace the deliberate HTTPException(502, ...). It does not
exercise auth, policy enforcement, or BYOK resolution — those are bypassed
by calling the route function directly with pre-built dependencies, matching
how this defect lives entirely inside the function body after those steps
already succeeded.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.auth import AgentClaims
from app import main as app_main
from app.main import PolicyResult, chat_completions, embeddings


class _FakeRequest:
    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


def _fake_claims():
    return AgentClaims(
        sub="agent-1", iss="hill90-ai", aud="hill90-ai", exp=9999999999, iat=0, jti="jti-1",
    )


def _fake_policy_result(**overrides):
    defaults = dict(
        resolved_model="gpt-4o-mini",
        delegation_id=None,
        owner="user-1",
        requested_model="gpt-4o-mini",
        provider_model_id=None,
    )
    defaults.update(overrides)
    return PolicyResult(**defaults)


class TestChatCompletionsErrorPathSurvivesAFailingUsageLog:
    @pytest.mark.asyncio
    async def test_a_failing_usage_log_write_does_not_eclipse_the_proxy_error(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        request = _FakeRequest({"model": "gpt-4o-mini", "stream": False})
        claims = _fake_claims()

        with (
            patch.object(app_main, "_enforce_policy", AsyncMock(return_value=_fake_policy_result())),
            patch.object(app_main, "_resolve_byok", AsyncMock(side_effect=lambda pr, *a, **kw: pr)),
            patch.object(app_main, "_http_client", object()),
            patch.object(app_main, "get_db_conn"),
            patch.object(
                app_main,
                "proxy_chat_completion",
                AsyncMock(side_effect=RuntimeError("litellm unreachable")),
            ),
            patch.object(
                app_main,
                "log_usage",
                AsyncMock(side_effect=RuntimeError("usage table pool exhausted")),
            ),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await chat_completions(request, claims)

        # THE ASSERTION THAT MATTERS: the deliberate 502 survives a failing
        # usage-log write, not whatever log_usage's own exception was.
        assert exc_info.value.status_code == 502
        assert exc_info.value.detail == "LiteLLM proxy error"


class TestEmbeddingsErrorPathSurvivesAFailingUsageLog:
    @pytest.mark.asyncio
    async def test_a_failing_usage_log_write_does_not_eclipse_the_proxy_error(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        request = _FakeRequest({"model": "text-embedding-3-small", "input": "hi"})
        claims = _fake_claims()

        with (
            patch.object(app_main, "_enforce_policy", AsyncMock(return_value=_fake_policy_result())),
            patch.object(app_main, "_resolve_byok", AsyncMock(side_effect=lambda pr, *a, **kw: pr)),
            patch.object(app_main, "_http_client", object()),
            patch.object(app_main, "get_db_conn"),
            patch.object(
                app_main,
                "proxy_embeddings",
                AsyncMock(side_effect=RuntimeError("litellm unreachable")),
            ),
            patch.object(
                app_main,
                "log_usage",
                AsyncMock(side_effect=RuntimeError("usage table pool exhausted")),
            ),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await embeddings(request, claims)

        assert exc_info.value.status_code == 502
        assert exc_info.value.detail == "LiteLLM proxy error"
