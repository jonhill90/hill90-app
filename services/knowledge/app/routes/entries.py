"""CRUD routes for knowledge entries."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel

from app.middleware.agent_auth import AgentClaims
from app.services import knowledge_store

router = APIRouter(prefix="/api/v1/entries", tags=["entries"])


class CreateEntryRequest(BaseModel):
    path: str
    content: str


class UpdateEntryRequest(BaseModel):
    content: str


def _get_claims(request: Request) -> AgentClaims:
    claims: AgentClaims | None = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return claims


def _get_pool(request: Request):  # type: ignore[no-untyped-def]
    return request.app.state.pool


def _get_data_dir(request: Request) -> str:
    data_dir: str = request.app.state.settings.data_dir
    return data_dir


@router.get("")
async def list_entries(
    request: Request,
    response: Response,
    type: str | None = None,
    limit: int = Query(500, ge=1, le=2000, description="Max entries to return"),
    offset: int = Query(0, ge=0, description="Rows to skip before the page"),
) -> list[dict[str, Any]]:
    """List one page of the authenticated agent's entries.

    The body stays a bare JSON array. ``cli/client/akm.go:198`` unmarshals it
    into ``[]map[string]interface{}``, so a body object here is a hard decode
    error for the Go CLI, not merely an empty render — the total therefore
    travels in ``X-Total-Count`` (#183, matching #182).
    """
    claims = _get_claims(request)
    pool = _get_pool(request)

    entries, total = await knowledge_store.list_entries(
        pool, claims, entry_type=type, limit=limit, offset=offset
    )
    response.headers["X-Total-Count"] = str(total)
    return [_serialize_entry(e) for e in entries]


@router.post("", status_code=201)
async def create_entry(body: CreateEntryRequest, request: Request) -> dict[str, Any]:
    claims = _get_claims(request)
    pool = _get_pool(request)
    data_dir = _get_data_dir(request)

    try:
        entry = await knowledge_store.create_entry(pool, data_dir, claims, body.path, body.content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return _serialize_entry(entry)


@router.get("/{path:path}")
async def read_entry(path: str, request: Request) -> dict[str, Any]:
    claims = _get_claims(request)
    pool = _get_pool(request)

    # Return 404 for both missing and cross-agent entries to avoid information leakage
    entry = await knowledge_store.read_entry(pool, claims, path)
    if entry is None:
        raise HTTPException(status_code=404, detail="entry not found")

    return _serialize_entry(entry)


@router.put("/{path:path}")
async def update_entry(path: str, body: UpdateEntryRequest, request: Request) -> dict[str, Any]:
    claims = _get_claims(request)
    pool = _get_pool(request)
    data_dir = _get_data_dir(request)

    try:
        entry = await knowledge_store.update_entry(pool, data_dir, claims, path, body.content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if entry is None:
        raise HTTPException(status_code=404, detail="entry not found")

    return _serialize_entry(entry)


@router.delete("/{path:path}")
async def archive_entry(path: str, request: Request) -> dict[str, Any]:
    claims = _get_claims(request)
    pool = _get_pool(request)

    try:
        result = await knowledge_store.archive_entry(pool, claims, path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if result is None:
        raise HTTPException(status_code=404, detail="entry not found")

    return result


def _serialize_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Serialize entry for JSON response, converting UUIDs and datetimes."""
    result = {}
    for key, value in entry.items():
        if hasattr(value, "hex"):  # UUID
            result[key] = str(value)
        elif hasattr(value, "isoformat"):  # datetime
            result[key] = value.isoformat()
        else:
            result[key] = value
    return result
