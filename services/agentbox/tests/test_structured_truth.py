"""The structured fields must say what actually happened.

Every finding in the agentbox sweep had the same shape: honest in prose, dishonest
in the structured field. `success=True` beside "stub — no execution".
`status="complete"` on a truncated answer. `success: True` beside content that was
cut off at a megabyte.

A human reading the message can often tell. A PROGRAM reading the field never can
— and in an agent platform the reader is almost always a program, or an LLM
branching on that field. The prose is decoration; the field is the interface. That
is why these are worse than the equivalent defects in the UI even though the code
looks tamer.

THE TWO FIXTURES HERE ARE THE ONLY ONES THAT CAN TELL BROKEN FROM FIXED:

  a command that FAILS      — with a succeeding command, `exit_code: 0` and
                              `success: True` were already the right answer, so
                              the hardcoded values were indistinguishable from
                              real ones.
  a file LARGER than the cap — with a small file, `truncated` is false either way
                              and the content is complete either way.

That is the same test-design mistake as a total computed from its own page, a
search count asserted below the cap, and an optimistic UI asserted on a successful
response — four defects this session, one mistake behind all of them.

PRECISELY WHAT IS AND IS NOT IDENTICAL, since the reverts made me sharpen it: on a
succeeding command the old code's `success: True` and `exit_code: 0` were the
CORRECT VALUES, so those two fields could not distinguish hardcoded from measured.
The guard-rail tests below still fail against the old code, but only because they
also assert `exit_status_known` / `truncated`, which the old responses lacked
entirely — that is a shape difference, not a value one. Had this fix reused the
existing fields instead of adding new ones, the success-path tests would have
passed on the defect exactly as they did in the ui equivalent (app#218).
"""
from __future__ import annotations

import json
import os
import subprocess
from unittest import mock

import pytest

from app import chat, filesystem
from app.config import FilesystemConfig


# ── read_file: a truncated read must say so ─────────────────────────────


@pytest.fixture
def fs_tmp(tmp_path):
    filesystem.configure(FilesystemConfig(allowed_paths=[str(tmp_path)]), emitter=None)
    return tmp_path


def test_read_file_larger_than_cap_reports_truncated(fs_tmp):
    """POSITIVE CONTROL. A small file cannot distinguish the versions."""
    big = fs_tmp / "big.log"
    big.write_text("x" * (filesystem.READ_LIMIT_CHARS + 5_000))

    result = json.loads(_run(filesystem.read_file(str(big))))

    assert result["success"] is True
    # The field that matters. Without it the agent concludes "the error is not in
    # this file" from content that stops a megabyte in.
    assert result["truncated"] is True
    assert result["chars_returned"] == filesystem.READ_LIMIT_CHARS
    assert result["size_bytes"] == filesystem.READ_LIMIT_CHARS + 5_000
    assert len(result["content"]) == filesystem.READ_LIMIT_CHARS


def test_read_file_exactly_at_the_cap_is_not_truncated(fs_tmp):
    """The boundary the old code could never have got right.

    `len(content) == limit` is true both for a file of exactly the limit and for
    one that was cut, which is why truncation is detected by reading one more
    character rather than by comparing lengths.
    """
    exact = fs_tmp / "exact.log"
    exact.write_text("y" * filesystem.READ_LIMIT_CHARS)

    result = json.loads(_run(filesystem.read_file(str(exact))))

    assert result["truncated"] is False
    assert result["chars_returned"] == filesystem.READ_LIMIT_CHARS


def test_read_file_small_reports_whole(fs_tmp):
    """Guard rail — passes on the BROKEN code too, which is why it is not the control."""
    small = fs_tmp / "small.txt"
    small.write_text("hello")

    result = json.loads(_run(filesystem.read_file(str(small))))

    assert result["success"] is True
    assert result["truncated"] is False
    assert result["content"] == "hello"


def _run(coro):
    """asyncio.run, not get_event_loop — the latter was removed in Python 3.14."""
    import asyncio

    return asyncio.run(coro)


# ── _run_visible_command: the exit code must be real ────────────────────


def _fake_send(returncode: int = 0, stderr: bytes = b""):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=b"", stderr=stderr)


