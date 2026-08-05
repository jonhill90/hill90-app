"""Tests for app.tools — tool definitions and dispatcher."""

import json
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest

from app.config import FilesystemConfig, ShellConfig, ToolsConfig
from app.tools import build_tool_definitions, execute_tool_call


class TestBuildToolDefinitions:
    def test_no_tools_when_disabled(self):
        config = ToolsConfig()
        assert build_tool_definitions(config) == []

    def test_shell_only(self):
        config = ToolsConfig(shell=ShellConfig(enabled=True))
        defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert "execute_command" in names
        assert "tmux" in names

    def test_filesystem_only(self):
        config = ToolsConfig(filesystem=FilesystemConfig(enabled=True))
        defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert "read_file" in names
        assert "write_file" in names
        assert "list_directory" in names
        assert "execute_command" not in names

    def test_filesystem_read_only(self):
        config = ToolsConfig(filesystem=FilesystemConfig(enabled=True, read_only=True))
        defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert "read_file" in names
        assert "write_file" not in names
        assert "list_directory" in names

    def test_all_tools(self):
        config = ToolsConfig(
            shell=ShellConfig(enabled=True),
            filesystem=FilesystemConfig(enabled=True),
        )
        defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert len(names) == 8
        assert "execute_command" in names
        assert "read_file" in names
        assert "browser" in names
        assert "write_file" in names
        assert "list_directory" in names
        assert "tmux" in names
        assert "http_request" in names
        assert "git" in names

    def test_tool_definitions_are_valid_openai_format(self):
        config = ToolsConfig(
            shell=ShellConfig(enabled=True),
            filesystem=FilesystemConfig(enabled=True),
        )
        defs = build_tool_definitions(config)
        for d in defs:
            assert d["type"] == "function"
            func = d["function"]
            assert "name" in func
            assert "description" in func
            assert "parameters" in func
            assert func["parameters"]["type"] == "object"
            assert "required" in func["parameters"]


