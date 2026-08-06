"""Unit tests for Ed25519 JWT agent authentication."""

import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from app.middleware.agent_auth import verify_agent_token, AgentClaims, AuthError


@pytest.fixture()
def ed25519_keypair() -> tuple[bytes, bytes]:
    """Generate an Ed25519 key pair for testing."""
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    public_pem = private_key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    return private_pem, public_pem


def _make_token(
    private_pem: bytes,
    sub: str = "test-agent",
    iss: str = "hill90-api",
    aud: str = "hill90-akm",
    exp_offset: int = 3600,
    jti: str | None = None,
    scopes: list[str] | None = None,
) -> str:
    """Helper to create a signed JWT."""
    now = int(time.time())
    payload = {
        "sub": sub,
        "iss": iss,
        "aud": aud,
        "exp": now + exp_offset,
        "iat": now,
        "jti": jti or str(uuid.uuid4()),
        "scopes": scopes or ["akm:read", "akm:write"],
    }
    return jwt.encode(payload, private_pem, algorithm="EdDSA")


class TestAgentAuth:
    def test_valid_token_accepted(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem)
        claims = verify_agent_token(token, public_pem)
        assert isinstance(claims, AgentClaims)
        assert claims.sub == "test-agent"
        assert "akm:read" in claims.scopes

    def test_expired_token_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, exp_offset=-3600)
        with pytest.raises(AuthError, match="expired"):
            verify_agent_token(token, public_pem)

    def test_wrong_issuer_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, iss="wrong-issuer")
        with pytest.raises(AuthError, match="issuer"):
            verify_agent_token(token, public_pem)

    def test_wrong_audience_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, aud="wrong-audience")
        with pytest.raises(AuthError, match="audience"):
            verify_agent_token(token, public_pem)

    def test_tampered_token_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem)
        # Flip a character in the signature portion
        tampered = token[:-5] + "XXXXX"
        with pytest.raises(AuthError):
            verify_agent_token(tampered, public_pem)


class TestAgentScope:
    # Found during a "tests that cannot fail" sweep across hill90-app's test
    # suites, dispatched in this conversation (not tied to a filed issue).
    # This class originally held three tests, each named for an authorization
    # property, none of which exercised any code that could produce one — all
    # three only asserted that `claims.scopes`/`claims.sub` came back equal to
    # the literal value `_make_token` was called with two lines above.
    #
    # TWO OF THE THREE — test_shared_write_without_scope_403 and
    # test_shared_write_with_scope_ok — were removed outright rather than
    # rewritten, filed as app#504. `akm:shared-write` was not enforced
    # anywhere: grepped exhaustively across services/knowledge, services/api,
    # and services/agentbox, the string appeared in exactly two places
    # outside this file — conftest.py's now-also-removed `shared_write_token`
    # fixture, and these two tests. No route, dependency, or middleware ever
    # checked `claims.scopes` for it; there was also no agent-facing write
    # endpoint to shared knowledge for it to gate in the first place
    # (routes/shared.py exposes only GET /search and GET /collections; the
    # only write path, routes/internal_admin_shared.py, is admin/service-
    # token-authenticated, not per-agent-scoped). And nothing MINTS it either
    # — services/api's real token issuer (services/api/src/routes/agents.ts)
    # hardcodes `scopes: ['akm:read', 'akm:write']` for every agent token it
    # creates; the scope was dead on both ends, not a control quietly
    # granted to agents and then never checked. Removed rather than built
    # out, per explicit instruction: inventing the write endpoint the scope
    # implied would be a much larger change than this issue warranted, and a
    # scope nobody holds and nothing checks is a false assurance to the next
    # reader either way — better absent than present-and-meaningless.
    def test_different_tokens_decode_to_different_sub_claims(
        self, ed25519_keypair: tuple[bytes, bytes]
    ) -> None:
        """verify_agent_token does not merge or confuse distinct sub claims.

        Renamed from test_cross_agent_read_403, which asserted
        claims.sub == "agent-a" two lines after minting the token with
        sub="agent-a" — trivially true by construction, and its own name
        promised a 403 that nothing in this file's scope (JWT decode only,
        no app, no DB) could ever produce. The REAL cross-agent read
        enforcement — create an entry as one agent, read it as another,
        over the actual HTTP app and a real Postgres — already exists and
        passes: tests/integration/test_crud.py::TestCrossAgentIsolation::
        test_cross_agent_read_returns_404 (confirmed 2026-08-05 against a
        live pgvector/pgvector:pg16 container). Also worth naming: the real
        behavior is 404, not 403 (routes/entries.py's own comment: "Return
        404 for both missing and cross-agent entries to avoid information
        leakage") — the old test's name was wrong about the status code on
        top of not testing anything.

        What THIS test can honestly prove at the JWT-decode layer: two
        tokens minted with different `sub` values decode to different
        `AgentClaims.sub` values, rather than e.g. both resolving to
        whatever `sub` happened to be decoded first (a real, if narrower,
        way this layer could fail and silently break the isolation the
        integration test above depends on).
        """
        private_pem, public_pem = ed25519_keypair
        token_a = _make_token(private_pem, sub="agent-a")
        token_b = _make_token(private_pem, sub="agent-b")
        claims_a = verify_agent_token(token_a, public_pem)
        claims_b = verify_agent_token(token_b, public_pem)
        assert claims_a.sub == "agent-a"
        assert claims_b.sub == "agent-b"
        assert claims_a.sub != claims_b.sub


class TestTokenRevocation:
    def test_revoked_jti_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        jti = str(uuid.uuid4())
        token = _make_token(private_pem, jti=jti)
        revoked_jtis = {jti}
        with pytest.raises(AuthError, match="revoked"):
            verify_agent_token(token, public_pem, revoked_jtis=revoked_jtis)

    def test_unrevoked_jti_allowed(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        jti = str(uuid.uuid4())
        token = _make_token(private_pem, jti=jti)
        revoked_jtis: set[str] = set()
        claims = verify_agent_token(token, public_pem, revoked_jtis=revoked_jtis)
        assert claims.jti == jti

    def test_revocation_cache_populated(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        """Multiple revoked JTIs are all rejected."""
        private_pem, public_pem = ed25519_keypair
        jti1 = str(uuid.uuid4())
        jti2 = str(uuid.uuid4())
        revoked = {jti1, jti2}
        for jti in [jti1, jti2]:
            token = _make_token(private_pem, jti=jti)
            with pytest.raises(AuthError, match="revoked"):
                verify_agent_token(token, public_pem, revoked_jtis=revoked)