def test_failing_command_is_not_reported_as_success():
    """POSITIVE CONTROL. With a succeeding command the hardcoded values were right."""
    pane = f"$ false\n{chat._EXIT_SENTINEL}1\n"

    with mock.patch.object(chat, "_ensure_tmux_session"), \
         mock.patch.object(chat.subprocess, "run", return_value=_fake_send()), \
         mock.patch.object(chat, "_wait_and_capture", return_value=pane):
        result = json.loads(chat._run_visible_command("false"))

    # Previously: success True, exit_code 0, unconditionally.
    assert result["success"] is False
    assert result["exit_code"] == 1
    assert result["exit_status_known"] is True
    # The sentinel is plumbing and must not leak into what the agent reads.
    assert chat._EXIT_SENTINEL not in result["output"]


def test_succeeding_command_still_reports_success():
    """Guard rail. Passes on the broken code as well — the point of the file header."""
    pane = f"$ true\n{chat._EXIT_SENTINEL}0\n"

    with mock.patch.object(chat, "_ensure_tmux_session"), \
         mock.patch.object(chat.subprocess, "run", return_value=_fake_send()), \
         mock.patch.object(chat, "_wait_and_capture", return_value=pane):
        result = json.loads(chat._run_visible_command("true"))

    assert result["success"] is True
    assert result["exit_code"] == 0
    assert result["exit_status_known"] is True


def test_unknown_status_is_reported_as_unknown_not_as_success():
    """No sentinel came back: the prompt was never detected, or it timed out.

    Reporting a success we did not observe is the defect. Reporting a failure we
    did not observe is at worst wasted work — an agent told "unknown"
    investigates, one told "success" builds on it.
    """
    with mock.patch.object(chat, "_ensure_tmux_session"), \
         mock.patch.object(chat.subprocess, "run", return_value=_fake_send()), \
         mock.patch.object(chat, "_wait_and_capture", return_value="$ slow-thing\nstill going"):
        result = json.loads(chat._run_visible_command("slow-thing"))

    assert result["success"] is False
    assert result["exit_code"] is None
    assert result["exit_status_known"] is False
    assert "could not be determined" in result["error"]


def test_send_keys_failure_is_not_reported_as_success():
    """If the keys never reached the shell the command did not run at all."""
    with mock.patch.object(chat, "_ensure_tmux_session"), \
         mock.patch.object(chat.subprocess, "run", return_value=_fake_send(1, b"no server running")):
        result = json.loads(chat._run_visible_command("ls"))

    assert result["success"] is False
    assert result["exit_status_known"] is False
    assert "no server running" in result["error"]


def test_sentinel_uses_semicolon_so_failures_still_report():
    """`&& echo` would skip the sentinel for exactly the commands this is for."""
    captured = {}

    def _capture(argv, **kwargs):
        captured["argv"] = argv
        return _fake_send()

    with mock.patch.object(chat, "_ensure_tmux_session"), \
         mock.patch.object(chat.subprocess, "run", side_effect=_capture), \
         mock.patch.object(chat, "_wait_and_capture", return_value=f"{chat._EXIT_SENTINEL}0"):
        chat._run_visible_command("might-fail")

    sent = captured["argv"][4]
    assert "; echo" in sent
    assert "&& echo" not in sent


def test_last_sentinel_wins_when_the_pane_has_history():
    """The pane holds 50 lines of scrollback, so older sentinels are visible."""
    pane = (
        f"$ old-command\n{chat._EXIT_SENTINEL}0\n"
        f"$ new-command\nboom\n{chat._EXIT_SENTINEL}2\n"
    )

    with mock.patch.object(chat, "_ensure_tmux_session"), \
         mock.patch.object(chat.subprocess, "run", return_value=_fake_send()), \
         mock.patch.object(chat, "_wait_and_capture", return_value=pane):
        result = json.loads(chat._run_visible_command("new-command"))

    # Taking the FIRST match would report the previous command's status — a
    # plausible number for the wrong command, which is the hardest kind to notice.
    assert result["exit_code"] == 2
    assert result["success"] is False
