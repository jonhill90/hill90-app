"""Unit tests for PTY shell execution."""


from unittest.mock import patch

from app.pty_shell import PtyResult, execute_streaming


class TestExecuteStreaming:
    def test_simple_echo(self):
        """PTY captures echo output."""
        chunks: list[bytes] = []
        gen = execute_streaming(
            ["echo", "hello PTY"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=10,
        )
        result = None
        try:
            while True:
                chunks.append(next(gen))
        except StopIteration as e:
            result = e.value

        output = b"".join(chunks).decode("utf-8", errors="replace")
        assert "hello PTY" in output
        assert isinstance(result, PtyResult)
        assert result.exit_code == 0
        assert result.timed_out is False

    def test_exit_code_nonzero(self):
        """PTY captures non-zero exit codes."""
        gen = execute_streaming(
            ["sh", "-c", "exit 42"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=10,
        )
        result = None
        try:
            while True:
                next(gen)
        except StopIteration as e:
            result = e.value

        assert result is not None
        assert result.exit_code == 42
        assert result.timed_out is False

    def test_timeout(self):
        """PTY enforces timeout."""
        gen = execute_streaming(
            ["sleep", "60"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=1,
        )
        result = None
        try:
            while True:
                next(gen)
        except StopIteration as e:
            result = e.value

        assert result is not None
        assert result.timed_out is True

    def test_timeout_survives_the_process_already_having_exited(self):
        """The timeout-kill os.kill(pid, SIGTERM) is unguarded — a narrow but
        routine race (the child exits in the gap between the last liveness
        check and this call) raises ProcessLookupError with no handler,
        which used to propagate out of the generator uncaught: the caller
        (terminal_log.py) catches it with a bare `except Exception`, but that
        catch discards WHICH kind of failure this was, silently downgrading
        a timeout to a generic non-timeout failure and losing the timeout
        diagnostic at exactly the moment (a hung command) it matters most.
        The two SIBLING kill/waitpid calls two lines below are already
        correctly guarded — this pins the first one to match.
        """
        with patch("app.pty_shell.os.kill", side_effect=ProcessLookupError("no such process")):
            gen = execute_streaming(
                ["sleep", "5"],
                env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
                cwd="/tmp",
                timeout=1,
            )
            result = None
            try:
                while True:
                    next(gen)
            except StopIteration as e:
                result = e.value

        # THE ASSERTION THAT MATTERS: the generator must complete normally —
        # reporting a real timeout — rather than raising ProcessLookupError
        # out to the caller.
        assert result is not None
        assert result.timed_out is True

    def test_sigterm_grace_period_is_real(self):
        """The timeout path's own comment claimed the killed process gets 2s
        to terminate gracefully after SIGTERM. It did not: the single
        os.waitpid(pid, os.WNOHANG) between SIGTERM and SIGKILL is
        non-blocking, so it returns immediately regardless of whether the
        child has exited, and SIGKILL follows SIGTERM within microseconds.

        POSITIVE CONTROL: a child that traps SIGTERM and needs real wall
        time to run its handler (sleep 0.3 before printing and exiting) is
        killed before the trap can complete under the old code — the marker
        below never reaches the output. With a real grace period the trap
        has time to run, print its marker, and exit on its own.
        """
        gen = execute_streaming(
            [
                "sh", "-c",
                # A foreground external command (e.g. `sleep 60`) makes the
                # shell block in wait() for its child, and a signal sent to
                # the shell does not propagate to that child — the trap
                # would not run until the child itself exits. Looping on a
                # short builtin-adjacent sleep instead means control returns
                # to the shell often enough for it to notice and run the
                # trap almost immediately after SIGTERM.
                'trap \'sleep 0.3; echo GRACEFUL_TRAP_COMPLETED; exit 7\' TERM; while :; do sleep 0.1; done',
            ],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=1,
        )
        chunks: list[bytes] = []
        result = None
        try:
            while True:
                chunks.append(next(gen))
        except StopIteration as e:
            result = e.value

        output = b"".join(chunks).decode("utf-8", errors="replace")

        # THE ASSERTION THAT MATTERS: the trap handler's own output must
        # have been captured, proving SIGKILL did not arrive before the
        # handler had a chance to run to completion.
        assert "GRACEFUL_TRAP_COMPLETED" in output
        assert result is not None
        assert result.timed_out is True

    def test_multiline_output(self):
        """PTY streams multi-line output."""
        gen = execute_streaming(
            ["sh", "-c", "echo line1; echo line2; echo line3"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=10,
        )
        chunks: list[bytes] = []
        try:
            while True:
                chunks.append(next(gen))
        except StopIteration:
            pass

        output = b"".join(chunks).decode("utf-8", errors="replace")
        assert "line1" in output
        assert "line2" in output
        assert "line3" in output

    def test_invalid_command(self):
        """PTY handles command not found."""
        gen = execute_streaming(
            ["nonexistent_binary_xyz"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=5,
        )
        chunks: list[bytes] = []
        result = None
        try:
            while True:
                chunks.append(next(gen))
        except StopIteration as e:
            result = e.value

        assert result is not None
        # Should get a non-zero exit code (127 for command not found)
        assert result.exit_code != 0
