"""Truncated command output must say so (#221).

THE DEFECT, in three places in `app/policy.py`: `stdout[:100_000]`,
`stderr[:10_000]` on both `execute` and `execute_streaming`, and the live
emission stopping at `max_lines` while the command kept running. None disclosed
anything. **Believes:** it has the command's complete output. **True:** it has
the first 100,000 characters, or the first `max_lines` events.

WHY IT MATTERS MOST HERE. The consumer is an agent. `shell.py:115` returns
`json.dumps(result)` straight into the model's context, so an agent that runs
`grep -rn x .` over a large tree and reads 100,000 characters concludes *those
are all the matches*, and that conclusion is load-bearing for whatever it does
next. Nothing downstream can correct it.

THE PAIR. #224 made the exit code honest; this makes the content honest. A
half-run command that reported success cleanly needed both.

THE FIXTURE MUST EXCEED THE CAP, which is the whole test design: with output
under the cap the truncating and disclosing versions return byte-identical
dicts, so a small fixture passes on the defect. Every positive control here
produces more than the limit, and each is paired with an under-cap twin that
must behave the same either way.

NOT EXERCISED: `subprocess` is stubbed. No real command was run, and the caps
themselves are unchanged and untested here — what is asserted is that a cut is
declared, not that cutting at 100k is the right bound.
"""
from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock, patch

from app import shell
from app.config import ShellConfig
from app.policy import (
    STDERR_LIMIT_CHARS,
    STDOUT_LIMIT_CHARS,
    CommandPolicy,
    truncate_with_disclosure,
)


def _policy() -> CommandPolicy:
    return CommandPolicy(allowed_binaries=["echo"], denied_patterns=[])


def _configured_shell(emitter):
    """`shell` keeps module-level state; configure it the way the app does."""
    shell.configure(
        ShellConfig(enabled=True, allowed_binaries=["echo"], denied_patterns=[], max_timeout=300),
        emitter=emitter,
        log_dir="/tmp/agentbox-test-logs",
    )


class TestTheHelper:
    def test_positive_control_over_the_limit_is_cut_and_declared(self):
        text, truncated, total = truncate_with_disclosure("x" * 150, 100)
        assert len(text) == 100
        assert truncated is True
        assert total == 150

    def test_TWIN_under_the_limit_is_untouched(self):
        # The fixture that cannot distinguish the versions.
        text, truncated, total = truncate_with_disclosure("x" * 50, 100)
        assert text == "x" * 50
        assert truncated is False
        assert total == 50

    def test_exactly_the_limit_is_not_a_cut(self):
        text, truncated, total = truncate_with_disclosure("x" * 100, 100)
        assert truncated is False
        assert total == 100


class TestExecute:
    def _run(self, stdout: str, stderr: str = "") -> dict:
        completed = MagicMock(returncode=0, stdout=stdout, stderr=stderr)
        with patch("app.policy.subprocess.run", return_value=completed):
            return _policy().execute("echo hi")

    def test_positive_control_oversized_stdout_is_declared_with_the_real_size(self):
        produced = STDOUT_LIMIT_CHARS + 5_000
        result = self._run("y" * produced)

        assert result["stdout_truncated"] is True
        assert result["stdout_chars_returned"] == STDOUT_LIMIT_CHARS
        assert result["stdout_chars_total"] == produced          # the real size
        assert len(result["stdout"]) == STDOUT_LIMIT_CHARS

    def test_TWIN_small_stdout_reports_no_truncation(self):
        result = self._run("hello")

        assert result["stdout_truncated"] is False
        assert result["stdout_chars_returned"] == 5
        assert result["stdout_chars_total"] == 5
        assert result["stdout"] == "hello"

    def test_stderr_has_its_own_smaller_cap_and_its_own_disclosure(self):
        # Two caps, so a fix applied to one and not the other is the twin
        # failure this repository keeps meeting.
        result = self._run("ok", "e" * (STDERR_LIMIT_CHARS + 1))

        assert result["stderr_truncated"] is True
        assert result["stderr_chars_total"] == STDERR_LIMIT_CHARS + 1
        assert result["stdout_truncated"] is False

    def test_the_output_itself_is_NOT_annotated(self):
        # Deliberate, and different from the prose case in #263: stdout is DATA
        # an agent may parse. Appending a sentence to `grep` output would be a
        # new defect, so the disclosure travels beside it, never inside it.
        result = self._run("y" * (STDOUT_LIMIT_CHARS + 10))

        assert set(result["stdout"]) == {"y"}
        assert "truncat" not in result["stdout"].lower()


