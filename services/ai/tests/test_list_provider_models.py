"""Tests for POST /internal/list-provider-models endpoint."""

import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.model_type_detect import detect_model_type

# Found during a "tests that cannot fail" sweep across hill90-app's test
# suites, dispatched in this conversation. E3 and E4 below each asserted
# against a hand-written dict literal the test itself constructed — no
# app code was ever invoked, so both passed regardless of what the real
# endpoint does. The unused `mock_settings` fixture and `MagicMock` import
# this file used to carry are themselves evidence: this was clearly meant
# to become a real endpoint test and never got there.
REAL_KEY = os.urandom(32).hex()
PLAINTEXT = "sk-real-secret-must-not-leak"


def _encrypt(plaintext: str, hex_key: str) -> tuple[bytes, bytes]:
    key = bytes.fromhex(hex_key)
    nonce = os.urandom(12)
    return AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), None), nonce


class TestListProviderModels:
    """E1-E6: Provider model listing with detection."""

    def test_e1_openai_models_detection(self):
        """E1: OpenAI models get correct detected_type."""
        result = detect_model_type("openai/gpt-4o")
        assert result.detected_type == "chat"
        assert "vision" in result.capabilities

    def test_e2_anthropic_models_detection(self):
        """E2: Anthropic models get correct detected_type."""
        result = detect_model_type("anthropic/claude-sonnet-4-20250514")
        assert result.detected_type == "chat"
        assert "function_calling" in result.capabilities

    @pytest.mark.asyncio
    async def test_e3_invalid_key_returns_error_shape(self):
        """E3: a key that fails to decrypt gets a 200 carrying an explicit
        `error` field, not a silent empty list.

        Same real endpoint and scenario test_decrypt_failure_is_loud.py's
        TestListProviderModelsFailsLoudEnough already covers — kept here,
        duplicated rather than only cross-referenced, to complete this
        file's own E1-E6 checklist with a real assertion in the slot that
        already claimed to be E3.
        """
        from app.main import app
        from httpx import ASGITransport, AsyncClient
        from unittest.mock import patch

        wrong_key = os.urandom(32).hex()
        encrypted, nonce = _encrypt(PLAINTEXT, REAL_KEY)

        with patch("app.main.get_settings") as mock_settings:
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.provider_key_encryption_key = wrong_key

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
        assert body.get("error") == "Failed to decrypt provider key"
        assert PLAINTEXT not in resp.text

    @pytest.mark.asyncio
    async def test_e4_unsupported_provider_returns_error(self):
        """E4: a provider not in the known endpoint map gets a 200 carrying
        an explicit `error` field naming it, not a silent empty list.

        Uses a genuinely decryptable key (unlike E3) so the request reaches
        the provider-endpoint lookup rather than failing at decrypt first —
        this is the one real gap E3's own sibling test didn't cover.
        """
        import app.main as main_module
        from app.main import app
        from httpx import ASGITransport, AsyncClient
        from unittest.mock import patch, MagicMock

        encrypted, nonce = _encrypt(PLAINTEXT, REAL_KEY)

        with patch("app.main.get_settings") as mock_settings, \
                patch.object(main_module, "_http_client", MagicMock()):
            # A valid decrypt reaches the provider-endpoint lookup, which is
            # gated on `_http_client is not None` (set at app startup, which
            # this ASGITransport-based client doesn't run) — patched to a
            # non-None stand-in. Never actually called: "custom" isn't in
            # provider_endpoints, so the function returns before any request
            # would go out on it.
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.provider_key_encryption_key = REAL_KEY

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/internal/list-provider-models",
                    json={
                        "provider": "custom",
                        "api_key_encrypted": encrypted.hex(),
                        "api_key_nonce": nonce.hex(),
                        "api_base_url": None,
                    },
                    headers={"Authorization": "Bearer svc-token"},
                )

        assert resp.status_code == 200
        body = resp.json()
        assert body["models"] == []
        assert body.get("error") == "Unsupported provider for model listing: custom"
        assert PLAINTEXT not in resp.text

    def test_e5_embedding_model_detected(self):
        """E5: Embedding model detected from model ID."""
        result = detect_model_type("openai/text-embedding-3-small")
        assert result.detected_type == "embedding"
        assert result.capabilities == ["embedding"]

    def test_e6_chat_model_detected(self):
        """E6: Chat model detected from model ID."""
        result = detect_model_type("openai/gpt-4o-mini")
        assert result.detected_type == "chat"
        assert "function_calling" in result.capabilities
