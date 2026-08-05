"""app#396 (AI-service half): the SOPS-stored PROVIDER_KEY_ENCRYPTION_KEY and
the key a running container actually held had already drifted apart before
anyone checked it — undetected until someone compared two hashes by hand.
`run_provider_key_canary` proves the fix: it reads back a row that GENUINELY
already exists in provider_connections, encrypted under whatever key was
current when it was written, and confirms this process's key can still open
it. A self-round-trip (encrypt a fresh value, decrypt it back) cannot catch
this class of drift — any 32-byte key passes against a value it just
encrypted itself, which is exactly why the drift #396 found went unnoticed
for as long as it did.
"""

from __future__ import annotations

import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.provider_key_canary import run_provider_key_canary

REAL_KEY = os.urandom(32).hex()
WRONG_KEY = os.urandom(32).hex()


def _encrypt(plaintext: str, hex_key: str) -> tuple[bytes, bytes]:
    key = bytes.fromhex(hex_key)
    nonce = os.urandom(12)
    aesgcm = AESGCM(key)
    return aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None), nonce


class FakeConn:
    def __init__(self, row: dict | None):
        self._row = row

    async def fetchrow(self, _sql: str):
        return self._row


class FakePool:
    """A minimal stand-in for asyncpg.Pool — the canary only ever calls
    `.acquire()` as an async context manager and `.fetchrow()` on the
    connection it yields."""

    def __init__(self, row: dict | None):
        self._conn = FakeConn(row)

    def acquire(self):
        return self

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *_exc):
        return False


@pytest.mark.asyncio
async def test_nothing_to_verify_when_no_encrypted_row_exists():
    pool = FakePool(row=None)

    result = await run_provider_key_canary(pool, REAL_KEY)

    assert result == "nothing_to_verify"


@pytest.mark.asyncio
async def test_verified_against_a_real_row_with_the_correct_key():
    encrypted, nonce = _encrypt("sk-a-real-anthropic-key", REAL_KEY)
    pool = FakePool(row={"api_key_encrypted": encrypted, "api_key_nonce": nonce})

    result = await run_provider_key_canary(pool, REAL_KEY)

    assert result == "verified"


# POSITIVE CONTROL, matching #396's actual live finding: real ciphertext,
# wrong key. This is exactly the scenario a self-round-trip cannot catch —
# a freshly-encrypted-and-decrypted value would "succeed" even with the
# wrong key, because the key used to encrypt and decrypt would be the same
# wrong key throughout. Only a REAL stored row, encrypted under a DIFFERENT
# (correct, historical) key, exposes the mismatch.
@pytest.mark.asyncio
async def test_control_a_real_row_decrypted_with_the_wrong_key_raises():
    plaintext = "sk-real-secret-must-not-leak"
    encrypted, nonce = _encrypt(plaintext, REAL_KEY)
    pool = FakePool(row={"api_key_encrypted": encrypted, "api_key_nonce": nonce})

    with pytest.raises(Exception) as exc:
        await run_provider_key_canary(pool, WRONG_KEY)

    message = str(exc.value)
    assert plaintext not in message
    assert REAL_KEY not in message
    assert WRONG_KEY not in message


@pytest.mark.asyncio
async def test_a_real_row_but_no_key_configured_also_raises():
    encrypted, nonce = _encrypt("sk-whatever", REAL_KEY)
    pool = FakePool(row={"api_key_encrypted": encrypted, "api_key_nonce": nonce})

    with pytest.raises(Exception):
        await run_provider_key_canary(pool, "")


@pytest.mark.asyncio
async def test_the_returned_status_never_contains_the_decrypted_plaintext():
    plaintext = "sk-must-never-appear-anywhere-in-the-result"
    encrypted, nonce = _encrypt(plaintext, REAL_KEY)
    pool = FakePool(row={"api_key_encrypted": encrypted, "api_key_nonce": nonce})

    result = await run_provider_key_canary(pool, REAL_KEY)

    assert plaintext not in result
