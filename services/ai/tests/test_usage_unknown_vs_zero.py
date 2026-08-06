"""app#549: a proxy/stream-open failure with NO response ever received must
record UNKNOWN cost (NULL), not zero — a zero looks exactly like a request
that legitimately cost nothing, and nothing downstream ever contradicts it.

THE SHAPE, ESTABLISHED FIRST.

Two truths, not one, live inside "the non-streaming path logs 0 on error":

  1. proxy_chat_completion/proxy_embeddings RAISE before any response body
     was ever received (network fault, timeout). Genuinely UNKNOWN — if
     LiteLLM had already completed its own call to the real provider and
     been billed, this process has no way to know. This is what app#549
     names, on the non-streaming path.

  2. proxy_chat_completion/proxy_embeddings RETURN NORMALLY with a non-2xx
     status. A real response WAS received; parse_usage()/parse_cost() are
     already unconditional on status code in proxy.py, so any usage/cost
     the provider's error response actually carried is already captured
     correctly. Zero here is a KNOWN zero, not a defect — verified by
     reading proxy_chat_completion/proxy_embeddings, not assumed.

This file tests case 1, on BOTH the non-streaming path (app#549's own
subject) and its streaming twin, which app#549 does not name but which has
the identical shape: stream_chat_completion's OPEN call can also raise
before any response is received. Every twin found this week was a missed
sibling of a named issue — checked for here rather than assumed absent.

It also tests a THIRD, narrower case found while checking the streaming
path: stream_chat_completion's non-2xx branch parses `cost_usd` from the
response's real headers, then used to discard it when returning
error_body — recoverable data thrown away, not unknown data. That is
case 2's shape (a real response, real data) with a real bug in it, so it
gets its own test.

NO MIGRATION. model_usage.input_tokens/output_tokens/cost_usd already have
no NOT NULL constraint (migration 004) — a NULL genuinely round-trips
through Postgres distinguishably from a 0. Confirmed against the schema,
not assumed from the column defaults.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app import main as app_main
from app.auth import AgentClaims
from app.main import PolicyResult, chat_completions, embeddings, internal_embeddings, _handle_streaming
from app.proxy import StreamOpenResult, StreamingResult


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


# ---------------------------------------------------------------------------
# Unit level: log_usage itself round-trips None as NULL, at the right
# positional params, without touching the many callers that correctly rely
# on the 0/0.0 default (policy denial, rate limit, budget — no provider call
# was ever attempted for those, so 0 there is a true zero).
# ---------------------------------------------------------------------------


class TestLogUsageUnknownIsNullNotZero:
    @pytest.mark.asyncio
    async def test_explicit_none_lands_as_null_params(self, mock_db_pool):
        from app.usage import log_usage

        pool, conn = mock_db_pool
        conn.execute.return_value = None

        await log_usage(
            conn=conn,
            agent_id="test-agent",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="error",
            latency_ms=50,
            input_tokens=None,
            output_tokens=None,
            cost_usd=None,
        )

        params = conn.execute.call_args[0][1:]
        # Positional order per usage.py's INSERT: agent_id, model_name,
        # request_type, status, latency_ms, input_tokens, output_tokens,
        # cost_usd, delegation_id, owner, requested_model, provider_model_id.
        assert params[5] is None  # input_tokens
        assert params[6] is None  # output_tokens
        assert params[7] is None  # cost_usd

    @pytest.mark.asyncio
    async def test_default_stays_zero_for_the_many_no_call_attempted_callers(self, mock_db_pool):
        """The default MUST stay 0, not flip to None — a policy denial never
        attempts a provider call, so 0 there is a true zero, and changing
        the default would misclassify every denial/rate-limit/budget row in
        this file as 'unknown' instead."""
        from app.usage import log_usage

        pool, conn = mock_db_pool
        conn.execute.return_value = None

        await log_usage(
            conn=conn,
            agent_id="test-agent",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="rate_limited",
            latency_ms=0,
        )

        params = conn.execute.call_args[0][1:]
        assert params[5] == 0
        assert params[6] == 0
        assert params[7] == 0.0


# ---------------------------------------------------------------------------
# Route level: the four call sites where the proxy call itself raised —
# genuinely unknown. There is more than one place that writes model_usage;
# each gets its own test rather than one test asserting "some log_usage call
# somewhere got None", so a mutation at the wrong site is caught precisely.
# ---------------------------------------------------------------------------


class TestNonStreamingChatCompletionsUnknownOnProxyRaise:
    @pytest.mark.asyncio
    async def test_input_output_cost_are_none_not_zero(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        request = _FakeRequest({"model": "gpt-4o-mini", "stream": False})
        claims = _fake_claims()
        mock_log_usage = AsyncMock()

        with (
            patch.object(app_main, "_enforce_policy", AsyncMock(return_value=_fake_policy_result())),
            patch.object(app_main, "_resolve_byok", AsyncMock(side_effect=lambda pr, *a, **kw: pr)),
            patch.object(app_main, "_http_client", object()),
            patch.object(app_main, "get_db_conn"),
            patch.object(
                app_main, "proxy_chat_completion",
                AsyncMock(side_effect=RuntimeError("connection reset")),
            ),
            patch.object(app_main, "log_usage", mock_log_usage),
        ):
            with pytest.raises(Exception):
                await chat_completions(request, claims)

        mock_log_usage.assert_called_once()
        kwargs = mock_log_usage.call_args.kwargs
        assert kwargs["input_tokens"] is None
        assert kwargs["output_tokens"] is None
        assert kwargs["cost_usd"] is None
        assert kwargs["status"] == "error"


class TestStreamingOpenUnknownOnProxyRaise:
    @pytest.mark.asyncio
    async def test_input_output_cost_are_none_not_zero(self, monkeypatch):
        """The twin app#549 does not name: stream_chat_completion's OPEN
        call can raise before any response is received, exactly like
        proxy_chat_completion above — same shape, different function."""
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        mock_log_usage = AsyncMock()

        with (
            patch.object(app_main, "_http_client", object()),
            patch.object(app_main, "get_db_conn"),
            patch.object(
                app_main, "stream_chat_completion",
                AsyncMock(side_effect=RuntimeError("connection reset")),
            ),
            patch.object(app_main, "log_usage", mock_log_usage),
        ):
            with pytest.raises(Exception):
                await _handle_streaming(
                    settings=MagicMock(), body={"model": "gpt-4o-mini"}, claims=_fake_claims(),
                    resolved_model="gpt-4o-mini",
                )

        mock_log_usage.assert_called_once()
        kwargs = mock_log_usage.call_args.kwargs
        assert kwargs["input_tokens"] is None
        assert kwargs["output_tokens"] is None
        assert kwargs["cost_usd"] is None


class TestEmbeddingsUnknownOnProxyRaise:
    @pytest.mark.asyncio
    async def test_input_output_cost_are_none_not_zero(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        request = _FakeRequest({"model": "text-embedding-3-small", "input": "hi"})
        claims = _fake_claims()
        mock_log_usage = AsyncMock()

        with (
            patch.object(app_main, "_enforce_policy", AsyncMock(return_value=_fake_policy_result())),
            patch.object(app_main, "_resolve_byok", AsyncMock(side_effect=lambda pr, *a, **kw: pr)),
            patch.object(app_main, "_http_client", object()),
            patch.object(app_main, "get_db_conn"),
            patch.object(
                app_main, "proxy_embeddings",
                AsyncMock(side_effect=RuntimeError("connection reset")),
            ),
            patch.object(app_main, "log_usage", mock_log_usage),
        ):
            with pytest.raises(Exception):
                await embeddings(request, claims)

        mock_log_usage.assert_called_once()
        kwargs = mock_log_usage.call_args.kwargs
        assert kwargs["input_tokens"] is None
        assert kwargs["output_tokens"] is None
        assert kwargs["cost_usd"] is None


class TestInternalEmbeddingsUnknownOnProxyRaise:
    @pytest.mark.asyncio
    async def test_input_output_cost_are_none_not_zero(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        fake_settings = MagicMock()
        fake_settings.model_router_internal_service_token = "svc-token"
        request = _FakeRequest({"model": "text-embedding-3-small", "input": "hi", "owner": None})
        mock_log_usage = AsyncMock()

        # app#548: internal_embeddings now checks check_rate_limit/check_token_budget
        # before proxy_embeddings ever runs. Both mocked as allowed here — this test
        # is about the proxy-raises shape, not enforcement, which has its own tests
        # in test_internal_embeddings_usage.py.
        from app.limits import BudgetResult, RateLimitResult

        with (
            patch.object(app_main, "get_settings", MagicMock(return_value=fake_settings)),
            patch.object(app_main, "_http_client", object()),
            patch.object(app_main, "get_db_conn"),
            patch.object(
                app_main, "check_rate_limit",
                AsyncMock(return_value=RateLimitResult(allowed=True, count=1, limit=300, retry_after=0)),
            ),
            patch.object(
                app_main, "check_token_budget",
                AsyncMock(return_value=BudgetResult(
                    allowed=True, tokens_used=100, limit=5_000_000, resets_at="2026-01-01T00:00:00+00:00"
                )),
            ),
            patch.object(
                app_main, "proxy_embeddings",
                AsyncMock(side_effect=RuntimeError("connection reset")),
            ),
            patch.object(app_main, "log_usage", mock_log_usage),
        ):
            with pytest.raises(Exception):
                await internal_embeddings(request, authorization="Bearer svc-token")

        mock_log_usage.assert_called_once()
        kwargs = mock_log_usage.call_args.kwargs
        assert kwargs["input_tokens"] is None
        assert kwargs["output_tokens"] is None
        assert kwargs["cost_usd"] is None


# ---------------------------------------------------------------------------
# The recoverable-data case: a real response WAS received (non-2xx), and its
# real cost_usd — already parsed from that response's own headers by
# stream_chat_completion — must survive to the log_usage call rather than
# being silently discarded by the early-return path.
# ---------------------------------------------------------------------------


class TestStreamingNon2xxCostIsPreservedNotDiscarded:
    @pytest.mark.asyncio
    async def test_real_cost_header_survives_to_log_usage(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        mock_log_usage = AsyncMock()
        # A non-2xx StreamOpenResult carrying a real, non-zero cost parsed
        # from the response's own headers — exactly what
        # stream_chat_completion now returns after the fix.
        open_result = StreamOpenResult(
            status_code=429,
            error_body={"error": {"message": "rate limited upstream"}},
            streaming_result=StreamingResult(cost_usd=0.0042),
        )

        with (
            patch.object(app_main, "_http_client", object()),
            patch.object(app_main, "get_db_conn"),
            patch.object(app_main, "stream_chat_completion", AsyncMock(return_value=open_result)),
            patch.object(app_main, "log_usage", mock_log_usage),
        ):
            await _handle_streaming(
                settings=MagicMock(), body={"model": "gpt-4o-mini"}, claims=_fake_claims(),
                resolved_model="gpt-4o-mini",
            )

        mock_log_usage.assert_called_once()
        kwargs = mock_log_usage.call_args.kwargs
        # THE ASSERTION THAT MATTERS: the real header-derived value, not the
        # log_usage default. A test asserting only "cost_usd == 0" would
        # pass whether this fix landed or not, since 0.0042 rounds to
        # nothing that LOOKS wrong at a glance — the point is that it is
        # the REAL value, not log_usage's fallback (which this call site
        # never even reaches, since cost_usd is now passed explicitly).
        assert kwargs["cost_usd"] == 0.0042
        # input_tokens/output_tokens are correctly NOT passed at this call
        # site at all — log_usage's own 0 default is right here, since a
        # non-2xx response before any stream content means no tokens were
        # genuinely generated. Confirms the fix didn't overcorrect into
        # marking a KNOWN zero as unknown too.
        assert "input_tokens" not in kwargs
        assert "output_tokens" not in kwargs