class TestExecuteStreamingLiveCap:
    """The third site: the LIVE stream stops while the command keeps running."""

    def _run_streaming(self, produced_lines: int, max_lines: int, on_output=None) -> dict:
        proc = MagicMock()
        proc.stdout = iter([f"line {i}\n" for i in range(produced_lines)])
        proc.stderr = MagicMock(read=MagicMock(return_value=""))
        proc.returncode = 0
        proc.wait = MagicMock(return_value=0)
        with patch("app.policy.subprocess.Popen", return_value=proc):
            return _policy().execute_streaming(
                "echo hi", on_output=on_output, max_lines=max_lines
            )

    def test_positive_control_a_stream_cut_early_says_so_and_counts_both(self):
        seen: list[str] = []
        result = self._run_streaming(produced_lines=50, max_lines=10, on_output=seen.append)

        assert len(seen) == 10                       # what the agent watched
        assert result["lines_emitted"] == 10
        assert result["lines_total"] == 50           # what the command produced
        assert result["output_stream_truncated"] is True

    def test_TWIN_a_stream_under_the_cap_is_not_reported_as_cut(self):
        seen: list[str] = []
        result = self._run_streaming(produced_lines=5, max_lines=10, on_output=seen.append)

        assert len(seen) == 5
        assert result["lines_emitted"] == 5
        assert result["lines_total"] == 5
        assert result["output_stream_truncated"] is False

    def test_with_no_live_consumer_there_is_no_live_truncation_to_report(self):
        # Nothing was watching, so nothing was cut short for a watcher. The full
        # stdout still goes through the same disclosure as `execute`.
        result = self._run_streaming(produced_lines=50, max_lines=10, on_output=None)

        assert result["output_stream_truncated"] is False
        assert result["lines_total"] == 50

    def test_the_returned_stdout_carries_the_same_fields_as_execute(self):
        # One vocabulary across both paths — the whole reason #221 was filed as
        # one issue rather than three fixes.
        result = self._run_streaming(produced_lines=3, max_lines=10, on_output=None)

        for key in ("stdout_truncated", "stdout_chars_returned", "stdout_chars_total",
                    "stderr_truncated", "stderr_chars_returned", "stderr_chars_total"):
            assert key in result, f"streaming result is missing {key}"


class TestWhatTheHumanSees:
    @staticmethod
    def _proc(lines: list[str]) -> MagicMock:
        proc = MagicMock()
        proc.stdout = iter(lines)
        proc.stderr = MagicMock(read=MagicMock(return_value=""))
        proc.returncode = 0
        proc.wait = MagicMock(return_value=0)
        return proc

    def test_positive_control_the_completion_event_names_the_cut(self):
        # An emitter means shell takes the STREAMING path, so this drives Popen.
        # 120 lines of 1,000 chars clears the 100k cap without tripping the
        # per-line cap (4,096) or the live-emission cap (1,000 lines) — one
        # truncation at a time, or the assertion would not say which fired.
        emitter = MagicMock()
        lines = [("y" * 999) + "\n" for _ in range(120)]
        with patch("app.policy.subprocess.Popen", return_value=self._proc(lines)):
            _configured_shell(emitter)
            asyncio.run(shell.execute_command("echo hi"))

        summaries = [
            c.kwargs.get("output_summary", "")
            for c in emitter.emit.call_args_list
            if c.kwargs.get("type") == "command_complete"
        ]
        assert summaries, "no command_complete event was emitted"
        assert "CUT" in summaries[0]
        assert str(120 * 1000) in summaries[0]      # the real size, not the cap

    def test_TWIN_a_complete_command_says_nothing_about_cuts(self):
        emitter = MagicMock()
        with patch("app.policy.subprocess.Popen", return_value=self._proc(["hi\n"])):
            _configured_shell(emitter)
            asyncio.run(shell.execute_command("echo hi"))

        summaries = [
            c.kwargs.get("output_summary", "")
            for c in emitter.emit.call_args_list
            if c.kwargs.get("type") == "command_complete"
        ]
        assert "CUT" not in summaries[0]

    def test_the_disclosure_survives_serialisation_into_the_tool_result(self):
        # `shell.py` returns json.dumps(result) straight into the model's
        # context, so the fields have to be there after serialising.
        completed = MagicMock(
            returncode=0, stdout="y" * (STDOUT_LIMIT_CHARS + 1), stderr=""
        )
        with patch("app.policy.subprocess.run", return_value=completed):
            _configured_shell(None)
            body = json.loads(asyncio.run(shell.execute_command("echo hi")))

        assert body["stdout_truncated"] is True
        assert body["stdout_chars_total"] == STDOUT_LIMIT_CHARS + 1
