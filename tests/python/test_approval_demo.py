import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "fastapi"))

from approval_demo import (  # noqa: E402
    APPROVAL_DEMO_PROMPT,
    approval_demo_pending_action,
    approval_demo_request_frames,
    approval_demo_result_frames,
    approval_request_id,
    approval_result_response_id,
    is_approval_demo_input,
)


class ApprovalDemoTests(unittest.TestCase):
    invocation_key = f"fixture-{'x' * 40}"
    conversation_id = "11111111-1111-4111-8111-111111111111"

    def test_exact_prompt_and_no_side_effect_request(self) -> None:
        self.assertTrue(
            is_approval_demo_input(
                [{"content": APPROVAL_DEMO_PROMPT, "role": "user"}]
            )
        )
        self.assertFalse(
            is_approval_demo_input(
                [{"content": f"{APPROVAL_DEMO_PROMPT} please", "role": "user"}]
            )
        )
        approval_id = approval_request_id(
            self.invocation_key, self.conversation_id, "resp-provider-1"
        )
        self.assertRegex(approval_id, r"^mcpr_[A-Za-z0-9_-]{43}$")
        self.assertEqual(
            approval_id,
            approval_request_id(
                self.invocation_key, self.conversation_id, "resp-provider-1"
            ),
        )
        action = approval_demo_pending_action(approval_id)
        self.assertEqual(action["effect"], "none")
        frames = approval_demo_request_frames(action)
        body = b"".join(frames)
        self.assertIn(b"mcp_approval_request", body)
        import json

        first_event = json.loads(frames[0][6:])
        self.assertEqual(
            json.loads(first_event["item"]["arguments"]),
            {"action": "preview_safe_course_hint", "effect": "none"},
        )
        self.assertNotIn(b"AGENT_INVOCATION_KEY", body)

    def test_result_frames_cover_approve_and_deny(self) -> None:
        result_id = approval_result_response_id(
            self.invocation_key,
            self.conversation_id,
            "resp-pending",
            [{"approval_request_id": "mcpr_demo", "approve": True}],
        )
        self.assertRegex(result_id, r"^resp_demo_[A-Za-z0-9_-]{43}$")
        self.assertNotEqual(
            result_id,
            approval_result_response_id(
                self.invocation_key,
                self.conversation_id,
                "resp-pending",
                [{"approval_request_id": "mcpr_demo", "approve": False}],
            ),
        )
        action = approval_demo_pending_action("mcpr_demo")
        approved = b"".join(
            approval_demo_result_frames(
                [{**action, "approved": True}], result_id
            )
        )
        self.assertIn(b"response.output_item.done", approved)
        self.assertIn(b"No external action was performed", approved)
        denied = b"".join(
            approval_demo_result_frames(
                [{**action, "approved": False}], "resp_demo_denied"
            )
        )
        self.assertNotIn(b"response.output_item.done", denied)
        self.assertIn(b"denied", denied)
        self.assertIn(b"No action was performed", denied)


if __name__ == "__main__":
    unittest.main()
