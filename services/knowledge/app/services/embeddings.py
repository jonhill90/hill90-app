"""Embedding generation via AI service model router.

Routes through the AI service /internal/embeddings endpoint so embeddings
use the same LiteLLM proxy and configuration as inference calls.
Falls back to direct LiteLLM if AI service is unavailable.
"""

import logging
import os

import httpx

logger = logging.getLogger(__name__)

AI_SERVICE_URL = os.environ.get("AI_SERVICE_URL", "http://ai:8000")
MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = os.environ.get("MODEL_ROUTER_INTERNAL_SERVICE_TOKEN", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")

# Fallback: direct LiteLLM (used if AI service token not configured)
LITELLM_URL = os.environ.get("LITELLM_URL", "http://litellm:4000")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")


async def generate_embeddings(texts: list[str], *, owner: str | None = None) -> list[list[float]] | None:
    """Generate embeddings for a list of texts via the AI service.

    `owner`, when the caller knows which user this spend belongs to (e.g.
    ingest.py's created_by), is forwarded for usage attribution — it is
    never sent to LiteLLM itself, only to the ai service's own accounting.
    Not every call site has one yet; that is a real gap, not a design
    choice — see app#548.

    Returns a list of embedding vectors (1536-dim for text-embedding-3-small),
    or None if the service is unavailable or not configured.
    """
    if not texts:
        return []

    # Prefer AI service model router
    if MODEL_ROUTER_INTERNAL_SERVICE_TOKEN:
        result = await _via_model_router(texts, owner=owner)
        if result is not None:
            return result
        logger.warning("AI service embedding failed, trying LiteLLM fallback")

    # Fallback: direct LiteLLM
    if LITELLM_MASTER_KEY:
        return await _via_litellm(texts, owner=owner)

    logger.warning("No embedding credentials configured — skipping")
    return None


async def _via_model_router(texts: list[str], *, owner: str | None = None) -> list[list[float]] | None:
    """Route embeddings through AI service /internal/embeddings."""
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{AI_SERVICE_URL}/internal/embeddings",
                json={
                    "model": EMBEDDING_MODEL,
                    "input": texts,
                    # Omitted entirely rather than sent as null when unknown
                    # — the ai service's own .pop("owner", None) treats
                    # either the same, but an absent field is the honest
                    # shape for "no identity available" versus a caller
                    # that explicitly attributed to nobody.
                    **({"owner": owner} if owner else {}),
                },
                headers={
                    "Authorization": f"Bearer {MODEL_ROUTER_INTERNAL_SERVICE_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.warning("AI service embedding failed: %d %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            # AI service wraps response: {status_code, body: {data: [...]}, ...}
            body = data.get("body", data)
            embeddings = [item["embedding"] for item in body["data"]]
            logger.info("Generated %d embeddings via model-router (model=%s, dim=%d)",
                        len(embeddings), EMBEDDING_MODEL, len(embeddings[0]) if embeddings else 0)
            return embeddings
    except Exception as exc:
        logger.warning("AI service embedding error: %s", exc)
        return None


async def _via_litellm(texts: list[str], *, owner: str | None = None) -> list[list[float]] | None:
    """Direct LiteLLM fallback for embeddings.

    THIS PATH HAS NO DATABASE CONNECTION TO model_usage — this service's own
    DATABASE_URL points at a different Postgres database (hill90_akm), not
    the one model_usage lives in. Real spend happens here with nothing able
    to write the row itself, so on success it is reported back to the ai
    service's /internal/usage endpoint instead, best-effort — see
    _report_usage_for_litellm_fallback. That report can fail without this
    function failing: it can only make an already-invisible spend visible,
    never less so.
    """
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{LITELLM_URL}/v1/embeddings",
                json={"model": EMBEDDING_MODEL, "input": texts},
                headers={
                    "Authorization": f"Bearer {LITELLM_MASTER_KEY}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.warning("LiteLLM embedding failed: %d %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            embeddings = [item["embedding"] for item in data["data"]]
            logger.info("Generated %d embeddings via LiteLLM (model=%s, dim=%d)",
                        len(embeddings), EMBEDDING_MODEL, len(embeddings[0]) if embeddings else 0)
            await _report_usage_for_litellm_fallback(data, owner=owner)
            return embeddings
    except Exception as exc:
        logger.warning("LiteLLM embedding error: %s", exc)
        return None


async def _report_usage_for_litellm_fallback(response_body: dict, *, owner: str | None) -> None:
    """Best-effort usage record for spend the ai service never saw.

    Exists ONLY because _via_litellm has no database connection of its own
    (see its docstring). NOT an enforcement point — there is no check here,
    only a record of what already happened. If
    MODEL_ROUTER_INTERNAL_SERVICE_TOKEN is not configured at all, there is
    no credential to report with either, and this spend really is
    untracked — that is said loudly here, not left silent, so it is
    discoverable rather than merely absent.
    """
    if not MODEL_ROUTER_INTERNAL_SERVICE_TOKEN:
        logger.warning(
            "embedding spend via direct LiteLLM fallback cannot be recorded — "
            "MODEL_ROUTER_INTERNAL_SERVICE_TOKEN is not configured"
        )
        return

    usage = response_body.get("usage") or {}
    input_tokens = usage.get("prompt_tokens", 0)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{AI_SERVICE_URL}/internal/usage",
                json={
                    "model_name": EMBEDDING_MODEL,
                    "request_type": "embedding",
                    "status": "success",
                    "input_tokens": input_tokens,
                    "output_tokens": 0,
                    **({"owner": owner} if owner else {}),
                },
                headers={
                    "Authorization": f"Bearer {MODEL_ROUTER_INTERNAL_SERVICE_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.warning(
                    "usage report for LiteLLM fallback failed: %d %s",
                    resp.status_code, resp.text[:200],
                )
    except Exception as exc:
        logger.warning("usage report for LiteLLM fallback error: %s", exc)


async def generate_embedding(text: str, *, owner: str | None = None) -> list[float] | None:
    """Generate a single embedding. Convenience wrapper."""
    result = await generate_embeddings([text], owner=owner)
    if result and len(result) > 0:
        return result[0]
    return None
