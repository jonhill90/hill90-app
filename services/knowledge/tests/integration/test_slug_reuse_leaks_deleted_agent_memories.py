"""app#614: does AKM leak a deleted agent's memories to a NEW agent that
later reuses the same slug?

THE VULNERABILITY, TRACED, NOT ASSUMED. AKM's only identity for an agent is
the JWT's `sub` claim (app/middleware/agent_auth.py — verifies signature,
issuer, audience, expiry, revocation; never cross-checks `sub` against
services/api's own agents table for current existence or ownership).
`services/api` issues that `sub` as the agent's SLUG, not its immutable
UUID, whenever WORKLOAD_PRINCIPAL_V2 is unset
(services/api/src/services/akm-token.ts:37,83) — and it is unset in all
five production containers today, confirmed live. The slug is caller-
chosen (services/api/src/routes/agents.ts:597, straight from req.body),
globally unique only among CURRENTLY-EXISTING agents, and freely reusable
the moment an agent is hard-deleted (agents.ts:1602, `DELETE FROM agents`,
no soft-delete, no tombstone). Every per-agent AKM resource --
agent_memories included -- is keyed by that same reusable string with no
other binding checked.

THE SAFE PROPERTY THIS TEST ASSERTS. An agent created with a previously-
used agent slug must NOT be able to read memories a DIFFERENT, earlier
agent stored under that same slug. Modelled here as two tokens sharing one
`sub` ("reused-slug-agent") but carrying different `owner` claims -- exactly
what services/api would issue to two unrelated agents that happened to
claim the same slug at different points in time, which is the whole of
what a slug collision after deletion looks like from AKM's side. AKM never
sees services/api's agents table at all, so it cannot distinguish "the
same agent, still alive" from "a different agent that reused this name" --
both tokens look identical to it.

THIS TEST WILL FAIL TODAY, ON PURPOSE. That is the failing-first evidence
app#614 asks for. Do not xfail it, do not add a conditional skip to keep
CI green, and do not weaken the assertion to make it pass -- a change that
does any of those hides the boundary being unenforced instead of proving
it. It goes green only once one of app#614's fixes actually lands:
WORKLOAD_PRINCIPAL_V2 turned on everywhere (so `sub` becomes the
never-reused agent UUID and two different agents can no longer share one),
or AKM's own auth path gains a live ownership/existence check mirroring
services/ai's `get_agent_owner` pattern (services/ai/app/main.py:544).

REAL POSTGRES, REAL AUTH MIDDLEWARE, REAL STORE -- nothing about the
vulnerability under test is mocked. The only mocked call is
generate_embedding, an external AI-service dependency this test has no
reason to exercise for real (same convention as
test_shared_search.py / test_save_memory_distinguishes_failure.py); every
other line goes through the actual FastAPI app, the actual
agent_auth_middleware, and the actual agent_memories table.

GATING. Requires AKM_TEST_DATABASE_URL, exactly like every other file in
this directory (see conftest.py) -- self-skips loudly, not silently, when
it is absent. It is NOT given a separate opt-in flag: CI's `python
(knowledge)` job already sets AKM_TEST_DATABASE_URL unconditionally for a
real pgvector/pgvector:pg16 service container (.github/workflows/ci.yml),
so this file runs there like every other integration test in this
directory -- and, until app#614 is fixed, it makes that job fail. That is
stated plainly in this PR's description rather than worked around here.
"""
from __future__ import annotations

import os
import time
import uuid
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from httpx import AsyncClient

if not os.environ.get("AKM_TEST_DATABASE_URL"):
    pytest.skip(
        "AKM_TEST_DATABASE_URL not set -- this file needs a real Postgres "
        "to reproduce app#614 against, exactly like every other file in "
        "tests/integration/. Set it (see conftest.py's default, or CI's "
        "pgvector service container) to run this reproduction.",
        allow_module_level=True,
    )

from app.routes import memories

FAKE_EMBEDDING = [0.05] * 1536
REUSED_SLUG = "reused-slug-agent"


def _agent_token(private_pem: bytes, *, sub: str, owner: str) -> str:
    now = int(time.time())
    payload = {
        "sub": sub,
        "iss": "hill90-api",
        "aud": "hill90-akm",
        "exp": now + 3600,
        "iat": now,
        "jti": str(uuid.uuid4()),
        "scopes": ["akm:read", "akm:write"],
        "owner": owner,
    }
    return jwt.encode(payload, private_pem, algorithm="EdDSA")


@pytest.mark.asyncio
async def test_new_agent_reusing_a_deleted_agents_slug_cannot_recall_its_memories(
    app_client: AsyncClient,
    ed25519_keypair: tuple[bytes, bytes],
) -> None:
    private_pem, _ = ed25519_keypair

    # Token 1: the ORIGINAL agent that once held this slug. Represents an
    # agent belonging to owner-A that has since been deleted
    # (services/api's DELETE /agents/:id is a hard delete -- the row and
    # the slug's uniqueness both vanish with it).
    original_agent_token = _agent_token(private_pem, sub=REUSED_SLUG, owner="owner-a-sub")

    # Token 2: a BRAND NEW, UNRELATED agent belonging to a different human
    # (owner-B) that later claimed the now-vacant slug -- an entirely
    # ordinary naming choice, not an attack. AKM has no way to tell these
    # two tokens apart: same sub, same aud, same iss, different owner.
    new_agent_token = _agent_token(private_pem, sub=REUSED_SLUG, owner="owner-b-sub")

    secret_content = "owner-A's private research notes, stored by the original agent"

    with patch.object(memories, "generate_embedding", AsyncMock(return_value=FAKE_EMBEDDING)):
        save_resp = await app_client.post(
            "/api/v1/memories",
            json={"content": secret_content},
            headers={"Authorization": f"Bearer {original_agent_token}"},
        )
        assert save_resp.status_code == 200, save_resp.text
        assert save_resp.json()["saved"] is True

        # THE ASSERTION THAT MATTERS. The new agent (owner-B) queries for
        # exactly the content the original agent (owner-A) stored, using its
        # OWN token -- which the real auth middleware accepts, because `sub`
        # matches and nothing else is checked.
        recall_resp = await app_client.get(
            "/api/v1/memories/recall",
            params={"q": secret_content},
            headers={"Authorization": f"Bearer {new_agent_token}"},
        )

    assert recall_resp.status_code == 200, recall_resp.text
    recalled = recall_resp.json()["memories"]

    # SAFE PROPERTY: a new agent that merely reused an old slug must not see
    # a prior, unrelated agent's memories. FAILS TODAY -- the new agent's
    # token authenticates with sub == REUSED_SLUG, agent_memories is keyed
    # only by that string, and the store correctly (from its own narrow
    # point of view) returns the highest-similarity match: the exact
    # content just saved under the same agent_id.
    assert recalled == [], (
        "SECURITY: a new agent reusing a previously-used slug recalled a "
        f"different, earlier agent's private memory: {recalled!r}. "
        "See app#614 -- AKM trusts JWT `sub` (the caller-chosen, reusable "
        "agent slug) with no live check against current agent ownership."
    )
