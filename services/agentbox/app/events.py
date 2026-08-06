"""Structured event emitter for agent runtime observability.

Writes JSONL events to a log file for each tool invocation.
Events contain metadata-only summaries — no raw stdout, file contents, or secrets.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class EventEmitter:
    """Append-only JSONL event writer with thread-safe file access."""

    def __init__(self, log_path: str) -> None:
        self._log_path = log_path
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        # Touch file so `tail -f` can open it immediately on fresh agents
        if not os.path.exists(log_path):
            open(log_path, "a").close()

    def emit(
        self,
        *,
        type: str,
        tool: str,
        input_summary: str,
        output_summary: str | None,
        duration_ms: int | None,
        success: bool | None,
        correlation_id: str | None = None,
        metadata: dict | None = None,
    ) -> None:
        """Write a single event as a JSON line to the log file.

        Args:
            type: Event type (e.g. command_start, file_read, health_check).
            tool: Tool category (shell, filesystem, identity, health).
            input_summary: Truncated human-readable input (max 200 chars).
            output_summary: Metadata-only result summary, or None for start events.
            duration_ms: Execution time in milliseconds, or None for start events.
            success: Whether the operation succeeded, or None for start events.
            correlation_id: Work-item correlation ID (message UUID) for SSE filtering.
            metadata: Optional tool-specific extra data.
        """
        event = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "type": type,
            "tool": tool,
            "input_summary": self._truncate(input_summary, 200),
            "output_summary": output_summary,
            "duration_ms": duration_ms,
            "success": success,
        }
        if correlation_id:
            event["correlation_id"] = correlation_id
        if metadata:
            event["metadata"] = metadata

        line = json.dumps(event, separators=(",", ":")) + "\n"

        try:
            with self._lock:
                with open(self._log_path, "a") as f:
                    f.write(line)
                    f.flush()
        except Exception:
            # This is the sole notification channel for runtime.py's
            # fire-and-forget background-thread pattern (the Starlette
            # analogue of FastAPI BackgroundTasks): the HTTP response
            # already went out before the real work ran, and the caller's
            # only way to learn the outcome is this file. If the write
            # itself fails — disk full, permission, a removed path — and
            # this re-raised, it would escape the caller's own except
            # block (e.g. _run_chat/_run_shell's failure-report emit()
            # call), crashing the background thread and compounding the
            # original failure into TOTAL silence: neither work_completed
            # nor work_failed ever recorded anywhere.
            #
            # Fallback is the container's stderr, not another file write —
            # a second disk/permission failure can't repeat this one.
            # Verified reaching somewhere a human or query can actually
            # see it, not assumed: server.py's logging.basicConfig() has
            # no handlers= kwarg, so Python attaches its default
            # StreamHandler to stderr; services/api/src/services/docker.ts
            # creates agentbox containers against the host's real
            # /var/run/docker.sock with no LogConfig override, so the
            # Docker daemon's default log driver captures that stream;
            # Hill90's docker-compose.observability.yml mounts that same
            # host docker.sock (not a filtered proxy) into promtail, whose
            # docker_sd_configs scrapes every container on that daemon
            # with no include/exclude filter and ships it to Loki.
            #
            # EVENT_WRITE_FAILED is a stable, queryable marker — not a
            # bare error — so an operator can tell "work failed and we
            # told you" (the event is in events.jsonl) apart from "the
            # telling itself failed" (absent from events.jsonl, present in
            # Loki tagged this way, carrying the same work_id).
            logger.error(
                "EVENT_WRITE_FAILED: could not append to %s — event lost "
                "from the file, only recorded here: %s",
                self._log_path,
                line.rstrip("\n"),
                exc_info=True,
            )

    @staticmethod
    def _truncate(text: str | None, max_len: int) -> str | None:
        if text is None:
            return None
        if len(text) <= max_len:
            return text
        return text[:max_len]
