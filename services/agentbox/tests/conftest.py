import pytest

from app import shell


@pytest.fixture(autouse=True)
def reset_shell_globals():
    """
    Reset app.shell module globals between tests.

    shell.configure() sets the module-level _policy, _emitter and _terminal.
    Several suites call it (tests/test_app_shell.py, tests/test_runtime.py) and
    nothing put them back, so the state leaked across files in alphabetical
    order. A live _terminal makes tools.execute_tool_call take the PTY branch
    (app/tools.py:509), so tests asserting on shell.execute_command saw it
    called zero times — passing alone, failing in a full run.
    """
    yield
    shell._policy = None
    shell._emitter = None
    shell._terminal = None
