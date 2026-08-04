"""Usage writes that failed, held until they can be recorded (#261).

WHY THIS IS NOT A RETRY. When the write fails, the row's data is already gone
past the point where re-sending it means anything: the request has been answered
and the tokens are spent. What can still be established is *that* a row is
missing, and how many. So this converges — the gap is written into the database
on the next successful usage write — rather than retrying rows we no longer hold.

WHY IT MATTERS MORE THAN AN ACCOUNTING GAP. Nobody notices absent rows; they
notice wrong totals. A `COUNT(*)`/`SUM(...)` over rows that were never written
looks exactly like a quiet period. And `model_usage` is not only the ledger, it
is the enforcement substrate: `limits.check_rate_limit` counts rows in the last
minute and `limits.check_token_budget` sums today's tokens, so a missing row
makes both controls *looser* — quietly, and in the direction nobody complains
about.

STATE IS IN MEMORY, and the limit is real: a process that dies while holding a
pending gap loses it, and the only trace left is the `usage_log_failed` warning.
The alternative — writing the gap to the database at the moment of failure — is
a write to the database that just refused a write.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import structlog

logger = structlog.get_logger()


@dataclass
class PendingGap:
    missed_count: int
    first_failed_at: datetime
    last_failed_at: datetime
    reason: str


_pending: PendingGap | None = None


def record_failed_write(exc: BaseException, *, now: datetime | None = None) -> None:
    """Note that one usage row was lost."""
    global _pending
    stamp = now or datetime.now(timezone.utc)
    reason = f"{exc.__class__.__name__}: {exc}"[:200]
    if _pending is None:
        _pending = PendingGap(1, stamp, stamp, reason)
    else:
        _pending.missed_count += 1
        _pending.last_failed_at = stamp
        _pending.reason = reason
    logger.warning(
        "usage_write_gap",
        missed_count=_pending.missed_count,
        reason=reason,
    )


def pending_gap() -> PendingGap | None:
    return _pending


def reset_pending_gap() -> None:
    """Test seam only: module state is process-global by design."""
    global _pending
    _pending = None


async def flush_pending_gap(conn: Any) -> None:
    """Record the gap now that the database is answering again.

    Never raises: this runs immediately after a usage write that succeeded, and
    failing to record the gap must not turn a successful write into a failed
    one. If it fails, the gap stays pending and the next success tries again.
    """
    global _pending
    gap = _pending
    if gap is None:
        return
    try:
        await conn.execute(
            """
            INSERT INTO usage_write_gaps
                (missed_count, first_failed_at, last_failed_at, reason)
            VALUES ($1, $2, $3, $4)
            """,
            gap.missed_count,
            gap.first_failed_at,
            gap.last_failed_at,
            gap.reason,
        )
    except Exception as exc:  # noqa: BLE001 — see docstring
        logger.warning("usage_gap_flush_failed", error=str(exc), missed_count=gap.missed_count)
        return
    logger.info("usage_gap_recorded", missed_count=gap.missed_count)
    _pending = None