class TestExecuteToolCall:
    @pytest.mark.asyncio
    @patch("app.tools.shell.execute_command", new_callable=AsyncMock)
    async def test_execute_command(self, mock_exec):
        mock_exec.return_value = json.dumps({"success": True, "exit_code": 0, "stdout": "hello\n", "stderr": ""})
        result = await execute_tool_call("execute_command", {"command": "echo hello", "timeout": 10})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_exec.assert_called_once_with("echo hello", timeout=10, command_id=ANY, work_id=None)

    @pytest.mark.asyncio
    @patch("app.tools.shell.execute_command", new_callable=AsyncMock)
    async def test_execute_command_generates_command_id(self, mock_exec):
        mock_exec.return_value = json.dumps({"success": True})
        await execute_tool_call("execute_command", {"command": "ls"})
        _, kwargs = mock_exec.call_args
        # command_id should be a valid UUID string
        import uuid
        uuid.UUID(kwargs["command_id"])  # raises if not valid

    @pytest.mark.asyncio
    @patch("app.tools.shell.execute_command_pty", new_callable=AsyncMock)
    @patch("app.tools.shell._terminal", new="fake-terminal")
    async def test_prefers_pty_when_terminal_configured(self, mock_pty):
        """When terminal logger is configured, execute_command uses PTY path."""
        mock_pty.return_value = json.dumps({"success": True, "exit_code": 0, "stdout": "", "stderr": ""})
        result = await execute_tool_call("execute_command", {"command": "git status"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_pty.assert_called_once_with("git status", timeout=30, command_id=ANY, work_id=None)

    @pytest.mark.asyncio
    @patch("app.tools.filesystem.read_file", new_callable=AsyncMock)
    async def test_read_file(self, mock_read):
        mock_read.return_value = json.dumps({"success": True, "content": "data", "path": "/workspace/f.txt"})
        result = await execute_tool_call("read_file", {"path": "/workspace/f.txt"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_read.assert_called_once_with("/workspace/f.txt")

    @pytest.mark.asyncio
    @patch("app.tools.filesystem.write_file", new_callable=AsyncMock)
    async def test_write_file(self, mock_write):
        mock_write.return_value = json.dumps({"success": True, "path": "/workspace/f.txt", "bytes_written": 4})
        result = await execute_tool_call("write_file", {"path": "/workspace/f.txt", "content": "data"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_write.assert_called_once_with("/workspace/f.txt", "data")

    @pytest.mark.asyncio
    @patch("app.tools.filesystem.list_directory", new_callable=AsyncMock)
    async def test_list_directory(self, mock_list):
        mock_list.return_value = json.dumps({"success": True, "path": "/workspace", "entries": []})
        result = await execute_tool_call("list_directory", {"path": "/workspace"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_list.assert_called_once_with("/workspace")

    @pytest.mark.asyncio
    async def test_unknown_tool(self):
        result = await execute_tool_call("unknown_tool", {})
        parsed = json.loads(result)
        assert parsed["success"] is False
        assert "Unknown tool" in parsed["error"]

    @pytest.mark.asyncio
    @patch("app.tools.shell.execute_command", new_callable=AsyncMock)
    async def test_bad_timeout_defaults_to_30(self, mock_exec):
        mock_exec.return_value = json.dumps({"success": True})
        await execute_tool_call("execute_command", {"command": "ls", "timeout": "invalid"})
        mock_exec.assert_called_once_with("ls", timeout=30, command_id=ANY, work_id=None)


class TestWebSearch:
    def test_web_search_included_when_configured(self):
        """web_search tool appears when TAVILY_API_KEY is set."""
        config = ToolsConfig(shell=ShellConfig(enabled=True))
        with patch.dict("os.environ", {"TAVILY_API_KEY": "tvly-test123"}):
            defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert "web_search" in names

    def test_web_search_excluded_when_not_configured(self):
        """web_search tool does not appear without TAVILY_API_KEY."""
        config = ToolsConfig(shell=ShellConfig(enabled=True))
        with patch.dict("os.environ", {}, clear=True):
            defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert "web_search" not in names

    @pytest.mark.asyncio
    async def test_web_search_success(self):
        """Successful search returns formatted results."""
        import httpx

        tavily_response = {
            "results": [
                {"title": "Test Result", "url": "https://example.com", "content": "Test content", "score": 0.95},
            ],
            "answer": "Test answer",
        }

        mock_response = httpx.Response(200, json=tavily_response, request=httpx.Request("POST", "https://api.tavily.com/search"))

        with patch.dict("os.environ", {"TAVILY_API_KEY": "tvly-test123"}):
            with patch("httpx.AsyncClient") as MockClient:
                instance = AsyncMock()
                instance.post = AsyncMock(return_value=mock_response)
                MockClient.return_value.__aenter__ = AsyncMock(return_value=instance)
                MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
                result = await execute_tool_call("web_search", {"query": "test query"})

        parsed = json.loads(result)
        assert parsed["success"] is True
        assert len(parsed["results"]) == 1
        assert parsed["results"][0]["title"] == "Test Result"
        assert parsed["answer"] == "Test answer"

    @pytest.mark.asyncio
    async def test_web_search_missing_query(self):
        """Empty query returns error."""
        with patch.dict("os.environ", {"TAVILY_API_KEY": "tvly-test123"}):
            result = await execute_tool_call("web_search", {"query": ""})
        parsed = json.loads(result)
        assert parsed["success"] is False
        assert "required" in parsed["error"]

    @pytest.mark.asyncio
    async def test_web_search_no_api_key(self):
        """Missing API key returns error."""
        with patch.dict("os.environ", {}, clear=True):
            result = await execute_tool_call("web_search", {"query": "test"})
        parsed = json.loads(result)
        assert parsed["success"] is False
        assert "TAVILY_API_KEY" in parsed["error"]

    @pytest.mark.asyncio
    async def test_web_search_api_error(self):
        """API error returns graceful error."""
        import httpx

        mock_response = httpx.Response(500, text="Server Error", request=httpx.Request("POST", "https://api.tavily.com/search"))

        with patch.dict("os.environ", {"TAVILY_API_KEY": "tvly-test123"}):
            with patch("httpx.AsyncClient") as MockClient:
                instance = AsyncMock()
                instance.post = AsyncMock(return_value=mock_response)
                MockClient.return_value.__aenter__ = AsyncMock(return_value=instance)
                MockClient.return_value.__aexit__ = AsyncMock(return_value=False)
                result = await execute_tool_call("web_search", {"query": "test"})

        parsed = json.loads(result)
        assert parsed["success"] is False
        assert "500" in parsed["error"]


class TestTmuxListWindows:
    """`_execute_tmux`'s other five actions all check `result.returncode` before
    reporting success (see the `if result.returncode != 0` guard shared by every
    branch below). `list_windows` alone returns success unconditionally, straight
    off `result.stdout` — the same shape already fixed once in this codebase for
    chat.py's terminal-dispatch path. Untested until now: no test file referenced
    `_execute_tmux` or the `tmux` tool name at all.
    """

    @pytest.mark.asyncio
    @patch("app.tools.subprocess.run")
    async def test_list_windows_failure_is_not_reported_as_success(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="can't find session: agent")
        result = await execute_tool_call("tmux", {"action": "list_windows"})
        parsed = json.loads(result)
        assert parsed["success"] is False, f"expected failure to be reported, got: {parsed}"

    @pytest.mark.asyncio
    @patch("app.tools.subprocess.run")
    async def test_list_windows_success_still_reports_success(self, mock_run):
        """POSITIVE CONTROL — a fix that always returns False would also pass the
        test above for the wrong reason. This pins the success path too."""
        mock_run.return_value = MagicMock(returncode=0, stdout="0:zsh 1", stderr="")
        result = await execute_tool_call("tmux", {"action": "list_windows"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        assert parsed["windows"] == "0:zsh 1"


class TestGitStatusDiffResetCheckReturncode:
    """Sibling-drift sweep. `_execute_git`'s `add`, `commit`, and `log` actions
    each check `proc.returncode != 0` before reporting success — `status`,
    `diff`, and `reset` do not, and unconditionally return `{"success": True,
    ...}` regardless of what the underlying git process actually did. The
    same pattern was already fixed once in this file, for `_execute_tmux`'s
    `list_windows` action, whose own comment says exactly this: "Every
    sibling action above falls through to the shared `if result.returncode
    != 0` check... This one returned early with success hardcoded." That fix
    reached tmux; it never reached git's three siblings with the identical
    gap.
    """

    @staticmethod
    def _make_proc(returncode: int, stdout: bytes = b"", stderr: bytes = b""):
        proc = AsyncMock()
        proc.communicate = AsyncMock(return_value=(stdout, stderr))
        proc.wait = AsyncMock(return_value=returncode)
        proc.returncode = returncode
        return proc

    def _side_effect_for(self, failing_action: str, stderr: bytes = b"fatal: git error"):
        """Auto-init (git init / config x2) always succeeds; the action's own
        subcommand fails. Keyed on the first positional git subcommand arg."""
        def _side_effect(*args, **kwargs):
            subcommand = args[1] if len(args) > 1 else None
            if subcommand == failing_action:
                return self._make_proc(1, stderr=stderr)
            return self._make_proc(0)
        return _side_effect

    @pytest.mark.asyncio
    @patch("asyncio.create_subprocess_exec")
    async def test_status_failure_is_not_reported_as_success(self, mock_exec):
        mock_exec.side_effect = self._side_effect_for("status")
        result = await execute_tool_call("git", {"action": "status"})
        parsed = json.loads(result)
        assert parsed["success"] is False, f"expected failure to be reported, got: {parsed}"

    @pytest.mark.asyncio
    @patch("asyncio.create_subprocess_exec")
    async def test_status_success_still_reports_success(self, mock_exec):
        # POSITIVE CONTROL — a fix that always returns False would also pass
        # the test above for the wrong reason.
        mock_exec.side_effect = self._side_effect_for("__never_fails__")
        result = await execute_tool_call("git", {"action": "status"})
        parsed = json.loads(result)
        assert parsed["success"] is True

    @pytest.mark.asyncio
    @patch("asyncio.create_subprocess_exec")
    async def test_diff_failure_is_not_reported_as_success(self, mock_exec):
        mock_exec.side_effect = self._side_effect_for("diff")
        result = await execute_tool_call("git", {"action": "diff"})
        parsed = json.loads(result)
        assert parsed["success"] is False, f"expected failure to be reported, got: {parsed}"

    @pytest.mark.asyncio
    @patch("asyncio.create_subprocess_exec")
    async def test_diff_success_still_reports_success(self, mock_exec):
        mock_exec.side_effect = self._side_effect_for("__never_fails__")
        result = await execute_tool_call("git", {"action": "diff"})
        parsed = json.loads(result)
        assert parsed["success"] is True

    @pytest.mark.asyncio
    @patch("asyncio.create_subprocess_exec")
    async def test_reset_failure_is_not_reported_as_success(self, mock_exec):
        mock_exec.side_effect = self._side_effect_for("reset")
        result = await execute_tool_call("git", {"action": "reset"})
        parsed = json.loads(result)
        assert parsed["success"] is False, f"expected failure to be reported, got: {parsed}"

    @pytest.mark.asyncio
    @patch("asyncio.create_subprocess_exec")
    async def test_reset_success_still_reports_success(self, mock_exec):
        mock_exec.side_effect = self._side_effect_for("__never_fails__")
        result = await execute_tool_call("git", {"action": "reset"})
        parsed = json.loads(result)
        assert parsed["success"] is True
