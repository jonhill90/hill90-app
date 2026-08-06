"""Usage attribution for the two ways this module can incur real spend.

THE GAP THIS CLOSES. app#548 traced this module's downstream calls:
`_via_model_router` reaches services/ai's /internal/embeddings, and
`_via_litellm` bypasses the ai service entirely and calls LiteLLM directly.
Neither carried any identity for the spend they caused — /internal/embeddings
has since gained an optional `owner` field it stores on the existing
model_usage.owner column (no migration needed), and this module is the
other half: it needs to actually SEND that identity when its caller has
one, and — for the direct-LiteLLM path, which has no database connection
to model_usage at all — report the spend back to the ai service's
/internal/usage endpoint so it lands in the same table by another route.

THE ASSERTION THAT MATTERS in each test is what was actually SENT over the
wire (the owner field in the request body posted to /internal/embeddings;
the real token count and owner in the request posted to /internal/usage),
not merely that generate_embeddings() returned a result.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import embeddings as embeddings_mod


def _mock_client_returning(status_code: int, json_body: dict) -> AsyncMock:
    """A mock httpx.AsyncClient whose .post() always returns this response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_body
    resp.text = str(json_body)

    client = AsyncMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(return_value=resp)
    return client


class TestViaModelRouterOwnerAttribution:
    @pytest.mark.asyncio
    async def test_sends_owner_in_the_request_body_when_given(self, monkeypatch):
        monkeypatch.setattr(embeddings_mod, "MODEL_ROUTER_INTERNAL_SERVICE_TOKEN", "svc-token")
        client = _mock_client_returning(200, {
            "body": {"data": [{"embedding": [0.1, 0.2]}]},
        })
        with patch("httpx.AsyncClient", return_value=client):
            result = await embeddings_mod.generate_embeddings(["hello"], owner="user-42")

        assert result == [[0.1, 0.2]]
        # THE ASSERTION THAT MATTERS: the real owner reached the request body,
        # not just that embeddings came back.
        _, kwargs = client.post.call_args
        assert kwargs["json"]["owner"] == "user-42"

    @pytest.mark.asyncio
    async def test_omits_owner_entirely_when_none_given(self, monkeypatch):
        """No owner available is a real, honest case — must not send a
        fabricated one, and must not send the literal string "None"."""
        monkeypatch.setattr(embeddings_mod, "MODEL_ROUTER_INTERNAL_SERVICE_TOKEN", "svc-token")
        client = _mock_client_returning(200, {
            "body": {"data": [{"embedding": [0.1]}]},
        })
        with patch("httpx.AsyncClient", return_value=client):
            await embeddings_mod.generate_embeddings(["hello"])

        _, kwargs = client.post.call_args
        assert "owner" not in kwargs["json"]


class TestViaModelRouterStatusPropagation:
    """app#454. /internal/embeddings used to always answer 200, so this
    caller's own status check (`if resp.status_code != 200: log the real
    upstream status`) was unreachable — execution fell through to
    `body["data"]`, KeyError'd on an error-shaped payload, and the broad
    `except` caught that and returned the same `None` the status check
    would have. Both branches return `None` either way, so a test that
    only asserts the return value would pass identically before and after
    the fix. THE ASSERTION THAT MATTERS is which branch actually ran —
    read from which log message fired, not from the return value."""

    @pytest.mark.asyncio
    async def test_post_fix_shape_a_real_non_200_status_is_logged_specifically(self, monkeypatch, caplog):
        """/internal/embeddings, fixed, now propagates the real upstream
        status — a 429 arrives as a 429, not a defaulted 200."""
        monkeypatch.setattr(embeddings_mod, "MODEL_ROUTER_INTERNAL_SERVICE_TOKEN", "svc-token")
        client = _mock_client_returning(429, {"error": "rate limited"})

        with patch("httpx.AsyncClient", return_value=client):
            import logging
            with caplog.at_level(logging.WARNING):
                result = await embeddings_mod._via_model_router(["hello"])

        assert result is None
        # THE ASSERTION THAT MATTERS: the specific, informative branch ran —
        # naming the real status — not the generic exception branch both
        # branches would otherwise produce identically.
        messages = [r.message for r in caplog.records]
        assert any("AI service embedding failed" in m and "429" in m for m in messages)
        assert not any("AI service embedding error" in m for m in messages)

    @pytest.mark.asyncio
    async def test_control_pre_fix_shape_the_same_failure_reaches_the_wrong_branch(self, monkeypatch, caplog):
        """CONTROL, reproducing the pre-fix defect directly rather than
        describing it: a defaulted-200 response carrying an error-shaped
        body (no "data" key under "body") — exactly what /internal/embeddings
        used to send regardless of what LiteLLM actually returned. Proves
        the status-check branch was genuinely unreachable in that shape,
        not merely assumed to be."""
        monkeypatch.setattr(embeddings_mod, "MODEL_ROUTER_INTERNAL_SERVICE_TOKEN", "svc-token")
        client = _mock_client_returning(200, {"body": {"error": "rate limited"}})

        with patch("httpx.AsyncClient", return_value=client):
            import logging
            with caplog.at_level(logging.WARNING):
                result = await embeddings_mod._via_model_router(["hello"])

        assert result is None
        # Same return value as the fixed-shape test above — the return
        # value alone cannot distinguish these. The branch can.
        messages = [r.message for r in caplog.records]
        assert any("AI service embedding error" in m for m in messages)
        assert not any("AI service embedding failed" in m for m in messages)


