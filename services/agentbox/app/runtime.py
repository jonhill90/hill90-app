"""AgentRuntime — workload receiver and identity loader.

Provides the POST /work endpoint contract for receiving work items.
Routes work by type: 'chat' → chat handler, 'shell_command' → shell execution.
Unknown types are rejected at the boundary: a work_failed event and HTTP 400
(#222 finding 2) — not a work_completed stub, which is what this used to do.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import threading
import uuid

from starlette.requests import Request
from starlette.responses import JSONResponse

from app import shell
from app.chat import handle_chat
from app.config import AgentConfig
from app.events import EventEmitter

logger = logging.getLogger(__name__)


class AgentRuntime:
    """Runtime workload receiver with bearer auth and structured events."""

    def __init__(
        self,
        config: AgentConfig,
        emitter: EventEmitter,
        work_token: str | None,
    ) -> None:
        self._config = config
        self._emitter = emitter
        self._work_token = work_token

        # Load identity files (same paths as the removed identity tool)
        self.soul: str = ""
        self.rules: str = ""
        self._load_identity()

    def _load_identity(self) -> None:
        soul_path = "/etc/agentbox/SOUL.md"
        rules_path = "/etc/agentbox/RULES.md"

        if os.path.exists(soul_path):
            with open(soul_path) as f:
                self.soul = f.read()

        if os.path.exists(rules_path):
            with open(rules_path) as f:
                self.rules = f.read()

    async def handle_work(self, request: Request) -> JSONResponse:
        """Handle POST /work — validate, emit events, return ack.

        Auth: Bearer token from WORK_TOKEN env var.
        Schema: { "type": str, "payload": dict, "correlation_id": str | None }
        """
        # 1. Auth check
        if not self._check_auth(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)

        # 2. Parse JSON body
        try:
            body = await request.json()
        except Exception:
            self._emit_work_failed("Malformed JSON body")
            return JSONResponse(
                {"error": "validation_error", "detail": "Malformed JSON body"},
                status_code=400,
            )

        # 3. Validate schema
        if not isinstance(body, dict):
            self._emit_work_failed("Request body must be a JSON object")
            return JSONResponse(
                {"error": "validation_error", "detail": "Request body must be a JSON object"},
                status_code=400,
            )

        work_type = body.get("type")
        if not work_type or not isinstance(work_type, str):
            self._emit_work_failed("Field 'type' is required and must be a non-empty string")
            return JSONResponse(
                {"error": "validation_error", "detail": "Field 'type' is required and must be a non-empty string"},
                status_code=400,
            )

        payload = body.get("payload", {})
        if not isinstance(payload, dict):
            self._emit_work_failed(
                "Field 'payload' must be an object",
                work_type=work_type,
            )
            return JSONResponse(
                {"error": "validation_error", "detail": "Field 'payload' must be an object"},
                status_code=400,
            )

        correlation_id = body.get("correlation_id")
        if correlation_id is not None and not isinstance(correlation_id, str):
            self._emit_work_failed(
                "Field 'correlation_id' must be a string or null",
                work_type=work_type,
            )
            return JSONResponse(
                {"error": "validation_error", "detail": "Field 'correlation_id' must be a string or null"},
                status_code=400,
            )

        # 4. Generate work ID
        work_id = str(uuid.uuid4())

        # 5. Build summary for events (no secrets — only type + correlation_id)
        summary = f"type={work_type}"
        if correlation_id:
            summary += f" correlation_id={correlation_id}"

        # 6. Emit work_received
        self._emitter.emit(
            type="work_received",
            tool="runtime",
            input_summary=summary,
            output_summary=None,
            duration_ms=None,
            success=None,
            correlation_id=correlation_id,
            metadata={"work_id": work_id},
        )

        # 7. Route by work type
        if work_type == "chat":
            # Run chat handler in background thread (uses blocking requests lib)
            thread = threading.Thread(
                target=self._run_chat,
                args=(payload, work_id, summary, correlation_id),
                daemon=True,
            )
            thread.start()
        elif work_type == "shell_command":
            # Validate shell enabled
            if not self._config.tools.shell.enabled:
                self._emitter.emit(
                    type="work_failed",
                    tool="runtime",
                    input_summary=summary,
                    output_summary="shell_disabled",
                    duration_ms=0,
                    success=False,
                    metadata={"work_id": work_id},
                )
                return JSONResponse(
                    {"error": "shell_disabled"},
                    status_code=400,
                )

            # Validate payload.command
            command = payload.get("command")
            if not command or not isinstance(command, str):
                self._emitter.emit(
                    type="work_failed",
                    tool="runtime",
                    input_summary=summary,
                    output_summary="validation_error: payload.command required",
                    duration_ms=0,
                    success=False,
                    metadata={"work_id": work_id},
                )
                return JSONResponse(
                    {"error": "validation_error", "detail": "payload.command is required and must be a non-empty string"},
                    status_code=400,
                )

            # Enforce timeout ceiling
            raw_timeout = payload.get("timeout", 30)
            try:
                timeout = max(int(raw_timeout), 1)
            except (TypeError, ValueError):
                timeout = 30
            timeout = min(timeout, self._config.tools.shell.max_timeout)

            # Generate command_id
            command_id = str(uuid.uuid4())

            # Run shell in background thread
            thread = threading.Thread(
                target=self._run_shell,
                args=(command, timeout, work_id, command_id, summary),
                daemon=True,
            )
            thread.start()

            # Return ack with command_id
            return JSONResponse({
                "accepted": True,
                "work_id": work_id,
                "command_id": command_id,
                "type": work_type,
            })
        else:
            # Unrecognised work type: reject at the boundary, matching every
            # other rejection in this function rather than acknowledging it
            # (#222 finding 2). Closest siblings in shape are shell_disabled
            # and the missing-command check just above — both run after
            # work_id exists, so both carry it in metadata, which is why
            # this is an inline emit rather than the _emit_work_failed
            # helper the pre-work_id validations use.
            detail = f"Unknown work type: {work_type!r}"
            self._emitter.emit(
                type="work_failed",
                tool="runtime",
                input_summary=summary,
                output_summary=detail,
                duration_ms=0,
                success=False,
                metadata={"work_id": work_id},
            )
            return JSONResponse(
                {"error": "validation_error", "detail": detail},
                status_code=400,
            )

        # 8. Return ack
        return JSONResponse({
            "accepted": True,
            "work_id": work_id,
            "type": work_type,
        })

    def _run_chat(self, payload: dict, work_id: str, summary: str, correlation_id: str | None = None) -> None:
        """Execute chat handler in background thread."""
        try:
            # handle_chat now returns whether it actually delivered a real
            # answer (app#436) — this mirrors _run_shell's own
            # `success=result.get("success", False)` a few lines below,
            # rather than assuming success whenever no exception was raised.
            # Before this, a chat work item that handle_chat's OWN validation
            # rejected (e.g. missing callback_url, which emits its own
            # work_failed and returns normally) still produced a SECOND,
            # contradicting work_completed/success=true event for the same
            # work item.
            success = handle_chat(
                payload,
                soul=self.soul,
                rules=self.rules,
                work_id=work_id,
                emitter=self._emitter,
                tools_config=self._config.tools,
                tool_loop_config=self._config.tool_loop,
                correlation_id=correlation_id,
            )
            self._emitter.emit(
                type="work_completed",
                tool="runtime",
                input_summary=summary,
                output_summary=f"work_id={work_id}",
                duration_ms=None,
                success=success,
                correlation_id=correlation_id,
                metadata={"work_id": work_id},
            )
        except Exception as exc:
            logger.error("Chat work failed: %s", exc, exc_info=True)
            self._emitter.emit(
                type="work_failed",
                tool="runtime",
                input_summary=summary,
                output_summary=f"error={str(exc)[:200]}",
                duration_ms=None,
                success=False,
                correlation_id=correlation_id,
                metadata={"work_id": work_id},
            )

    def _run_shell(
        self,
        command: str,
        timeout: int,
        work_id: str,
        command_id: str,
        summary: str,
    ) -> None:
        """Execute shell command in background thread."""
        try:
            result_json = asyncio.run(
                shell.execute_command(
                    command,
                    timeout=timeout,
                    command_id=command_id,
                    work_id=work_id,
                )
            )
            result = json.loads(result_json)
            self._emitter.emit(
                type="work_completed",
                tool="runtime",
                input_summary=summary,
                output_summary=f"work_id={work_id} command_id={command_id}",
                duration_ms=None,
                success=result.get("success", False),
                metadata={"work_id": work_id, "command_id": command_id},
            )
        except Exception as exc:
            logger.error("Shell work failed: %s", exc, exc_info=True)
            self._emitter.emit(
                type="work_failed",
                tool="runtime",
                input_summary=summary,
                output_summary=f"error={str(exc)[:200]}",
                duration_ms=None,
                success=False,
                metadata={"work_id": work_id, "command_id": command_id},
            )

    def _emit_work_failed(
        self,
        detail: str,
        *,
        work_type: str | None = None,
    ) -> None:
        """Emit a work_failed event for validation/schema failures."""
        summary = f"type={work_type}" if work_type else "type=unknown"
        self._emitter.emit(
            type="work_failed",
            tool="runtime",
            input_summary=summary,
            output_summary=detail,
            duration_ms=0,
            success=False,
        )

    def _check_auth(self, request: Request) -> bool:
        """Validate Bearer token against WORK_TOKEN.

        Constant-time comparison (hmac.compare_digest), matching the api's
        own chat-callback token check (services/api/src/routes/chat.ts,
        crypto.timingSafeEqual) — the same class of secret, a static Bearer
        token gating an internal endpoint on the trusted network. A plain
        `==` short-circuits on the first mismatching byte, a real timing
        side-channel on WORK_TOKEN.
        """
        if not self._work_token:
            return False

        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            return False

        token = auth_header[7:]  # len("Bearer ") == 7
        return hmac.compare_digest(token, self._work_token)
