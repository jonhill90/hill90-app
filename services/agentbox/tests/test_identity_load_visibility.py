"""What agentbox does when SOUL.md / RULES.md are MISSING, EMPTY, or
present-but-unreadable — established with tests, not by reading alone.

`app/runtime.py`'s `AgentRuntime._load_identity` is where SOUL.md and
RULES.md are actually read off disk; `app/chat.py`'s `handle_chat` then
concatenates whatever came back (possibly "") straight into the system
prompt with no further check (see `test_chat.py::test_no_system_prompt_when_empty`
— that half is already tested and is a deliberate no-op, not the defect).
Before this file, `_load_identity` collapsed MISSING and EMPTY into the
same silent `self.soul = ""` / `self.rules = ""` with no log line, no
event, nothing — `test_runtime.py::test_runtime_missing_identity_files`
already codified that as "handled gracefully," which is the silent half of
the house "silent success" defect family (CLAUDE.md's "Finding defects by
shape") landing in the one component — system-prompt assembly — where it
is hardest to notice: the agent answers normally and looks completely fine
doing it.

THE ARGUED POLICY (not assumed): neither file's loss should make agentbox
refuse to *start* — a bad mount or a stray permission bit on one agent
instance is an operational fault, not grounds to take the whole container
down, and turning it into a hard boot failure trades a quiet defect for a
loud outage, which is not obviously the better trade. Both states must stop
being silent, though, and they are not equally bad: RULES.md carries the
agent's operating constraints (`chat.py`'s own header: "Agentbox reads
identity from mounted files (SOUL.md + RULES.md with baked-in skill
instructions)"), and losing it fails OPEN — the agent keeps answering,
just with no rules constraining it, which is worse than SOUL.md's loss
(identity/voice, not a safety boundary). So: SOUL.md logs at WARNING,
RULES.md at ERROR, and both emit a queryable `identity_load_degraded`
event through the same `EventEmitter` every other tool call in this
codebase already writes through — visible in `events.jsonl`, and via the
emitter's own documented stderr fallback, in Loki even if the event file
write itself fails.

UNREADABLE (permission denied) is NOT changed by this fix and is tested
here only to record what it does: reading raises inside `_load_identity`,
which runs in `AgentRuntime.__init__`, uncaught — `server.py`'s
`create_app` has no try/except around the constructor, so this already
crashes agentbox at startup with a visible traceback. That is loud, if
crude — a clean negative for that one sub-case each file, left as is.
"""

from __future__ import annotations

import builtins
import io
import json
import logging

import pytest

from app.config import AgentConfig
from app.events import EventEmitter
from app.runtime import AgentRuntime


def _make_config() -> AgentConfig:
    return AgentConfig(version=1, id="test-agent", name="Test Agent", description="A test agent")


def _mock_identity_files(monkeypatch, *, soul=None, rules=None, unreadable=frozenset()):
    """soul/rules: None -> file missing; "" or a string -> file exists with that content.
    unreadable: subset of {"soul", "rules"} -- open() raises PermissionError for that path,
    overriding whatever soul/rules says (the file "exists" but cannot be read).
    """
    contents = {"/etc/agentbox/SOUL.md": soul, "/etc/agentbox/RULES.md": rules}
    unreadable_paths = set()
    if "soul" in unreadable:
        unreadable_paths.add("/etc/agentbox/SOUL.md")
    if "rules" in unreadable:
        unreadable_paths.add("/etc/agentbox/RULES.md")

    def mock_exists(path):
        if path in contents:
            return contents[path] is not None or path in unreadable_paths
        return False

    real_open = builtins.open

    def mock_open(path, *args, **kwargs):
        if path in unreadable_paths:
            raise PermissionError(f"[Errno 13] Permission denied: '{path}'")
        if path in contents and contents[path] is not None:
            return io.StringIO(contents[path])
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr("os.path.exists", mock_exists)
    monkeypatch.setattr(builtins, "open", mock_open)


def _build_emitter(tmp_path):
    log_path = tmp_path / "events.jsonl"
    return EventEmitter(str(log_path)), log_path


def _events(log_path):
    # Not log_path.exists(): pathlib delegates to os.path.exists internally in
    # this interpreter, which these tests monkeypatch to answer for identity
    # file paths only -- it would misreport this unrelated path as absent.
    try:
        text = log_path.read_text()
    except FileNotFoundError:
        return []
    return [json.loads(line) for line in text.strip().split("\n") if line]


