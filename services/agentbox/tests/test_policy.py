"""Tests for app.policy — command and path policy enforcement."""

import os
import shutil
from unittest.mock import patch

import pytest

from app.policy import CommandPolicy, PathPolicy


class TestCommandPolicy:
    def test_allowed_binary_full_path(self):
        """Absolute path in allowlist works when binary resolves to that path."""
        echo_path = shutil.which("echo")
        if echo_path:
            real_path = os.path.realpath(echo_path)
            policy = CommandPolicy(allowed_binaries=[real_path])
            allowed, reason = policy.check("echo hello")
            assert allowed is True
        else:
            pytest.skip("echo not found in PATH")

    def test_short_name_resolves_to_allowed(self):
        """Short binary names are resolved to full paths at init."""
        policy = CommandPolicy(allowed_binaries=["echo"])
        allowed, reason = policy.check("echo hello")
        assert allowed is True
        assert reason == "ok"

    def test_short_name_execute_succeeds(self, tmp_path):
        """A command whose binary is in the allowlist by short name executes successfully."""
        policy = CommandPolicy(allowed_binaries=["echo"])
        result = policy.execute("echo success-marker", cwd=str(tmp_path))
        assert result["success"] is True
        assert result["exit_code"] == 0
        assert "success-marker" in result["stdout"]

    def test_resolve_preserves_absolute_paths(self):
        """Absolute paths in the allowlist are kept as-is."""
        echo_path = shutil.which("echo")
        real_path = os.path.realpath(echo_path)
        policy = CommandPolicy(allowed_binaries=[real_path])
        allowed, reason = policy.check("echo test")
        assert allowed is True

    def test_unresolvable_binary_kept(self):
        """Binary names that cannot be resolved are kept in the set."""
        policy = CommandPolicy(allowed_binaries=["nonexistent_binary_xyz"])
        # The unresolvable name should still be in the set
        assert "nonexistent_binary_xyz" in policy.allowed

    def test_denied_pattern_blocks(self):
        policy = CommandPolicy(denied_patterns=[r"rm\s+-rf\s+/"])
        allowed, reason = policy.check("rm -rf /")
        assert allowed is False
        assert "denied pattern" in reason

    def test_denied_pattern_fork_bomb(self):
        policy = CommandPolicy(denied_patterns=[r":\(\)\{"])
        allowed, reason = policy.check(":(){ :|:& };:")
        assert allowed is False

    def test_empty_command(self):
        policy = CommandPolicy()
        allowed, reason = policy.check("")
        assert allowed is False
        assert "Empty" in reason

    def test_unparseable_command(self):
        policy = CommandPolicy()
        allowed, reason = policy.check("echo 'unterminated")
        assert allowed is False
        assert "parse" in reason.lower()

    def test_no_allowlist_permits_all(self):
        """With empty allowlist, binary check is skipped."""
        policy = CommandPolicy(allowed_binaries=[])
        allowed, reason = policy.check("anything arg1 arg2")
        assert allowed is True

    def test_binary_not_in_allowlist(self):
        policy = CommandPolicy(allowed_binaries=["/usr/bin/git"])
        allowed, reason = policy.check("curl http://example.com")
        assert allowed is False
        assert "not in allowlist" in reason

    def test_execute_returns_dict(self):
        policy = CommandPolicy()
        result = policy.execute("echo hello")
        assert isinstance(result, dict)
        assert "success" in result

    def test_execute_denied_command(self):
        policy = CommandPolicy(denied_patterns=[r"rm\s+-rf"])
        result = policy.execute("rm -rf /tmp")
        assert result["success"] is False
        assert "denied pattern" in result["error"]

    def test_timeout_clamped(self, tmp_path):
        """The comment said "Timeout should be clamped" and the assertion
        only checked `isinstance(result, dict)` — true whether or not
        timeout=999 was actually clamped to max_timeout=10, since `echo
        fast` finishes long before either value elapses. It was also true
        regardless of whether the command even succeeded: the original
        test never passed a real `cwd`, so `execute()`'s own default
        (`/home/agentuser`) doesn't exist outside the real container —
        verified directly, the command actually fails in a bare host
        environment like this one, and `isinstance({"success": False,
        ...}, dict)` is still `True`, so the old assertion never noticed.

        Found during a "tests that cannot fail" sweep across hill90-app's
        test suites, dispatched in this conversation. test_runtime.py's
        own test_shell_command_timeout_clamped_to_max does this correctly
        one layer up (mocking shell.execute_command to capture the
        runtime's clamped value) — that pattern was available and not
        applied here. Same idea, applied at the layer this test actually
        calls: capture the real `timeout` kwarg CommandPolicy.execute
        passes to subprocess.run. `cwd=str(tmp_path)` matches this file's
        own test_short_name_execute_succeeds, the established way other
        tests in this file make `echo` actually succeed.
        """
        policy = CommandPolicy(max_timeout=10)

        captured = {}
        real_run = __import__("subprocess").run

        def spy_run(argv, **kwargs):
            captured["timeout"] = kwargs.get("timeout")
            return real_run(argv, **kwargs)

        with patch("app.policy.subprocess.run", side_effect=spy_run):
            result = policy.execute("echo fast", timeout=999, cwd=str(tmp_path))

        # THE ASSERTION THAT MATTERS: the value actually handed to the
        # subprocess call, not merely that execute() returned a dict.
        assert captured["timeout"] == 10
        assert result["success"] is True

    def test_execute_echo(self, tmp_path):
        """Verify actual execution works with no allowlist."""
        policy = CommandPolicy()
        result = policy.execute("echo test-output", cwd=str(tmp_path))
        assert result["success"] is True
        assert "test-output" in result["stdout"]
        assert result["exit_code"] == 0


