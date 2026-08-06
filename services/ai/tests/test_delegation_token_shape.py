"""app.main's POST /v1/delegate — the API service's response shape is trusted.

THE DEFECT. `create_delegation_endpoint` writes a pending `model_delegations`
row, then asks the API service to sign the child JWT. A non-2xx from that
call is handled carefully: the pending row is deleted and a 502 with a
stated detail is raised. But a 200 whose body doesn't carry `jti`/`token`
(`resp.json()` raising, or the keys simply missing) was NOT handled the
same way — `token_result["jti"]`/`token_result["token"]` were accessed with
bracket indexing, three lines below the careful non-200 branch that uses
`.get()`-free but exception-guarded cleanup. An unhandled KeyError/
JSONDecodeError there means FastAPI's default 500 (no detail), and — the
part that matters more than the status code — the pending row is never
cleaned up, since the cleanup logic only wraps the request-exception and
non-200 branches.

LATENT, NOT LIVE. Checked directly: today's `/internal/delegation-token`
handler (services/api/src/services/model-router-delegation.ts) always
returns both fields on 200, or a non-200 on any failure — so no caller
reaches this branch under the current paired implementation. It's still
worth guarding, because these are two independently deployed services and
a rolling deploy routinely runs them several commits apart (the drift
alarm this estate runs exists because of exactly that) — this is the same
cross-service-contract assumption that made `services/knowledge`'s
`generate_embeddings` gain an `owner` kwarg and 500 an untouched
integration stub earlier the same day, one layer down.

THE ASSERTION THAT MATTERS. Not the response status code — a test that
only asserted "500" would pass against the unguarded code too, since it
already fails, just messily and with an orphaned row. What actually
distinguishes "fixed" from "fails messily" is whether the pending
`model_delegations` row survives. It must not.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.auth import AgentClaims
from app import main as app_main
from app.main import DelegateRequest, create_delegation_endpoint
from app.policy import AgentPolicy


def _fake_claims():
    return AgentClaims(
        sub="parent-agent", iss="hill90-api", aud="hill90-model-router",
        exp=9999999999, iat=0, jti="parent-jti-1",
    )


def _fake_parent_policy():
    return AgentPolicy(
        allowed_models=["gpt-4o-mini"],
        max_requests_per_minute=None,
        max_tokens_per_day=None,
        model_aliases=None,
    )


class FakeConn:
    """A model_delegations table, in memory.

    Mirrors only what create_delegation/update_child_jti/the endpoint's own
    cleanup DELETE actually issue against it — enough to answer "does the
    pending row survive", which is the whole point of this test.
    """

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    async def execute(self, sql: str, *args):
        stripped = sql.strip()
        if stripped.startswith("INSERT INTO model_delegations"):
            delegation_id = args[0]
            self.rows[delegation_id] = {"id": delegation_id, "child_jti": args[3]}
        elif stripped.startswith("DELETE FROM model_delegations"):
            self.rows.pop(args[0], None)
        elif stripped.startswith("UPDATE model_delegations SET child_jti"):
            delegation_id, child_jti = args[1], args[0]
            if delegation_id in self.rows:
                self.rows[delegation_id]["child_jti"] = child_jti
        return None


def _fake_get_db_conn(conn: FakeConn):
    @asynccontextmanager
    async def _get_db_conn():
        yield conn
    return _get_db_conn


class TestDelegationTokenShapeMismatch:
    @pytest.mark.asyncio
    async def test_a_200_missing_jti_and_token_leaves_no_orphan_row(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        conn = FakeConn()
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.text = '{"unexpected": "shape"}'
        fake_response.json = MagicMock(return_value={"unexpected": "shape"})  # no jti/token

        with (
            patch.object(app_main, "get_db_conn", _fake_get_db_conn(conn)),
            patch.object(app_main, "resolve_agent_policy", AsyncMock(return_value=_fake_parent_policy())),
            patch.object(app_main, "_http_client", MagicMock(post=AsyncMock(return_value=fake_response))),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await create_delegation_endpoint(
                    DelegateRequest(child_label="sub-agent", allowed_models=["gpt-4o-mini"]),
                    _fake_claims(),
                )

        # THE ASSERTION THAT MATTERS: no pending-<uuid> row survives — either
        # never durably left behind, or cleaned up on this failure, exactly
        # like the non-200 branch three lines above it already does.
        assert conn.rows == {}

        # The response shape is real too, just secondary to the DB claim above.
        assert exc_info.value.status_code == 502
        assert exc_info.value.detail == "Failed to sign delegation token"

    @pytest.mark.asyncio
    async def test_a_200_with_non_json_body_leaves_no_orphan_row(self, monkeypatch):
        """Twin: resp.json() itself raising (a non-JSON 200 body), not just a
        JSON body missing the expected keys — the other half of what the
        bare `resp.json()` call used to leave unguarded."""
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        conn = FakeConn()
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.text = "not json at all"
        fake_response.json = MagicMock(side_effect=ValueError("Expecting value"))

        with (
            patch.object(app_main, "get_db_conn", _fake_get_db_conn(conn)),
            patch.object(app_main, "resolve_agent_policy", AsyncMock(return_value=_fake_parent_policy())),
            patch.object(app_main, "_http_client", MagicMock(post=AsyncMock(return_value=fake_response))),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await create_delegation_endpoint(
                    DelegateRequest(child_label="sub-agent", allowed_models=["gpt-4o-mini"]),
                    _fake_claims(),
                )

        assert conn.rows == {}
        assert exc_info.value.status_code == 502
        assert exc_info.value.detail == "Failed to sign delegation token"

    @pytest.mark.asyncio
    async def test_twin_a_well_shaped_200_creates_the_delegation_normally(self, monkeypatch):
        """Same setup, correct shape — proves the fix didn't just make every
        200 fail. The delegation row survives, carrying the signed child_jti."""
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@fake-host:5432/db")
        from app.config import get_settings
        get_settings.cache_clear()

        conn = FakeConn()
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.text = '{"token": "signed.jwt.here", "jti": "child-jti-1"}'
        fake_response.json = MagicMock(return_value={"token": "signed.jwt.here", "jti": "child-jti-1"})

        with (
            patch.object(app_main, "get_db_conn", _fake_get_db_conn(conn)),
            patch.object(app_main, "resolve_agent_policy", AsyncMock(return_value=_fake_parent_policy())),
            patch.object(app_main, "_http_client", MagicMock(post=AsyncMock(return_value=fake_response))),
        ):
            result = await create_delegation_endpoint(
                DelegateRequest(child_label="sub-agent", allowed_models=["gpt-4o-mini"]),
                _fake_claims(),
            )

        assert result["token"] == "signed.jwt.here"
        assert len(conn.rows) == 1
        (row,) = conn.rows.values()
        assert row["child_jti"] == "child-jti-1"
