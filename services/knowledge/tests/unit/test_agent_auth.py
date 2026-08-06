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
    # These three were each named for an authorization property — a 403,
    # a scope gate —
    # and none of them exercised any code that could produce one. All three
    # only asserted that `claims.scopes`/`claims.sub` came back equal to the
    # literal value `_make_token` was called with two lines above: a value
    # the test itself supplied, echoed back by a JWT decode, proving nothing
    # about whether anything in the app actually enforces it.
    #
    # AKM:SHARED-WRITE IS NOT ENFORCED ANYWHERE. Grepped exhaustively across
    # services/knowledge, services/api, and services/agentbox: the string
    # "akm:shared-write" appears in exactly two places outside this file —
    # conftest.py's `shared_write_token` fixture, and nowhere else. No route,
    # no dependency, no middleware checks `claims.scopes` for it or for any
    # scope at all — `middleware/agent_auth.py` parses and returns scopes,
    # and nothing downstream reads them. There is also no agent-facing write
    # endpoint to shared knowledge in the first place: `routes/shared.py`
    # ("Agent-facing shared knowledge endpoints") exposes only GET /search
    # and GET /collections. Writing to a shared collection exists only
    # through `routes/internal_admin_shared.py`, which is admin/service-
    # token-authenticated, not gated by any per-agent scope.
    #
    # This is not "the enforcement has a hole" — there is no enforcement to
    # have a hole in, because there is nothing for an agent to write to yet.
    # Left as-is rather than fixed: per instruction, a hollow security test
    # that turns out to guard a control that does not exist is a finding to
    # report, not a test to quietly patch into looking covered. Filed as
    # app#504 for a deliberate decision (build real per-agent-scoped shared
    # write access, or remove the vestigial scope and these two tests).
    def test_shared_write_without_scope_403(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        """Decoding a token without akm:shared-write does not add the scope.

        Does NOT prove a write attempt is refused — see the class comment.
        No route currently checks this scope, or any scope, for anything.
        """
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, scopes=["akm:read", "akm:write"])
        claims = verify_agent_token(token, public_pem)
        assert "akm:shared-write" not in claims.scopes

    def test_shared_write_with_scope_ok(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        """Decoding a token with akm:shared-write preserves the scope.

        Does NOT prove a write attempt is allowed — see the class comment.
        No route currently checks this scope, or any scope, for anything.
        """
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, scopes=["akm:read", "akm:write", "akm:shared-write"])
        claims = verify_agent_token(token, public_pem)
        assert "akm:shared-write" in claims.scopes

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
