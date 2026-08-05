"""app#396: proves the canary is actually wired into `lifespan` the way
the DATABASE_URL check already is, not just present as an importable
function. Same shape as test_requires_database_url.py's
`test_startup_refuses_when_the_database_is_unreachable`: a real `lifespan`
context manager, `asyncpg.create_pool` monkeypatched to hand back a fake
pool holding a REAL encrypted row, and the assertion is that startup
refuses when the configured key cannot open it.
"""

from __future__ import annotations

import os

import asyncpg
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI

REAL_KEY = os.urandom(32).hex()
WRONG_KEY = os.urandom(32).hex()


def _encrypt(plaintext: str, hex_key: str) -> tuple[bytes, bytes]:
    key = bytes.fromhex(hex_key)
    nonce = os.urandom(12)
    return AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), None), nonce


class _FakeConn:
    def __init__(self, row):
        self._row = row

    async def fetchrow(self, _sql):
        return self._row

    async def fetchval(self, _sql):
        return 1


class _FakeAcquireCtx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *_exc):
        return False


class _FakePool:
    """Stands in for the asyncpg.Pool `create_pool` normally returns —
    enough surface for `lifespan` (acquire, close) plus revocation
    preload's own `conn.fetch`."""

    def __init__(self, row):
        self._conn = _FakeConn(row)
        self._conn.fetch = self._fetch

    async def _fetch(self, _sql, *_args):
        return []

    def acquire(self):
        return _FakeAcquireCtx(self._conn)

    async def close(self):
        return None


def _fresh_settings(monkeypatch, key: str):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
    monkeypatch.setenv("PROVIDER_KEY_ENCRYPTION_KEY", key)
    from app.config import get_settings

    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_a_wrong_key_refuses_to_start(monkeypatch):
    encrypted, nonce = _encrypt("sk-a-real-secret-encrypted-under-REAL_KEY", REAL_KEY)
    fake_pool = _FakePool(row={"api_key_encrypted": encrypted, "api_key_nonce": nonce})

    async def fake_create_pool(*_a, **_kw):
        return fake_pool

    monkeypatch.setattr(asyncpg, "create_pool", fake_create_pool)
    # The exact shape #396 found live: a validly-shaped, present key that is
    # simply the WRONG one, not an absent or malformed one.
    _fresh_settings(monkeypatch, WRONG_KEY)

    from app.config import get_settings
    from app.main import lifespan

    get_settings.cache_clear()

    async def run() -> None:
        async with lifespan(FastAPI()):
            pass

    with pytest.raises(Exception) as exc:
        await run()

    message = str(exc.value)
    assert "PROVIDER_KEY_ENCRYPTION_KEY" in message
    assert "app#396" in message
    # The whole point: neither key nor the plaintext ever reaches the
    # exception a human reads.
    assert REAL_KEY not in message
    assert WRONG_KEY not in message
    assert "sk-a-real-secret-encrypted-under-REAL_KEY" not in message


@pytest.mark.asyncio
async def test_the_correct_key_starts_cleanly(monkeypatch):
    encrypted, nonce = _encrypt("sk-a-real-secret", REAL_KEY)
    fake_pool = _FakePool(row={"api_key_encrypted": encrypted, "api_key_nonce": nonce})

    async def fake_create_pool(*_a, **_kw):
        return fake_pool

    monkeypatch.setattr(asyncpg, "create_pool", fake_create_pool)
    _fresh_settings(monkeypatch, REAL_KEY)

    from app.config import get_settings
    from app.main import lifespan

    get_settings.cache_clear()

    async with lifespan(FastAPI()):
        pass  # did not raise — that is the assertion


@pytest.mark.asyncio
async def test_an_empty_estate_also_starts_cleanly(monkeypatch):
    fake_pool = _FakePool(row=None)

    async def fake_create_pool(*_a, **_kw):
        return fake_pool

    monkeypatch.setattr(asyncpg, "create_pool", fake_create_pool)
    _fresh_settings(monkeypatch, REAL_KEY)

    from app.config import get_settings
    from app.main import lifespan

    get_settings.cache_clear()

    async with lifespan(FastAPI()):
        pass  # nothing to verify, still starts — did not raise