class TestSoulMissingOrEmptyIsNoLongerSilent:
    def test_soul_missing_is_logged_and_emitted(self, tmp_path, monkeypatch, caplog):
        _mock_identity_files(monkeypatch, soul=None, rules="some rules")
        emitter, log_path = _build_emitter(tmp_path)

        with caplog.at_level(logging.WARNING):
            runtime = AgentRuntime(_make_config(), emitter, None)

        assert runtime.soul == ""
        assert any("SOUL.md" in r.getMessage() and "missing" in r.getMessage() for r in caplog.records), (
            "SOUL.md missing must be logged at WARNING or above -- it was previously silent"
        )
        degraded = [e for e in _events(log_path) if e["type"] == "identity_load_degraded"]
        assert any(e["metadata"]["file"] == "SOUL.md" and e["metadata"]["state"] == "missing" for e in degraded), (
            "SOUL.md missing must be visible as a queryable event, not just a log line"
        )

    def test_soul_empty_is_logged_and_emitted_distinctly_from_missing(self, tmp_path, monkeypatch, caplog):
        _mock_identity_files(monkeypatch, soul="", rules="some rules")
        emitter, log_path = _build_emitter(tmp_path)

        with caplog.at_level(logging.WARNING):
            runtime = AgentRuntime(_make_config(), emitter, None)

        assert runtime.soul == ""
        assert any("SOUL.md" in r.getMessage() and "empty" in r.getMessage() for r in caplog.records), (
            "SOUL.md present-but-empty must be logged, and must say 'empty' rather than 'missing' -- "
            "these are different operational facts and were previously indistinguishable"
        )
        degraded = [e for e in _events(log_path) if e["type"] == "identity_load_degraded"]
        assert any(e["metadata"]["file"] == "SOUL.md" and e["metadata"]["state"] == "empty" for e in degraded)

    def test_soul_whitespace_only_counts_as_empty(self, tmp_path, monkeypatch, caplog):
        """A file containing only whitespace has no usable identity content --
        must not be treated as 'ok' just because it is non-empty bytes."""
        _mock_identity_files(monkeypatch, soul="   \n\n  ", rules="some rules")
        emitter, log_path = _build_emitter(tmp_path)

        with caplog.at_level(logging.WARNING):
            AgentRuntime(_make_config(), emitter, None)

        degraded = [e for e in _events(log_path) if e["type"] == "identity_load_degraded"]
        assert any(e["metadata"]["file"] == "SOUL.md" and e["metadata"]["state"] == "empty" for e in degraded)

    def test_soul_present_and_populated_is_not_flagged(self, tmp_path, monkeypatch, caplog):
        _mock_identity_files(monkeypatch, soul="I am TestBot", rules="some rules")
        emitter, log_path = _build_emitter(tmp_path)

        with caplog.at_level(logging.WARNING):
            runtime = AgentRuntime(_make_config(), emitter, None)

        assert runtime.soul == "I am TestBot"
        degraded = [e for e in _events(log_path) if e["type"] == "identity_load_degraded"]
        assert not any(e["metadata"]["file"] == "SOUL.md" for e in degraded)


class TestRulesMissingOrEmptyIsNoLongerSilentAndLouderThanSoul:
    def test_rules_missing_is_logged_at_error_and_emitted(self, tmp_path, monkeypatch, caplog):
        _mock_identity_files(monkeypatch, soul="some soul", rules=None)
        emitter, log_path = _build_emitter(tmp_path)

        with caplog.at_level(logging.WARNING):
            runtime = AgentRuntime(_make_config(), emitter, None)

        assert runtime.rules == ""
        error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert any("RULES.md" in r.getMessage() and "missing" in r.getMessage() for r in error_records), (
            "RULES.md missing must be logged at ERROR -- losing the agent's operating "
            "constraints silently fails OPEN, which is worse than SOUL.md's loss"
        )
        degraded = [e for e in _events(log_path) if e["type"] == "identity_load_degraded"]
        assert any(e["metadata"]["file"] == "RULES.md" and e["metadata"]["state"] == "missing" for e in degraded)

    def test_rules_empty_is_logged_at_error_and_emitted(self, tmp_path, monkeypatch, caplog):
        _mock_identity_files(monkeypatch, soul="some soul", rules="")
        emitter, log_path = _build_emitter(tmp_path)

        with caplog.at_level(logging.WARNING):
            runtime = AgentRuntime(_make_config(), emitter, None)

        assert runtime.rules == ""
        error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert any("RULES.md" in r.getMessage() and "empty" in r.getMessage() for r in error_records)
        degraded = [e for e in _events(log_path) if e["type"] == "identity_load_degraded"]
        assert any(e["metadata"]["file"] == "RULES.md" and e["metadata"]["state"] == "empty" for e in degraded)

    def test_rules_present_and_populated_is_not_flagged(self, tmp_path, monkeypatch, caplog):
        _mock_identity_files(monkeypatch, soul="some soul", rules="Rule 1: be nice")
        emitter, log_path = _build_emitter(tmp_path)

        with caplog.at_level(logging.WARNING):
            runtime = AgentRuntime(_make_config(), emitter, None)

        assert runtime.rules == "Rule 1: be nice"
        degraded = [e for e in _events(log_path) if e["type"] == "identity_load_degraded"]
        assert not any(e["metadata"]["file"] == "RULES.md" for e in degraded)


class TestUnreadableFileAlreadyRefusesLoudly:
    """Documented, not fixed: an unreadable file already crashes agentbox at
    startup via an uncaught exception. That is loud (a visible traceback,
    the container never reaches healthy) even though it is not a deliberate,
    structured refusal -- this is the "clean negative" sub-case."""

    def test_soul_unreadable_raises_during_construction(self, tmp_path, monkeypatch):
        _mock_identity_files(monkeypatch, soul="irrelevant", rules="some rules", unreadable={"soul"})
        emitter, _ = _build_emitter(tmp_path)

        with pytest.raises(PermissionError):
            AgentRuntime(_make_config(), emitter, None)

    def test_rules_unreadable_raises_during_construction(self, tmp_path, monkeypatch):
        _mock_identity_files(monkeypatch, soul="some soul", rules="irrelevant", unreadable={"rules"})
        emitter, _ = _build_emitter(tmp_path)

        with pytest.raises(PermissionError):
            AgentRuntime(_make_config(), emitter, None)


class TestBothFilesHealthyProducesNoDegradedEvents:
    def test_no_events_at_all_when_both_files_are_fine(self, tmp_path, monkeypatch, caplog):
        _mock_identity_files(monkeypatch, soul="I am TestBot", rules="Rule 1: be nice")
        emitter, log_path = _build_emitter(tmp_path)

        with caplog.at_level(logging.WARNING):
            AgentRuntime(_make_config(), emitter, None)

        assert _events(log_path) == []
        assert not any(r.levelno >= logging.WARNING for r in caplog.records)
