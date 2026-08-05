"""app#133's Python twin, services/ai's arm: RevocationManager.start_cleanup_loop's
_loop() already wraps its body in try/except Exception with asyncio.sleep()
outside the try, so a raising cycle is caught and logged — the loop does not
die. Proven below.

What's missing, proven by the same test: nothing observable reflects a
cycle's outcome beyond a log line. The fix adds a last-run marker the caller
can read (e.g. from /health/ready).
"""

from __future__ import annotations

import asyncio

import pytest

from app.revocation import RevocationManager


class _RaisingPool:
    """A pool whose .acquire() context manager always raises on entry."""

    def acquire(self):
        return _RaisingAcquire()


class _RaisingAcquire:
    async def __aenter__(self):
        raise RuntimeError("simulated DB failure")

    async def __aexit__(self, *exc_info):
        return False


@pytest.fixture(autouse=True)
def _fast_sleep(monkeypatch):
    # app.revocation.asyncio IS the asyncio module — see the equivalent note
    # in services/knowledge's test for why this closes over the real sleep
    # rather than calling asyncio.sleep(0) from inside its own body.
    real_sleep = asyncio.sleep

    async def _instant(_seconds):
        await real_sleep(0)

    monkeypatch.setattr("app.revocation.asyncio.sleep", _instant)


@pytest.mark.asyncio
async def test_cleanup_loop_survives_a_raising_cycle_but_nothing_observes_it():
    manager = RevocationManager()
    manager.start_cleanup_loop(_RaisingPool(), interval_seconds=0)
    task = manager._cleanup_task
    assert task is not None

    try:
        for _ in range(3):
            await asyncio.sleep(0)
        await asyncio.sleep(0)

        # (a)/(b): the loop survives — the real regression guard here.
        assert not task.done(), "the cleanup loop died on a raising cycle"

        # (c): the gap. Before the fix this is an AttributeError — nothing
        # on the manager reflects a cycle's outcome at all.
        assert manager.last_cleanup_error is not None
        assert "simulated DB failure" in manager.last_cleanup_error
    finally:
        manager.stop_cleanup_loop()
        with pytest.raises(asyncio.CancelledError):
            await task
