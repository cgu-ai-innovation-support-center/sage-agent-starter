import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "fastapi"))

from state_store import (  # noqa: E402
    DurableResponseStreamGate,
    ORDINARY_RETENTION_SECONDS,
    SqliteResponseStateStore,
    commit_then_release_terminal,
)


class StateStoreTests(unittest.TestCase):
    conversation = "11111111-1111-4111-8111-111111111111"

    def test_restart_and_conversation_scope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "state.sqlite")
            first = SqliteResponseStateStore(path)
            first.record(
                conversation_id=self.conversation,
                provider_response_id="resp-provider-1",
            )
            first.close()
            restarted = SqliteResponseStateStore(path)
            self.assertEqual(
                restarted.resolve(self.conversation, "resp-provider-1"),
                "resp-provider-1",
            )
            self.assertIsNone(
                restarted.resolve(
                    "22222222-2222-4222-8222-222222222222", "resp-provider-1"
                )
            )
            restarted.close()

    def test_memory_rejected_and_expiry_is_explicit(self) -> None:
        with self.assertRaisesRegex(ValueError, "in-memory"):
            SqliteResponseStateStore(":memory:")
        with tempfile.TemporaryDirectory() as directory:
            store = SqliteResponseStateStore(str(Path(directory) / "state.sqlite"))
            now = 1_800_000_000
            store.record(
                conversation_id=self.conversation,
                provider_response_id="resp-expiring",
                now=now,
                retention_seconds=ORDINARY_RETENTION_SECONDS,
            )
            self.assertEqual(
                store.resolve(self.conversation, "resp-expiring", now),
                "resp-expiring",
            )
            self.assertIsNone(
                store.resolve(
                    self.conversation,
                    "resp-expiring",
                    now + ORDINARY_RETENTION_SECONDS,
                )
            )
            store.close()

    def test_gate_commits_before_releasing_completion(self) -> None:
        gate = DurableResponseStreamGate()
        gate.push(
            b'data: {"type":"response.created","response":{"id":"resp-1"}}\n\n'
        )
        output = gate.push(
            b'data: {"type":"response.completed","response":{"id":"resp-1"}}\n\n'
        )
        self.assertEqual(output, ())
        completion = gate.finish()
        self.assertEqual(completion.completed_response_id, "resp-1")
        self.assertEqual(completion.stream_outcome, "completed")

        order: list[str] = []

        class RecordingState:
            def record(self, **_: object) -> None:
                order.append("record")

        terminal = commit_then_release_terminal(
            completion=completion,
            conversation_id=self.conversation,
            state=RecordingState(),  # type: ignore[arg-type]
        )
        order.extend("terminal" for _ in terminal)
        self.assertEqual(order, ["record", "terminal"])

        class FailingState:
            def record(self, **_: object) -> None:
                raise RuntimeError("disk unavailable")

        with self.assertRaisesRegex(RuntimeError, "disk unavailable"):
            commit_then_release_terminal(
                completion=completion,
                conversation_id=self.conversation,
                state=FailingState(),  # type: ignore[arg-type]
            )

        failed = DurableResponseStreamGate()
        failed.push(
            b'data: {"type":"response.created","response":{"id":"resp-2"}}\n\n'
        )
        failed_output = failed.push(
            b'data: {"type":"response.failed","error":{"message":"secret at '
            b'https://internal.example.invalid"}}\n\n'
        )
        self.assertTrue(any(b"response.failed" in frame for frame in failed_output))
        self.assertFalse(any(b"secret" in frame for frame in failed_output))
        self.assertFalse(any(b"internal.example" in frame for frame in failed_output))
        with self.assertRaisesRegex(ValueError, "followed response.failed"):
            failed.push(
                b'data: {"type":"response.completed","response":{"id":"resp-2"}}\n\n'
            )
        self.assertIsNone(failed.finish().completed_response_id)
        self.assertEqual(failed.finish().stream_outcome, "failed")

        class MustNotRecord:
            def record(self, **_: object) -> None:
                raise AssertionError("must not record")

        self.assertEqual(
            commit_then_release_terminal(
                completion=failed.finish(),
                conversation_id=self.conversation,
                state=MustNotRecord(),  # type: ignore[arg-type]
            ),
            (),
        )

        header_failure = DurableResponseStreamGate()
        sanitized_header_failure = header_failure.push(
            b'event: response.failed\ndata: {"message":"secret at '
            b'https://internal.example.invalid"}\n\n'
        )
        self.assertFalse(any(b"secret" in frame for frame in sanitized_header_failure))
        self.assertTrue(
            any(b"response.failed" in frame for frame in sanitized_header_failure)
        )
        empty_header_failure = DurableResponseStreamGate()
        self.assertEqual(
            empty_header_failure.push(
                b"event: response.failed\ndata: [DONE]\n\n"
            ),
            (b'data: {"type":"response.failed"}\n\n',),
        )
        with self.assertRaisesRegex(ValueError, "followed response.failed"):
            empty_header_failure.push(
                b'data: {"type":"response.completed",'
                b'"response":{"id":"resp-late"}}\n\n'
            )
        with self.assertRaisesRegex(ValueError, "does not match"):
            DurableResponseStreamGate().push(
                b'event: response.completed\ndata: {"type":"response.output_text.delta",'
                b'"delta":"x"}\n\n'
            )
        with self.assertRaisesRegex(ValueError, r"not allowed with \[DONE\]"):
            DurableResponseStreamGate().push(
                b"event: response.completed\ndata: [DONE] \n\n"
            )
        with self.assertRaisesRegex(ValueError, "non-empty type"):
            DurableResponseStreamGate().push(
                b'data: {"error":{"message":"secret at '
                b'https://internal.example.invalid"}}\n\n'
            )

        duplicate_type = DurableResponseStreamGate()
        with self.assertRaisesRegex(ValueError, "valid JSON"):
            duplicate_type.push(
                b'data: {"type":"response.failed",'
                b'"type":"response.output_text.delta",'
                b'"delta":"secret at https://internal.example.invalid"}\n\n'
            )
        with self.assertRaisesRegex(ValueError, "followed response.failed"):
            duplicate_type.push(
                b'data: {"type":"response.completed",'
                b'"response":{"id":"resp-late"}}\n\n'
            )

        early_done = DurableResponseStreamGate()
        early_done.push(b"data: [DONE]\n\n")
        with self.assertRaisesRegex(ValueError, "followed response.failed"):
            early_done.push(
                b'data: {"type":"response.completed","response":{"id":"resp-late"}}\n\n'
            )
        self.assertIsNone(early_done.finish().completed_response_id)
        self.assertEqual(early_done.finish().stream_outcome, "failed")

        no_terminal = DurableResponseStreamGate()
        no_terminal.push(
            b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
        )
        self.assertEqual(no_terminal.finish().stream_outcome, "incomplete")

    def test_tracker_preserves_split_utf8_frames(self) -> None:
        tracker = DurableResponseStreamGate()
        stream = (
            'data: {"type":"response.created","response":{"id":"resp-utf8"},'
            '"metadata":"教師"}\n\n'
            'data: {"type":"response.completed","response":{"id":"resp-utf8"}}\n\n'
        ).encode()
        split = stream.index("教".encode()) + 1
        tracker.push(stream[:split])
        tracker.push(stream[split:])
        self.assertEqual(tracker.finish().completed_response_id, "resp-utf8")


if __name__ == "__main__":
    unittest.main()
