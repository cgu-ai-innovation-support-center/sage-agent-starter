"""Restart-safe local response-head storage for the SAGE starter."""

from __future__ import annotations

import codecs
import json
import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

ORDINARY_RETENTION_SECONDS = 30 * 24 * 60 * 60
PENDING_RETENTION_SECONDS = 7 * 24 * 60 * 60
GENERIC_FAILURE_FRAME = b'data: {"type":"response.failed"}\n\n'


def _bounded_id(value: object, name: str) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or not 1 <= len(value) <= 512
    ):
        raise TypeError(f"{name} must be a trimmed string of 1 to 512 characters")
    return value


class SqliteResponseStateStore:
    """Conversation-scoped state for local or shared-single-host deployment."""

    def __init__(self, path: str | None = None) -> None:
        candidate = (path or os.environ.get("AGENT_STATE_DB") or "./data/agent-state.sqlite").strip()
        if candidate == ":memory:" or "mode=memory" in candidate:
            raise ValueError("in-memory Agent state is not permitted")
        self.path = Path(candidate).resolve()
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._database = sqlite3.connect(self.path, check_same_thread=False, timeout=5)
        os.chmod(self.path, 0o600)
        with self._database:
            self._database.execute("PRAGMA journal_mode = WAL")
            self._database.execute("PRAGMA synchronous = FULL")
            self._database.execute("PRAGMA busy_timeout = 5000")
            self._database.execute(
                """
                CREATE TABLE IF NOT EXISTS response_heads (
                    conversation_id TEXT NOT NULL,
                    response_id TEXT NOT NULL,
                    provider_response_id TEXT NOT NULL,
                    created_at_seconds INTEGER NOT NULL,
                    retain_until_seconds INTEGER NOT NULL,
                    PRIMARY KEY (conversation_id, response_id)
                ) STRICT
                """
            )
            self._database.execute(
                "CREATE INDEX IF NOT EXISTS response_heads_expiry ON response_heads (retain_until_seconds)"
            )
            self._database.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_actions (
                    conversation_id TEXT NOT NULL,
                    response_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
                    approval_request_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    server_label TEXT NOT NULL,
                    arguments_json TEXT NOT NULL,
                    created_at_seconds INTEGER NOT NULL,
                    retain_until_seconds INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'consumed')),
                    approved INTEGER CHECK (approved IN (0, 1)),
                    consumed_at_seconds INTEGER,
                    PRIMARY KEY (conversation_id, response_id, approval_request_id),
                    UNIQUE (conversation_id, response_id, ordinal)
                ) STRICT
                """
            )
            self._database.execute(
                "CREATE INDEX IF NOT EXISTS pending_actions_expiry ON pending_actions (retain_until_seconds)"
            )

    def resolve(
        self, conversation_id: str, response_id: str, now: int | None = None
    ) -> str | None:
        current = int(time.time()) if now is None else now
        conversation = _bounded_id(conversation_id, "conversation_id")
        response = _bounded_id(response_id, "response_id")
        with self._lock, self._database:
            row = self._database.execute(
                """
                SELECT provider_response_id, retain_until_seconds
                FROM response_heads
                WHERE conversation_id = ? AND response_id = ?
                """,
                (conversation, response),
            ).fetchone()
            if row is None:
                return None
            if row[1] <= current:
                self._database.execute(
                    "DELETE FROM response_heads WHERE conversation_id = ? AND response_id = ?",
                    (conversation, response),
                )
                return None
            return str(row[0])

    def record(
        self,
        *,
        conversation_id: str,
        provider_response_id: str,
        response_id: str | None = None,
        now: int | None = None,
        retention_seconds: int = ORDINARY_RETENTION_SECONDS,
    ) -> None:
        current = int(time.time()) if now is None else now
        if not isinstance(current, int) or retention_seconds < ORDINARY_RETENTION_SECONDS:
            raise TypeError("response retention must be at least 30 days")
        conversation = _bounded_id(conversation_id, "conversation_id")
        provider = _bounded_id(provider_response_id, "provider_response_id")
        outer = _bounded_id(response_id or provider, "response_id")
        with self._lock, self._database:
            self._database.execute(
                "DELETE FROM response_heads WHERE retain_until_seconds <= ?",
                (current,),
            )
            self._database.execute(
                """
                INSERT INTO response_heads (
                    conversation_id,
                    response_id,
                    provider_response_id,
                    created_at_seconds,
                    retain_until_seconds
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (conversation_id, response_id) DO UPDATE SET
                    provider_response_id = excluded.provider_response_id,
                    retain_until_seconds = MAX(
                        response_heads.retain_until_seconds,
                        excluded.retain_until_seconds
                    )
                """,
                (conversation, outer, provider, current, current + retention_seconds),
            )

    def record_pending(
        self,
        *,
        actions: list[dict[str, object]],
        conversation_id: str,
        provider_response_id: str,
        response_id: str | None = None,
        now: int | None = None,
        retention_seconds: int = PENDING_RETENTION_SECONDS,
    ) -> None:
        current = int(time.time()) if now is None else now
        if (
            not isinstance(current, int)
            or retention_seconds < PENDING_RETENTION_SECONDS
            or not 1 <= len(actions) <= 256
        ):
            raise TypeError("pending approval state is invalid")
        conversation = _bounded_id(conversation_id, "conversation_id")
        provider = _bounded_id(provider_response_id, "provider_response_id")
        outer = _bounded_id(response_id or provider, "response_id")
        normalized: list[tuple[str, str, str, str]] = []
        for action in actions:
            approval_id = _bounded_id(
                action.get("approval_request_id"), "approval_request_id"
            )
            tool_name = _bounded_id(action.get("tool_name"), "tool_name")
            server_label = _bounded_id(action.get("server_label"), "server_label")
            arguments_json = action.get("arguments_json")
            if (
                len(approval_id) > 200
                or len(tool_name) > 200
                or len(server_label) > 200
                or not isinstance(arguments_json, str)
                or len(arguments_json.encode()) > 16_384
            ):
                raise TypeError("pending action is invalid")
            parsed = json.loads(arguments_json)
            if not isinstance(parsed, dict):
                raise TypeError("arguments_json must contain an object")
            normalized.append(
                (
                    approval_id,
                    tool_name,
                    server_label,
                    json.dumps(parsed, separators=(",", ":")),
                )
            )
        if len({item[0] for item in normalized}) != len(normalized):
            raise TypeError("pending approval IDs must be unique")
        with self._lock, self._database:
            self._database.execute(
                """
                INSERT INTO response_heads (
                    conversation_id, response_id, provider_response_id,
                    created_at_seconds, retain_until_seconds
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (conversation_id, response_id) DO UPDATE SET
                    provider_response_id = excluded.provider_response_id,
                    retain_until_seconds = MAX(
                        response_heads.retain_until_seconds,
                        excluded.retain_until_seconds
                    )
                """,
                (
                    conversation,
                    outer,
                    provider,
                    current,
                    current + ORDINARY_RETENTION_SECONDS,
                ),
            )
            self._database.executemany(
                """
                INSERT INTO pending_actions (
                    conversation_id, response_id, ordinal, approval_request_id,
                    tool_name, server_label, arguments_json, created_at_seconds,
                    retain_until_seconds, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                """,
                [
                    (
                        conversation,
                        outer,
                        ordinal,
                        approval_id,
                        tool_name,
                        server_label,
                        arguments_json,
                        current,
                        current + retention_seconds,
                    )
                    for ordinal, (
                        approval_id,
                        tool_name,
                        server_label,
                        arguments_json,
                    ) in enumerate(normalized)
                ],
            )

    def has_pending(
        self, conversation_id: str, response_id: str, now: int | None = None
    ) -> bool:
        current = int(time.time()) if now is None else now
        with self._lock:
            row = self._database.execute(
                """
                SELECT 1
                FROM pending_actions
                WHERE conversation_id = ?
                  AND response_id = ?
                  AND status = 'pending'
                  AND retain_until_seconds > ?
                LIMIT 1
                """,
                (
                    _bounded_id(conversation_id, "conversation_id"),
                    _bounded_id(response_id, "response_id"),
                    current,
                ),
            ).fetchone()
            return row == (1,)

    def consume_pending(
        self,
        *,
        conversation_id: str,
        response_id: str,
        responses: list[dict[str, object]],
        result_response_id: str,
        now: int | None = None,
    ) -> dict[str, object] | None:
        current = int(time.time()) if now is None else now
        if not isinstance(current, int) or not responses:
            raise TypeError("approval responses are invalid")
        conversation = _bounded_id(conversation_id, "conversation_id")
        previous = _bounded_id(response_id, "response_id")
        result = _bounded_id(result_response_id, "result_response_id")
        normalized: list[tuple[str, bool]] = []
        for response in responses:
            approval_id = _bounded_id(
                response.get("approval_request_id"), "approval_request_id"
            )
            approved = response.get("approve")
            if len(approval_id) > 200 or not isinstance(approved, bool):
                raise TypeError("approval response is invalid")
            normalized.append((approval_id, approved))
        with self._lock, self._database:
            head = self._database.execute(
                """
                SELECT provider_response_id
                FROM response_heads
                WHERE conversation_id = ?
                  AND response_id = ?
                  AND retain_until_seconds > ?
                """,
                (conversation, previous, current),
            ).fetchone()
            rows = self._database.execute(
                """
                SELECT approval_request_id, tool_name, server_label, arguments_json
                FROM pending_actions
                WHERE conversation_id = ?
                  AND response_id = ?
                  AND status = 'pending'
                  AND retain_until_seconds > ?
                ORDER BY ordinal
                """,
                (conversation, previous, current),
            ).fetchall()
            if (
                head is None
                or len(rows) != len(normalized)
                or any(row[0] != normalized[index][0] for index, row in enumerate(rows))
            ):
                return None
            for approval_id, approved in normalized:
                updated = self._database.execute(
                    """
                    UPDATE pending_actions
                    SET status = 'consumed', approved = ?, consumed_at_seconds = ?
                    WHERE conversation_id = ?
                      AND response_id = ?
                      AND approval_request_id = ?
                      AND status = 'pending'
                    """,
                    (
                        int(approved),
                        current,
                        conversation,
                        previous,
                        approval_id,
                    ),
                )
                if updated.rowcount != 1:
                    raise RuntimeError("pending approval changed concurrently")
            self._database.execute(
                """
                INSERT INTO response_heads (
                    conversation_id, response_id, provider_response_id,
                    created_at_seconds, retain_until_seconds
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (conversation_id, response_id) DO UPDATE SET
                    provider_response_id = excluded.provider_response_id,
                    retain_until_seconds = MAX(
                        response_heads.retain_until_seconds,
                        excluded.retain_until_seconds
                    )
                """,
                (
                    conversation,
                    result,
                    head[0],
                    current,
                    current + ORDINARY_RETENTION_SECONDS,
                ),
            )
            return {
                "actions": [
                    {
                        "approval_request_id": row[0],
                        "approved": normalized[index][1],
                        "arguments_json": row[3],
                        "server_label": row[2],
                        "tool_name": row[1],
                    }
                    for index, row in enumerate(rows)
                ],
                "provider_response_id": str(head[0]),
            }

    def prune(self, now: int | None = None) -> None:
        current = int(time.time()) if now is None else now
        with self._lock, self._database:
            self._database.execute(
                "DELETE FROM response_heads WHERE retain_until_seconds <= ?", (current,)
            )
            self._database.execute(
                "DELETE FROM pending_actions WHERE retain_until_seconds <= ?",
                (current,),
            )

    def backup(self, destination: str) -> None:
        target_path = Path(destination).resolve()
        target_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = sqlite3.connect(target_path)
        try:
            with self._lock:
                self._database.backup(target)
        finally:
            target.close()
        os.chmod(target_path, 0o600)

    def ready(self) -> bool:
        with self._lock:
            return self._database.execute("SELECT 1").fetchone() == (1,)

    def close(self) -> None:
        with self._lock:
            self._database.close()


@dataclass(frozen=True)
class StreamCompletion:
    completed_response_id: str | None
    output_frames: tuple[bytes, ...]
    stream_outcome: str
    terminal_frames: tuple[bytes, ...]


class DurableResponseStreamGate:
    """Withhold response.completed until its continuation state is durable."""

    def __init__(self, max_frame_characters: int = 256_000) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._buffer = ""
        self._created_id: str | None = None
        self._terminal_frame: bytes | None = None
        self._terminal_suffix: list[bytes] = []
        self._terminal_state = "open"
        self._completed_response_id: str | None = None
        self._maximum = max_frame_characters

    def push(self, chunk: bytes) -> tuple[bytes, ...]:
        self._buffer += self._decoder.decode(chunk)
        return tuple(self._consume())

    def finish(self) -> StreamCompletion:
        self._buffer += self._decoder.decode(b"", final=True)
        output_frames = self._consume(final=True)
        terminal_frames = (
            (self._terminal_frame, *self._terminal_suffix)
            if self._terminal_frame is not None
            else ()
        )
        return StreamCompletion(
            completed_response_id=self._completed_response_id,
            output_frames=tuple(output_frames),
            stream_outcome=(
                "completed"
                if self._terminal_state == "completed"
                else "failed"
                if self._terminal_state == "failed"
                else "incomplete"
            ),
            terminal_frames=tuple(terminal_frames),
        )

    def _consume(self, final: bool = False) -> list[bytes]:
        output: list[bytes] = []
        self._buffer = self._buffer.replace("\r\n", "\n")
        while "\n\n" in self._buffer:
            frame, self._buffer = self._buffer.split("\n\n", 1)
            output.extend(self._accept(frame))
        if len(self._buffer) > self._maximum:
            raise ValueError("upstream SSE frame is too large")
        if final and self._buffer.strip():
            output.extend(self._accept(self._buffer))
        if final:
            self._buffer = ""
        return output

    def _accept(self, frame: str) -> list[bytes]:
        if len(frame) > self._maximum:
            raise ValueError("upstream SSE frame is too large")
        serialized = f"{frame}\n\n".encode()
        event_names = [
            line[6:].strip()
            for line in frame.splitlines()
            if line.startswith("event:")
        ]
        if len(event_names) > 1 or any(not name for name in event_names):
            raise ValueError("invalid SSE event field")
        event_name = event_names[0] if event_names else None
        failure_types = {"error", "response.failed", "response.incomplete"}
        if event_name in failure_types:
            if self._terminal_state != "open":
                raise ValueError(
                    f"substantive SSE event followed response.{self._terminal_state}"
                )
            self._terminal_state = "failed"
            return [GENERIC_FAILURE_FRAME]
        data = "\n".join(
            line[5:].lstrip()
            for line in frame.splitlines()
            if line.startswith("data:")
        )
        if data.strip() == "[DONE]":
            if event_name is not None:
                raise ValueError("SSE event field is not allowed with [DONE]")
            if self._terminal_state == "open":
                self._terminal_state = "failed"
            if self._terminal_state == "completed":
                self._terminal_suffix.append(serialized)
                return []
            return [serialized]
        if not data:
            if event_name is not None:
                raise ValueError("SSE event field requires JSON data")
            if self._terminal_state == "completed":
                self._terminal_suffix.append(serialized)
                return []
            return [serialized]
        if self._terminal_state != "open":
            raise ValueError(
                f"substantive SSE event followed response.{self._terminal_state}"
            )

        def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
            result: dict[str, object] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate JSON object key")
                result[key] = value
            return result

        try:
            event = json.loads(data, object_pairs_hook=reject_duplicate_keys)
        except (json.JSONDecodeError, ValueError):
            self._terminal_state = "failed"
            raise ValueError("SSE data must be valid JSON")
        event_type = event.get("type") if isinstance(event, dict) else None
        if not isinstance(event_type, str) or not event_type:
            raise ValueError("SSE JSON event requires a non-empty type")
        if event_type in failure_types:
            self._terminal_state = "failed"
            return [GENERIC_FAILURE_FRAME]
        if event_name is not None and event_name != event_type:
            raise ValueError("SSE event field does not match data type")
        response = event.get("response") if isinstance(event, dict) else None
        response_id = response.get("id") if isinstance(response, dict) else None
        valid_id = (
            response_id
            if isinstance(response_id, str)
            and response_id == response_id.strip()
            and 1 <= len(response_id) <= 512
            else None
        )
        if event_type == "response.created":
            self._created_id = valid_id
            if self._created_id is None:
                raise ValueError("invalid response.created ID")
        elif event_type == "response.completed":
            if valid_id is None or (
                self._created_id is not None and self._created_id != valid_id
            ):
                raise ValueError("invalid response.completed ID")
            self._completed_response_id = valid_id
            self._terminal_frame = serialized
            self._terminal_state = "completed"
            return []
        return [serialized]


def commit_then_release_terminal(
    *,
    completion: StreamCompletion,
    conversation_id: str,
    state: SqliteResponseStateStore,
) -> tuple[bytes, ...]:
    if completion.completed_response_id is not None:
        state.record(
            conversation_id=conversation_id,
            provider_response_id=completion.completed_response_id,
        )
    return completion.terminal_frames
