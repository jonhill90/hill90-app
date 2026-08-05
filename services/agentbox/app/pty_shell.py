"""PTY-based shell execution with streaming output.

Wraps command execution in a pseudo-terminal so programs detect a TTY
and flush output per-line (enabling real-time progress bars, colored
output, and interactive feedback). Output is yielded as bytes chunks.
"""

from __future__ import annotations

import fcntl
import os
import pty
import select
import signal
import struct
import termios
import time
from dataclasses import dataclass
from typing import Generator

# Terminal size: 120 cols x 40 rows
TERM_COLS = 120
TERM_ROWS = 40
READ_SIZE = 4096
SELECT_TIMEOUT = 0.1  # 100ms poll
SIGTERM_GRACE_SECONDS = 2.0  # matches the comment this replaces; was never enforced
SIGTERM_POLL_INTERVAL = 0.05


@dataclass
class PtyResult:
    """Result of a PTY command execution."""
    exit_code: int
    timed_out: bool


def execute_streaming(
    argv: list[str],
    env: dict[str, str],
    cwd: str = os.path.expanduser("~"),
    timeout: int = 300,
) -> Generator[bytes, None, PtyResult]:
    """Execute command in a PTY, yielding output chunks as they arrive.

    Args:
        argv: Command argument vector (already parsed via shlex).
        env: Environment variables for the child process.
        cwd: Working directory.
        timeout: Maximum execution time in seconds.

    Yields:
        bytes: Raw terminal output chunks.

    Returns:
        PtyResult with exit_code and timed_out flag.
    """
    master_fd, slave_fd = pty.openpty()

    # Set terminal size
    winsize = struct.pack("HHHH", TERM_ROWS, TERM_COLS, 0, 0)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

    pid = os.fork()

    if pid == 0:
        # Child process
        os.setsid()
        os.dup2(slave_fd, 0)  # stdin
        os.dup2(slave_fd, 1)  # stdout
        os.dup2(slave_fd, 2)  # stderr
        os.close(master_fd)
        os.close(slave_fd)

        try:
            os.chdir(cwd)
        except OSError:
            pass

        try:
            os.execvpe(argv[0], argv, env)
        except OSError as e:
            os.write(2, f"exec failed: {e}\n".encode())
            os._exit(127)

    # Parent process
    os.close(slave_fd)

    # Non-blocking reads on master
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    elapsed = 0.0
    timed_out = False
    exited = False
    exit_code = -1

    try:
        while not exited:
            ready, _, _ = select.select([master_fd], [], [], SELECT_TIMEOUT)
            if ready:
                try:
                    data = os.read(master_fd, READ_SIZE)
                    if not data:
                        break
                    yield data
                except OSError:
                    break
            else:
                elapsed += SELECT_TIMEOUT
                if elapsed >= timeout:
                    # This whole branch fires only because the command has
                    # already gone wrong (hung past its timeout) — a narrow
                    # but routine race where the child exits in the gap
                    # between the last liveness check and this call raises
                    # ProcessLookupError here same as it would on the two
                    # kill/waitpid calls below, which are already guarded.
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except OSError:
                        pass
                    # Actually give the process SIGTERM_GRACE_SECONDS to
                    # terminate gracefully. The comment this replaces claimed
                    # a 2s grace period but the single os.waitpid(pid,
                    # os.WNOHANG) call below it was non-blocking — it
                    # returned immediately whether or not the child had
                    # exited, so SIGKILL always followed SIGTERM by
                    # microseconds. A child that traps SIGTERM to flush
                    # output or clean up never got the chance; it was killed
                    # before its handler could run.
                    # Drain interleaved with the reap poll, not after it: on
                    # this platform's pty, output the child wrote is not
                    # reliably still readable from master_fd once the child
                    # has actually exited and its slave fd is gone — reaping
                    # first and draining after can come back empty even
                    # though the child's SIGTERM handler visibly ran.
                    # Verified directly: interleaved reads captured the
                    # handler's output every time; read-after-reap did not.
                    reaped = False
                    grace_deadline = time.monotonic() + SIGTERM_GRACE_SECONDS
                    while time.monotonic() < grace_deadline:
                        drain_ready, _, _ = select.select([master_fd], [], [], SIGTERM_POLL_INTERVAL)
                        if drain_ready:
                            try:
                                data = os.read(master_fd, READ_SIZE)
                                if data:
                                    yield data
                            except OSError:
                                pass
                        try:
                            result_pid, _ = os.waitpid(pid, os.WNOHANG)
                            if result_pid != 0:
                                reaped = True
                                break
                        except ChildProcessError:
                            reaped = True
                            break
                    if not reaped:
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except OSError:
                            pass
                    # One more pass in case data landed between the last
                    # poll iteration and the reap/kill above.
                    while True:
                        drain_ready, _, _ = select.select([master_fd], [], [], 0.05)
                        if not drain_ready:
                            break
                        try:
                            data = os.read(master_fd, READ_SIZE)
                            if not data:
                                break
                            yield data
                        except OSError:
                            break
                    timed_out = True
                    break

            # Check if child exited (non-blocking)
            try:
                result_pid, status = os.waitpid(pid, os.WNOHANG)
                if result_pid != 0:
                    exited = True
                    exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
                    # Drain remaining output
                    while True:
                        drain_ready, _, _ = select.select([master_fd], [], [], 0.05)
                        if not drain_ready:
                            break
                        try:
                            data = os.read(master_fd, READ_SIZE)
                            if not data:
                                break
                            yield data
                        except OSError:
                            break
            except ChildProcessError:
                break
    finally:
        os.close(master_fd)

    if timed_out:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        return PtyResult(exit_code=-1, timed_out=True)

    if not exited:
        try:
            _, status = os.waitpid(pid, 0)
            exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
        except ChildProcessError:
            exit_code = -1

    return PtyResult(exit_code=exit_code, timed_out=False)
