"""Health check endpoint."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    # app#133's Python twin: process liveness alone can't tell "the
    # reconciler/revocation-refresh loops are working" from "they've been
    # raising every cycle for an hour" — both loops already survive a
    # raising cycle, but nothing distinguished the two until this. Raw
    # values, no red/green judgment here — a caller decides what "stale"
    # means for its own alerting.
    state = request.app.state
    return {
        "status": "healthy",
        "service": "knowledge",
        "background_loops": {
            "reconciler": {
                "last_success": getattr(state, "reconciler_last_success", None),
                "last_error": getattr(state, "reconciler_last_error", None),
            },
            "revocation_refresh": {
                "last_success": getattr(state, "revocation_last_success", None),
                "last_error": getattr(state, "revocation_last_error", None),
            },
        },
    }
