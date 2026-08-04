"""A completion that stopped short must not be delivered as a whole one (#260).

THE DEFECT, in two triggers that arrive dressed as success:

  1. `finish_reason == "length"` — the provider stopped generating because it
     hit a limit, so the content is a PARTIAL answer. The loop treated anything
     that was not `tool_calls` as final and delivered `status="complete"`, and
     the callback contract had nowhere to put the reason: `finish_reason`
     appeared once more in an event summary string and never left the container.

  2. A 200 whose body is not a completion. `services/ai/app/proxy.py` maps an
     unparseable upstream body to `{"error": ...}` while passing the upstream
     status through, so `.get("choices", [{}])[0]` yielded an empty message,
     `finish_reason` was DEFAULTED to "stop", and an empty string went out as a
     complete answer — indistinguishable from a model that chose to say nothing.

WHY THE FIXTURES LOOK LIKE THIS. A well-formed completion cannot tell the
versions apart: with `finish_reason == "stop"` and content present, the old code
and the new one do the same thing, byte for byte. The only fixture that measures
anything is one that ENDS WITHOUT THE MARKER that says it is whole — cut short,
or with no `finish_reason` at all. Every positive control below is such a
fixture, and each is paired with a `stop` twin that must behave identically
either way.

WHY THE MARKER IS INLINE. The consumer is a model. The loop appends assistant
turns back into `messages`, other agents read thread history, and the next turn
reasons over whatever is in the text. A flag in a sibling field is invisible to
that reader.

NOT EXERCISED: no real provider was made to truncate, no 200-with-non-JSON body
was served by LiteLLM, and no client was run against the result. `can` means the
code permits it, not that it has happened.
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from app.chat import _mark_incomplete, handle_chat
from app.events import EventEmitter


@pytest.fixture
def emitter(tmp_path):
    log_path = tmp_path / "events.jsonl"
    return EventEmitter(str(log_path)), log_path


def _events(log_path):
    if not log_path.exists():
        return []
    return [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()]


def _ai(body: dict, status_code: int = 200):
    return MagicMock(status_code=status_code, json=lambda: body, text=json.dumps(body))


def _callback_body(mock_post):
    """The body of the callback POST — the second call the loop makes."""
    return mock_post.call_args_list[1][1]["json"]


def _run(mock_post, ai_body, emitter_tuple, monkeypatch, status_code=200):
    em, log_path = emitter_tuple
    monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
    monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")
    monkeypatch.setenv("AI_SERVICE_URL", "http://ai:8000")
    mock_post.side_effect = [_ai(ai_body, status_code), MagicMock(status_code=200, text="ok")]

    handle_chat(
        {
            "thread_id": "t1", "message_id": "m1",
            "messages": [{"role": "user", "content": "Write me a long essay"}],
            "model": "gpt-4o-mini",
            "callback_url": "http://api:3000/cb",
        },
        soul="", rules="", work_id="w1", emitter=em,
    )
    return log_path


class TestCutShort:
    @patch("app.chat.requests.post")
    def test_positive_control_length_truncation_is_marked(self, mock_post, emitter, monkeypatch):
        # The fixture that ends WITHOUT the marker that says it is whole.
        _run(mock_post, {
            "choices": [{"message": {"content": "The three main causes were"}, "finish_reason": "length"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 4096},
            "model": "gpt-4o-mini",
        }, emitter, monkeypatch)

        body = _callback_body(mock_post)
        # The partial answer is still delivered — it is real content.
        assert body["content"].startswith("The three main causes were")
        # But it does not go out claiming to be whole.
        assert "incomplete" in body["content"].lower()
        assert "finish_reason=length" in body["content"]
        # And the reason is queryable, not only legible.
        assert body["error_message"] is not None
        assert "output limit" in body["error_message"]
        # Status stays complete: the turn ended, and the content is usable.
        assert body["status"] == "complete"

    @patch("app.chat.requests.post")
    def test_twin_a_clean_stop_is_delivered_untouched(self, mock_post, emitter, monkeypatch):
        # The well-formed fixture, which cannot distinguish broken from fixed —
        # it must stay byte-identical or the marker has started lying.
        _run(mock_post, {
            "choices": [{"message": {"content": "Hello from agent!"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 42, "completion_tokens": 128},
            "model": "gpt-4o-mini",
        }, emitter, monkeypatch)

        body = _callback_body(mock_post)
        assert body["content"] == "Hello from agent!"
        assert body["error_message"] is None
        assert body["status"] == "complete"

    @patch("app.chat.requests.post")
    def test_content_filter_is_marked_too(self, mock_post, emitter, monkeypatch):
        _run(mock_post, {
            "choices": [{"message": {"content": "I can help with that. First"}, "finish_reason": "content_filter"}],
            "model": "gpt-4o-mini",
        }, emitter, monkeypatch)

        body = _callback_body(mock_post)
        assert "content filter" in body["content"].lower()
        assert body["error_message"] is not None


class TestNoFinishReason:
    @patch("app.chat.requests.post")
    def test_absent_finish_reason_is_not_invented_into_stop(self, mock_post, emitter, monkeypatch):
        # The third state: the upstream did not say whether this is whole. The
        # old code wrote `choice.get("finish_reason", "stop")` and manufactured
        # the claim. Recorded, not written into the message — see the note in
        # `_run_tool_loop` for why a marker on every reply would be noise.
        log_path = _run(mock_post, {
            "choices": [{"message": {"content": "An answer with no marker"}}],
            "model": "gpt-4o-mini",
        }, emitter, monkeypatch)

        body = _callback_body(mock_post)
        assert body["content"] == "An answer with no marker"
        assert body["error_message"] is None

        # The event carries what the upstream actually said, which is nothing.
        complete = [e for e in _events(log_path) if e["type"] == "chat_inference_complete"]
        assert complete, "expected a chat_inference_complete event"
        assert "finish=None" in complete[0]["output_summary"]


class TestNoCompletionAtAll:
    @patch("app.chat.requests.post")
    def test_positive_control_200_with_an_error_body_is_an_error(self, mock_post, emitter, monkeypatch):
        # What `proxy.py` produces when the upstream body will not parse: a 200
        # carrying an error envelope. This used to become an empty "complete".
        _run(mock_post, {"error": {"message": "upstream returned text/html"}}, emitter, monkeypatch)

        body = _callback_body(mock_post)
        assert body["status"] == "error"
        assert body["content"] == ""
        assert "no completion" in body["error_message"].lower()
        assert "text/html" in body["error_message"]

    @patch("app.chat.requests.post")
    def test_200_with_an_empty_choices_list_is_an_error(self, mock_post, emitter, monkeypatch):
        _run(mock_post, {"choices": [], "model": "gpt-4o-mini"}, emitter, monkeypatch)

        body = _callback_body(mock_post)
        assert body["status"] == "error"
        assert body["status"] != "complete"

    @patch("app.chat.requests.post")
    def test_twin_a_body_WITH_choices_still_completes(self, mock_post, emitter, monkeypatch):
        _run(mock_post, {
            "choices": [{"message": {"content": "Real answer"}, "finish_reason": "stop"}],
            "model": "gpt-4o-mini",
        }, emitter, monkeypatch)

        body = _callback_body(mock_post)
        assert body["status"] == "complete"
        assert body["content"] == "Real answer"


class TestMarkerHelper:
    def test_marker_appends_rather_than_replaces(self):
        marked, note = _mark_incomplete("half an answer", "length")
        assert marked.startswith("half an answer")
        assert note is not None

    def test_stop_and_absent_are_left_alone(self):
        assert _mark_incomplete("whole", "stop") == ("whole", None)
        assert _mark_incomplete("whole", None) == ("whole", None)

    def test_an_unknown_reason_is_not_guessed_at(self):
        # A value nobody here has seen is not assumed to mean truncation.
        assert _mark_incomplete("whole", "some_new_reason") == ("whole", None)
