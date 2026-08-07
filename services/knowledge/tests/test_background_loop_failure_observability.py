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


class _BlankMessageError(Exception):
    """An exception whose str() is '' — e.g. a bare `raise SomeError()` with
    no message argument. Real, not contrived: this is exactly the case
    app#600's bound exists to catch."""


@pytest.mark.asyncio
async def test_reconciler_loop_records_class_name_even_when_the_exception_message_is_blank(monkeypatch):
    async def _raising_reconcile(pool, settings):
        raise _BlankMessageError()

    monkeypatch.setattr("app.main.reconcile", _raising_reconcile)

    app = SimpleNamespace(state=SimpleNamespace(pool=_FakePool()))
    settings = SimpleNamespace(reconciler_interval_seconds=0)

    task = asyncio.create_task(_reconciler_loop(app, settings))
    try:
        await _run_a_few_cycles(task)

        # str(exc) alone would record "" here — indistinguishable from the
        # field never having been set, at exactly the moment an operator
        # is reading /health to find out why the reconciler keeps failing.
        assert app.state.reconciler_last_error == "_BlankMessageError: "
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_reconciler_loop_bounds_a_long_exception_message_to_200_chars(monkeypatch):
    async def _raising_reconcile(pool, settings):
        raise RuntimeError("x" * 500)

    monkeypatch.setattr("app.main.reconcile", _raising_reconcile)

    app = SimpleNamespace(state=SimpleNamespace(pool=_FakePool()))
    settings = SimpleNamespace(reconciler_interval_seconds=0)

    task = asyncio.create_task(_reconciler_loop(app, settings))
    try:
        await _run_a_few_cycles(task)

        # /health has no size limit of its own on this field.
        assert len(app.state.reconciler_last_error) == 200
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_reconciler_loop_recovery_clears_the_error_and_the_success_timestamp_advances(monkeypatch):
    """The positive control this file was missing: a loop that fails and then
    recovers must look different from one still failing, and different from
    one that has never run at all — not just different from a loop that has
    never failed.

    Synchronized with events rather than counting sleep(0) yields — the
    interval is patched to an instant sleep, so a fixed number of yields is
    not a reliable way to land exactly between "call 1 failed" and "call 2
    has not yet returned" otherwise.
    """
    calls = {"n": 0}
    call2_started = asyncio.Event()
    release_call2 = asyncio.Event()

    async def _reconcile_fails_once_then_blocks(pool, settings):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated one-time failure")
        if calls["n"] == 2:
            call2_started.set()
            await release_call2.wait()

    monkeypatch.setattr("app.main.reconcile", _reconcile_fails_once_then_blocks)

    # Pre-initialized to None, matching real app.state's own lifespan setup
    # (main.py sets these before either loop ever starts) — the loop itself
    # only ever WRITES these attributes, never initializes them, so a bare
    # SimpleNamespace would raise AttributeError on the pre-first-success
    # read below rather than genuinely prove the null-vs-timestamp
    # distinction.
    app = SimpleNamespace(state=SimpleNamespace(
        pool=_FakePool(), reconciler_last_success=None, reconciler_last_error=None,
    ))
    settings = SimpleNamespace(reconciler_interval_seconds=0)

    task = asyncio.create_task(_reconciler_loop(app, settings))
    try:
        # Call 1 (startup) has failed and call 2 (first periodic cycle) has
        # started but not yet returned — the one window where "failed once"
        # and "not yet succeeded" are both true at the same time.
        await call2_started.wait()
        assert app.state.reconciler_last_error is not None
        assert app.state.reconciler_last_success is None, (
            "a loop that has only ever failed must not report a success "
            "timestamp — that would be indistinguishable from having "
            "actually succeeded once"
        )

        # Let call 2 complete successfully.
        release_call2.set()
        await asyncio.sleep(0)

        assert app.state.reconciler_last_error is None, (
            "a recovered loop must clear the stale error, not leave a "
            "prior failure looking current forever"
        )
        assert app.state.reconciler_last_success is not None
        assert isinstance(app.state.reconciler_last_success, float)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_revocation_refresh_loop_recovery_clears_the_error_and_the_success_timestamp_advances():
    call2_started = asyncio.Event()
    release_call2 = asyncio.Event()

    class _PoolFailsOnceThenBlocks:
        def __init__(self):
            self.calls = 0

        async def fetch(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("simulated one-time failure")
            if self.calls == 2:
                call2_started.set()
                await release_call2.wait()
            return []

        async def execute(self, *args, **kwargs):
            return None

    # Pre-initialized to None — same reasoning as the reconciler recovery
    # test above.
    app = SimpleNamespace(state=SimpleNamespace(
        pool=_PoolFailsOnceThenBlocks(), revoked_jtis=set(),
        revocation_last_success=None, revocation_last_error=None,
    ))

    task = asyncio.create_task(_revocation_refresh_loop(app))
    try:
        assert app.state.revocation_last_success is None, (
            "must be distinguishable from a loop that has already run — "
            "null, not a zero or epoch timestamp, before the first cycle"
        )

        await call2_started.wait()
        assert app.state.revocation_last_error is not None
        assert app.state.revocation_last_success is None, (
            "a loop that has only ever failed must not report a success "
            "timestamp — that would be indistinguishable from having "
            "actually succeeded once"
        )

        release_call2.set()
        await asyncio.sleep(0)

        assert app.state.revocation_last_error is None, (
            "a recovered loop must clear the stale error, not leave a "
            "prior failure looking current forever"
        )
        assert app.state.revocation_last_success is not None
        assert isinstance(app.state.revocation_last_success, float)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
