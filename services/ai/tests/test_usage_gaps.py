"""A usage row that was never written is recorded as a gap, not left as an absence (#261).

THE QUESTION ANSWERED FIRST, because it decided the shape of the fix: does
anything downstream reveal the gap? No. `routes/usage.ts` aggregates with
`COUNT(*)` and `COALESCE(SUM(...), 0)`, so a missing row reads as a smaller,
entirely plausible total. `limits.check_rate_limit` counts rows in the last
minute and `limits.check_token_budget` sums today's tokens, so a missing row
makes both controls LOOSER — in the direction nobody complains about. Nothing
compares `model_usage` against LiteLLM's own spend record, and nothing in this
tenant is scraped. The only symptom is a number smaller than the truth that
looks like a quiet period.

So the fix is not to make the write more reliable. It is to make the failure
VISIBLE: record it, converge it into the database when the database is answering
again, and report it alongside every total. Nothing is retried — the lost row's
tokens and cost are gone, and only the fact of its absence can still be
established.

NOT EXERCISED: no write was made to fail against a real database, no aggregate
compared against a provider bill, and no gap observed in production. `can` means
the code permits it.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app import usage_gaps
from app.usage import log_usage


@pytest.fixture(autouse=True)
def _clean_gap_state():
    usage_gaps.reset_pending_gap()
    yield
    usage_gaps.reset_pending_gap()


def _conn(execute):
    conn = MagicMock()
    conn.execute = execute
    return conn


async def _log(conn, **over):
    await log_usage(
        conn=conn,
        agent_id="agent-1",
        model_name="gpt-4o-mini",
        request_type="chat.completion",
        status="success",
        latency_ms=12,
        input_tokens=10,
        output_tokens=20,
        cost_usd=0.001,
        **over,
    )


class TestRecordingTheFailure:
    @pytest.mark.asyncio
    async def test_positive_control_a_failed_write_becomes_a_pending_gap(self):
        # The fixture that produces NO ROW. A successful write cannot tell the
        # versions apart — it never touched this path.
        conn = _conn(AsyncMock(side_effect=RuntimeError("connection pool exhausted")))

        with pytest.raises(RuntimeError):
            await _log(conn)

        gap = usage_gaps.pending_gap()
        assert gap is not None
        assert gap.missed_count == 1
        assert "connection pool exhausted" in gap.reason

    @pytest.mark.asyncio
    async def test_TWIN_a_successful_write_leaves_no_gap(self):
        conn = _conn(AsyncMock())
        await _log(conn)
        assert usage_gaps.pending_gap() is None

    @pytest.mark.asyncio
    async def test_the_exception_still_reaches_the_caller(self):
        # Callers wrap this in log-and-continue on purpose: a metering failure
        # must not fail an inference the user is waiting on. Recording the gap
        # must not change that.
        conn = _conn(AsyncMock(side_effect=RuntimeError("boom")))
        with pytest.raises(RuntimeError):
            await _log(conn)

    @pytest.mark.asyncio
    async def test_repeated_failures_accumulate_into_one_gap(self):
        conn = _conn(AsyncMock(side_effect=RuntimeError("still down")))
        for _ in range(3):
            with pytest.raises(RuntimeError):
                await _log(conn)

        gap = usage_gaps.pending_gap()
        assert gap.missed_count == 3
        assert gap.first_failed_at <= gap.last_failed_at


class TestConvergence:
    @pytest.mark.asyncio
    async def test_positive_control_the_next_successful_write_records_the_gap(self):
        failing = _conn(AsyncMock(side_effect=RuntimeError("db unreachable")))
        with pytest.raises(RuntimeError):
            await _log(failing)

        execute = AsyncMock()
        await _log(_conn(execute))

        # Two statements: the usage row, then the gap it converged.
        statements = [call.args[0] for call in execute.await_args_list]
        assert any("INSERT INTO model_usage" in s for s in statements)
        assert any("INSERT INTO usage_write_gaps" in s for s in statements)

        gap_call = next(c for c in execute.await_args_list if "usage_write_gaps" in c.args[0])
        assert gap_call.args[1] == 1  # missed_count
        assert usage_gaps.pending_gap() is None  # cleared once recorded

    @pytest.mark.asyncio
    async def test_nothing_is_retried(self):
        # The lost row's tokens and cost are gone; only its absence is
        # recoverable. Exactly one model_usage insert — the new request's.
        failing = _conn(AsyncMock(side_effect=RuntimeError("db unreachable")))
        with pytest.raises(RuntimeError):
            await _log(failing)

        execute = AsyncMock()
        await _log(_conn(execute))

        usage_inserts = [c for c in execute.await_args_list if "INSERT INTO model_usage" in c.args[0]]
        assert len(usage_inserts) == 1

    @pytest.mark.asyncio
    async def test_a_flush_that_fails_keeps_the_gap_pending(self):
        failing = _conn(AsyncMock(side_effect=RuntimeError("db unreachable")))
        with pytest.raises(RuntimeError):
            await _log(failing)

        async def usage_ok_gap_fails(sql, *args):
            if "usage_write_gaps" in sql:
                raise RuntimeError("gap insert failed")

        # The usage write still counts as a success for the caller...
        await _log(_conn(AsyncMock(side_effect=usage_ok_gap_fails)))

        # ...and the gap is still owed, so the next success tries again.
        assert usage_gaps.pending_gap() is not None
        assert usage_gaps.pending_gap().missed_count == 1

    @pytest.mark.asyncio
    async def test_a_gap_spans_first_and_last_failure(self):
        early = datetime.now(timezone.utc) - timedelta(minutes=5)
        usage_gaps.record_failed_write(RuntimeError("first"), now=early)
        usage_gaps.record_failed_write(RuntimeError("second"))

        execute = AsyncMock()
        await _log(_conn(execute))

        gap_call = next(c for c in execute.await_args_list if "usage_write_gaps" in c.args[0])
        assert gap_call.args[1] == 2
        assert gap_call.args[2] == early          # first_failed_at
        assert gap_call.args[3] >= gap_call.args[2]  # last_failed_at