class TestViaLiteLLMFallbackReportsUsage:
    @pytest.mark.asyncio
    async def test_reports_real_token_count_and_owner_to_internal_usage(self, monkeypatch):
        """The direct-LiteLLM path has no database connection of its own —
        it must report what it spent back to the ai service so the spend
        does not simply vanish."""
        monkeypatch.setattr(embeddings_mod, "MODEL_ROUTER_INTERNAL_SERVICE_TOKEN", "svc-token")
        monkeypatch.setattr(embeddings_mod, "LITELLM_MASTER_KEY", "litellm-key")

        router_client = AsyncMock()
        router_client.__aenter__ = AsyncMock(return_value=router_client)
        router_client.__aexit__ = AsyncMock(return_value=False)
        router_client.post = AsyncMock(side_effect=Exception("ai service unreachable"))

        litellm_resp = MagicMock()
        litellm_resp.status_code = 200
        litellm_resp.json.return_value = {
            "data": [{"embedding": [0.3, 0.4]}],
            "usage": {"prompt_tokens": 42},
        }
        litellm_client = AsyncMock()
        litellm_client.__aenter__ = AsyncMock(return_value=litellm_client)
        litellm_client.__aexit__ = AsyncMock(return_value=False)
        litellm_client.post = AsyncMock(return_value=litellm_resp)

        usage_resp = MagicMock()
        usage_resp.status_code = 200
        usage_client = AsyncMock()
        usage_client.__aenter__ = AsyncMock(return_value=usage_client)
        usage_client.__aexit__ = AsyncMock(return_value=False)
        usage_client.post = AsyncMock(return_value=usage_resp)

        # Three httpx.AsyncClient() calls happen in order: the failed
        # model-router attempt, the LiteLLM fallback call, then the usage
        # report call.
        with patch("httpx.AsyncClient", side_effect=[router_client, litellm_client, usage_client]):
            result = await embeddings_mod.generate_embeddings(["hello world"], owner="user-7")

        assert result == [[0.3, 0.4]]

        # THE ASSERTION THAT MATTERS: a usage report actually went out, with
        # the real token count LiteLLM reported and the real owner — not
        # merely that embeddings were returned.
        usage_client.post.assert_called_once()
        call_args, call_kwargs = usage_client.post.call_args
        assert "/internal/usage" in call_args[0]
        body = call_kwargs["json"]
        assert body["input_tokens"] == 42
        assert body["owner"] == "user-7"

    @pytest.mark.asyncio
    async def test_warns_loudly_instead_of_reporting_when_no_service_token_exists(self, monkeypatch, caplog):
        """No MODEL_ROUTER_INTERNAL_SERVICE_TOKEN means no credential to
        report usage with either — this spend really is untracked, and that
        must be loud, not silent."""
        monkeypatch.setattr(embeddings_mod, "MODEL_ROUTER_INTERNAL_SERVICE_TOKEN", "")
        monkeypatch.setattr(embeddings_mod, "LITELLM_MASTER_KEY", "litellm-key")

        litellm_resp = MagicMock()
        litellm_resp.status_code = 200
        litellm_resp.json.return_value = {
            "data": [{"embedding": [0.5]}],
            "usage": {"prompt_tokens": 9},
        }
        litellm_client = AsyncMock()
        litellm_client.__aenter__ = AsyncMock(return_value=litellm_client)
        litellm_client.__aexit__ = AsyncMock(return_value=False)
        litellm_client.post = AsyncMock(return_value=litellm_resp)

        with patch("httpx.AsyncClient", return_value=litellm_client) as mock_ctor:
            import logging
            with caplog.at_level(logging.WARNING):
                result = await embeddings_mod.generate_embeddings(["hi"], owner="user-1")

        assert result == [[0.5]]
        # Only the one LiteLLM call — no second httpx.AsyncClient() for a
        # usage report that has no credential to send.
        assert mock_ctor.call_count == 1
        assert any("cannot be recorded" in r.message for r in caplog.records)
