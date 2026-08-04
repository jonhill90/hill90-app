"""Usage logger for model requests with token counts and cost.

Records agent_id, model, status, latency, token counts, cost, and owner per request.
"""

from typing import Any

from app.usage_gaps import flush_pending_gap, record_failed_write


async def log_usage(
    *,
    conn: Any,
    agent_id: str,
    model_name: str,
    request_type: str,
    status: str,
    latency_ms: int,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float = 0.0,
    delegation_id: str | None = None,
    owner: str | None = None,
    requested_model: str | None = None,
    provider_model_id: str | None = None,
) -> None:
    """Write a usage record to model_usage including token counts, cost, and owner.

    A failure is recorded before it is re-raised (#261). Every caller wraps this
    in a handler that logs and continues — correct, because a metering failure
    must not fail an inference the user is waiting on — which left `model_usage`
    able to be missing rows that nothing could distinguish from requests that
    never happened. Noting it HERE rather than at the thirteen call sites is
    deliberate: a bound that lives at each site is one drift away from covering
    twelve of them.
    """
    try:
        await _insert(conn, locals())
    except Exception as exc:
        record_failed_write(exc)
        raise

    # The database is answering, so any earlier gap can now be stated as a fact.
    await flush_pending_gap(conn)


async def _insert(conn: Any, args: dict[str, Any]) -> None:
    await conn.execute(
        """
        INSERT INTO model_usage
            (agent_id, model_name, request_type, status, latency_ms,
             input_tokens, output_tokens, cost_usd, delegation_id, owner,
             requested_model, provider_model_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        """,
        args["agent_id"],
        args["model_name"],
        args["request_type"],
        args["status"],
        args["latency_ms"],
        args["input_tokens"],
        args["output_tokens"],
        args["cost_usd"],
        args["delegation_id"],
        args["owner"],
        args["requested_model"],
        args["provider_model_id"],
    )


# Backwards-compatible alias for Phase 1 callers
log_request_metadata = log_usage
