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
    #
    # app#600: this endpoint's own "status" is deliberately NEVER gated on
    # background_loops, on the same reasoning ai/app/main.py's /health/ready
    # already applies to its own revocation_cleanup entry — informational
    # only, not a factor in the response's own status. Argued fresh here,
    # not just copied: knowledge's core function is serving search/ingest
    # requests, and neither loop sits in that path. A stale reconciler
    # means orphaned rows in the knowledge graph go uncorrected for a
    # while; a stale revocation refresh means a just-revoked token stays
    # accepted a little longer than intended — both are real degradations,
    # but neither means search or ingest is broken. Flipping this endpoint
    # to unhealthy over either would pull knowledge out of rotation
    # entirely — stopping search and ingest for every caller — over a
    # background consistency task falling behind, which is a strictly
    # worse outcome than the degradation itself. An operator (or future
    # alerting reading this field directly) can still tell the two apart
    # from the raw timestamps below; this endpoint just doesn't collapse
    # that distinction into a single boolean the way DB/key/LLM
    # reachability checks correctly do for what's actually load-bearing.
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
