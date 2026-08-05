"""RevocationManager.start_cleanup_loop's except block records
`str(e)`, which reads as "" for an exception raised with no message
(e.g. a bare `raise SomeError()`). `/health/ready` (main.py:246) exposes
`last_cleanup_error` as the observable trace that the cleanup loop is
failing every cycle (test_revocation_cleanup_loop_observability.py) — an
operator hitting that endpoint during a real recurring failure would see
`last_cleanup_error: ""`: present but blank, indistinguishable from the
field never having been set.

Every OTHER error-recording site in this codebase hardened against
exactly this risk uses `f"{exc.__class__.__name__}: {exc}"` so the type
name backstops an empty message — see usage_gaps.py:47 and proxy.py:176.
This call site is the one place that pattern was never applied.

Reuses the fixture shape from
test_revocation_cleanup_loop_observability.py (a pool whose `.acquire()`
raises on entry, sleep patched to be instant) — this test's only
difference is that the raised exception carries no message.
"""

from __future__ import annotations

import asyncio

import pytest

from app.revocation import RevocationManager


class _EmptyMessageError(RuntimeError):
    """A real exception type, raised with no args — str(e) == ''."""


class _RaisingPool:
    def acquire(self):
        return _RaisingAcquire()


class _RaisingAcquire:
    async def __aenter__(self):
        raise _EmptyMessageError()

    async def __aexit__(self, *exc_info):
        return False


class _LongMessagePool:
    def acquire(self):
        return _LongMessageAcquire()


class _LongMessageAcquire:
    async def __aenter__(self):
        # Longer than the [:200] bound both cited precedents apply.
        raise RuntimeError("x" * 500)

    async def __aexit__(self, *exc_info):
        return False


@pytest.fixture(autouse=True)
def _fast_sleep(monkeypatch):
    real_sleep = asyncio.sleep

    async def _instant(_seconds):
        await real_sleep(0)

    monkeypatch.setattr("app.revocation.asyncio.sleep", _instant)


@pytest.mark.asyncio
async def test_an_exception_with_no_message_still_records_something_readable():
    manager = RevocationManager()
    manager.start_cleanup_loop(_RaisingPool(), interval_seconds=0)
    task = manager._cleanup_task
    assert task is not None

    try:
        for _ in range(3):
            await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert not task.done(), "the cleanup loop died on a raising cycle"

        # THE ASSERTION THAT MATTERS: a blank string is exactly as useless
        # as no field at all — the exception's TYPE must still be visible.
        assert manager.last_cleanup_error is not None
        assert manager.last_cleanup_error != ""
        assert "_EmptyMessageError" in manager.last_cleanup_error
    finally:
        manager.stop_cleanup_loop()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_a_long_exception_message_is_bounded_like_its_precedents():
    """Landed without the [:200] truncation both cited precedents
    (usage_gaps.py:47, proxy.py:176) apply — and last_cleanup_error is
    served on /health/ready, so an unbounded exception message goes into
    a health response with no size limit.
    """
    manager = RevocationManager()
    manager.start_cleanup_loop(_LongMessagePool(), interval_seconds=0)
    task = manager._cleanup_task
    assert task is not None

    try:
        for _ in range(3):
            await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert not task.done(), "the cleanup loop died on a raising cycle"

        assert manager.last_cleanup_error is not None
        # THE ASSERTION THAT MATTERS: bounded the same way as the two
        # precedents this file's own docstring cites.
        assert len(manager.last_cleanup_error) <= 200
    finally:
        manager.stop_cleanup_loop()
        with pytest.raises(asyncio.CancelledError):
            await task
