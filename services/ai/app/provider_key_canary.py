"""app#396 (AI-service half): proves this process's own copy of
PROVIDER_KEY_ENCRYPTION_KEY can decrypt a REAL, already-stored row of
provider_connections.api_key — not a value this function generated itself.

A self-round-trip (encrypt a fresh value, decrypt it back) passes for any
32-byte key, including a freshly wrong one — that is exactly the class of
drift #396 found already live in production between the SOPS-stored key
and the key the running containers held. Reading back a row that genuinely
exists, encrypted under whatever key was current when it was written, is
the only thing that actually proves the key.

Scoped to provider_connections only — the one table app-ai decrypts (BYOK
credentials injected per-request into chat/embeddings requests, plus the
/internal/validate-provider and /internal/list-provider-models endpoints).
mcp_servers, agents.env_vars, and agent_webhooks.secret are services/api's
concern, decrypted only there, and already covered by its own boot canary
(services/api/src/services/provider-key-canary.ts).
"""

from __future__ import annotations

import asyncpg

from app.crypto import decrypt_provider_key


async def run_provider_key_canary(pool: asyncpg.Pool, key: str) -> str:
    """Returns "verified" or "nothing_to_verify". Raises on a key that
    cannot decrypt an existing row (wrong, malformed, or missing).

    Never logs or returns the decrypted plaintext, on either path — the
    return value is a status string only.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT api_key_encrypted, api_key_nonce FROM provider_connections "
            "WHERE api_key_encrypted IS NOT NULL AND api_key_nonce IS NOT NULL "
            "LIMIT 1"
        )

    if row is None:
        return "nothing_to_verify"

    # The plaintext is discarded deliberately — proving decrypt SUCCEEDS is
    # the whole check.
    decrypt_provider_key(bytes(row["api_key_encrypted"]), bytes(row["api_key_nonce"]), key)
    return "verified"