class TestPathPolicy:
    def test_allowed_read(self, tmp_path):
        policy = PathPolicy(allowed_paths=[str(tmp_path)])
        test_file = tmp_path / "test.txt"
        test_file.write_text("hello")
        allowed, reason = policy.check_read(str(test_file))
        assert allowed is True

    def test_denied_read(self):
        policy = PathPolicy(
            allowed_paths=["/workspace"],
            denied_paths=["/workspace/secrets"],
        )
        allowed, reason = policy.check_read("/workspace/secrets/key.pem")
        assert allowed is False
        assert "denied" in reason.lower()

    def test_outside_allowed(self):
        policy = PathPolicy(allowed_paths=["/workspace"])
        allowed, reason = policy.check_read("/etc/passwd")
        assert allowed is False
        assert "not in allowed" in reason.lower()

    def test_write_when_read_only(self):
        policy = PathPolicy(allowed_paths=["/workspace"], read_only=True)
        allowed, reason = policy.check_write("/workspace/file.txt")
        assert allowed is False
        assert "read-only" in reason.lower()

    def test_write_when_writable(self, tmp_path):
        policy = PathPolicy(allowed_paths=[str(tmp_path)], read_only=False)
        allowed, reason = policy.check_write(str(tmp_path / "file.txt"))
        assert allowed is True

    def test_symlink_resolution(self, tmp_path):
        """Symlinks should be resolved to real paths before checking."""
        real_dir = tmp_path / "real"
        real_dir.mkdir()
        link = tmp_path / "link"
        link.symlink_to(real_dir)

        policy = PathPolicy(allowed_paths=[str(real_dir)])
        allowed, _ = policy.check_read(str(link / "file.txt"))
        assert allowed is True

    def test_path_traversal_blocked(self, tmp_path):
        """Path traversal via .. should be resolved and blocked."""
        allowed_dir = tmp_path / "allowed"
        allowed_dir.mkdir()

        policy = PathPolicy(allowed_paths=[str(allowed_dir)])
        allowed, reason = policy.check_read(str(allowed_dir / ".." / "other" / "file"))
        assert allowed is False
