"""app#396: does services/ai swallow a decrypt failure the way
webhook-dispatch.ts (services/api) used to? Traced the three real call
sites of `decrypt_provider_key` in main.py and this file proves each one
against the ACTUAL code, not the read.

Result up front: all three already fail loud, in three legitimately
different but each-explicit shapes — a 500 for the per-request BYOK
injection path (chat/embeddings), a 400 for /internal/validate-provider,
and a 200 carrying an explicit `error` field for
/internal/list-provider-models (deliberately not an HTTP error status,
so a provider-listing problem doesn't read as a transport failure —
`test_e3_invalid_key_returns_error_shape` in test_list_provider_models.py
already documents that shape, though that specific test only asserts
against a hand-written dict literal, never the real endpoint). None of the
three silently falls back to any other key or serves a request as if
nothing were wrong.
"""

from __future__ import annotations

import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

REAL_KEY = os.urandom(32).hex()
WRONG_KEY = os.urandom(32).hex()
PLAINTEXT = "sk-real-secret-must-not-leak"


def _encrypt(plaintext: str, hex_key: str) -> tuple[bytes, bytes]:
    key = bytes.fromhex(hex_key)
    nonce = os.urandom(12)
    return AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), None), nonce


class TestByokInjectionFailsLoud:
    """_inject_byok_credentials — the per-request path every chat/embeddings
    call with a BYOK model goes through."""

    def test_a_wrong_key_raises_a_500_naming_the_real_cause_in_the_log_only(self, monkeypatch, caplog):
        from app.main import _inject_byok_credentials
        from app.auth import AgentClaims
        from app.models import UserModelInfo

        encrypted, nonce = _encrypt(PLAINTEXT, REAL_KEY)
        model_info = UserModelInfo(
            litellm_model="anthropic/claude-sonnet-4",
            api_key_encrypted=encrypted,
            api_key_nonce=nonce,
            api_base_url=None,
        )
        claims = AgentClaims(sub="agent-1", iss="hill90-api", aud="hill90-model-router", exp=0, iat=0, jti="jti-1")
        body: dict = {}

        import app.config as config_module
        monkeypatch.setattr(
            config_module, "get_settings",
            lambda: type("S", (), {"provider_key_encryption_key": WRONG_KEY})(),
        )
        monkeypatch.setattr("app.main.get_settings", config_module.get_settings)

        with pytest.raises(HTTPException) as exc:
            _inject_byok_credentials(model_info, body, claims, "anthropic/claude-sonnet-4")

        assert exc.value.status_code == 500
        # THE ASSERTION THAT MATTERS: the request is refused, never silently
        # proceeds with no api_key or a fallback one.
        assert "api_key" not in body
        # Never in the client-facing detail — that would leak internals to a
        # caller. Structured logging (already asserted by main.py's own
        # `logger.error("provider_key_decrypt_failed", ...)`) is the right
        # place for the real reason, not the HTTP response.
        assert PLAINTEXT not in str(exc.value.detail)
        assert REAL_KEY not in str(exc.value.detail)
        assert WRONG_KEY not in str(exc.value.detail)


@pytest.mark.asyncio
class TestValidateProviderFailsLoud:
    async def test_a_wrong_key_returns_400_with_no_leak(self):
        from app.main import app
        from httpx import ASGITransport, AsyncClient
        from unittest.mock import patch

        encrypted, nonce = _encrypt(PLAINTEXT, REAL_KEY)

        with patch("app.main.get_settings") as mock_settings:
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.provider_key_encryption_key = WRONG_KEY

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/internal/validate-provider",
                    json={
                        "provider": "anthropic",
                        "api_key_encrypted": encrypted.hex(),
                        "api_key_nonce": nonce.hex(),
                        "api_base_url": None,
                    },
                    headers={"Authorization": "Bearer svc-token"},
                )

        assert resp.status_code == 400
        body = resp.json()
        assert body["detail"] == "Failed to decrypt provider key"
        text = resp.text
        assert PLAINTEXT not in text
        assert REAL_KEY not in text
        assert WRONG_KEY not in text


@pytest.mark.asyncio
class TestListProviderModelsFailsLoudEnough:
    """Deliberately 200, not an HTTP error — but WITH an explicit `error`
    field a caller is expected to check. See the module docstring: this is
    a real, existing, correct design choice, not the defect this file
    exists to find. The defect this drove into services/api's own route
    (dropping this exact field) is fixed and tested separately there."""

    async def test_a_wrong_key_returns_200_but_with_an_explicit_error_field_and_no_leak(self):
        from app.main import app
        from httpx import ASGITransport, AsyncClient
        from unittest.mock import patch

        encrypted, nonce = _encrypt(PLAINTEXT, REAL_KEY)

        with patch("app.main.get_settings") as mock_settings:
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.provider_key_encryption_key = WRONG_KEY

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/internal/list-provider-models",
                    json={
                        "provider": "anthropic",
                        "api_key_encrypted": encrypted.hex(),
                        "api_key_nonce": nonce.hex(),
                        "api_base_url": None,
                    },
                    headers={"Authorization": "Bearer svc-token"},
                )

        assert resp.status_code == 200
        body = resp.json()
        assert body["models"] == []
        # THE ASSERTION THAT MATTERS: an explicit signal survives, it is not
        # merely "here is an empty list" — the exact field services/api's
        # own /models route was dropping before app#396's fix there.
        assert body.get("error") == "Failed to decrypt provider key"
        text = resp.text
        assert PLAINTEXT not in text
        assert REAL_KEY not in text
        assert WRONG_KEY not in text
