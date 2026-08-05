"""app#133's Python twin: three long-lived background tasks whose coroutine
could raise, sit unretrieved, and never run again while the container keeps
answering /health 200. This file covers the two loops in main.py.

Empirically NOT the case that either loop dies: both already wrap the failing
call in try/except Exception with asyncio.sleep() outside the try, so a raise
is caught and logged, and the while True continues. That's proven below —
each test asserts the loop task is still alive after an injected failure.

What IS missing, proven by the same tests: nothing observable reflects a
cycle's success or failure beyond a log line. A monitoring system reading
app.state (or /health) has no way to tell "failing every cycle for an hour"
from "working fine" — both look identical from the outside. The failing
assertion below is that gap; the fix adds a last-run marker and updates it
either way.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.main import _reconciler_loop, _revocation_refresh_loop


class _FakePool:
    """A pool whose .fetch/.execute always raise, simulating a dead DB."""

    async def fetch(self, *args, **kwargs):
        raise RuntimeError("simulated DB failure")

    async def execute(self, *args, **kwargs):
        raise RuntimeError("simulated DB failure")


@pytest.fixture(autouse=True)
def _fast_sleep(monkeypatch):
    """Collapse asyncio.sleep so the loops cycle instantly instead of waiting
    on real interval_seconds / 30s sleeps. Patched in app.main's namespace,
    where both loops call it.

    app.main.asyncio IS the asyncio module itself, not a copy — patching
    app.main.asyncio.sleep patches asyncio.sleep globally, including inside
    this replacement. So it closes over the REAL sleep captured before
    patching, rather than calling asyncio.sleep(0) from within its own body,
    which would recurse into itself.
    """
    real_sleep = asyncio.sleep

    async def _instant(_seconds):
        await real_sleep(0)

    monkeypatch.setattr("app.main.asyncio.sleep", _instant)


async def _run_a_few_cycles(task: asyncio.Task, cycles: int = 3) -> None:
    for _ in range(cycles):
        await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_reconciler_loop_survives_a_raising_cycle_but_nothing_observes_it(monkeypatch):
    async def _raising_reconcile(pool, settings):
        raise RuntimeError("simulated reconcile failure")

    monkeypatch.setattr("app.main.reconcile", _raising_reconcile)

    app = SimpleNamespace(state=SimpleNamespace(pool=_FakePool()))
    settings = SimpleNamespace(reconciler_interval_seconds=0)

    task = asyncio.create_task(_reconciler_loop(app, settings))
    try:
        await _run_a_few_cycles(task)

        # (a)/(b): the loop survives. This is the REAL, useful regression
        # guard — if the try/except were ever narrowed or removed, this
        # assertion is what would catch it.
        assert not task.done(), "the reconciler loop died on a raising cycle"

        # (c): the gap. A raising cycle must leave a trace something can
        # observe from outside — a timestamp/counter, not just a log line.
        # Before the fix this is an AttributeError: nothing on app.state
        # reflects a cycle's outcome at all.
        assert app.state.reconciler_last_error is not None
        assert "simulated reconcile failure" in app.state.reconciler_last_error
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_revocation_refresh_loop_survives_a_raising_cycle_but_nothing_observes_it():
    app = SimpleNamespace(state=SimpleNamespace(pool=_FakePool(), revoked_jtis=set()))

    task = asyncio.create_task(_revocation_refresh_loop(app))
    try:
        await _run_a_few_cycles(task)

        assert not task.done(), "the revocation refresh loop died on a raising cycle"

        assert app.state.revocation_last_error is not None
        assert "simulated DB failure" in app.state.revocation_last_error
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
