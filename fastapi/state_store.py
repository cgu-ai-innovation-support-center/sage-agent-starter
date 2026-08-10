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

    def prune(self, now: int | None = None) -> None:
        current = int(time.time()) if now is None else now
        with self._lock, self._database:
            self._database.execute(
                "DELETE FROM response_heads WHERE retain_until_seconds <= ?", (current,)
            )

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
