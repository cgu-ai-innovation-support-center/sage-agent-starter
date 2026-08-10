import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "fastapi"))

from agent_profile import load_agent_profile  # noqa: E402
from provider_request import build_provider_request  # noqa: E402


class AgentProfileTests(unittest.TestCase):
    def test_loads_bounded_minimal_tutor_profile(self) -> None:
        profile = load_agent_profile()
        self.assertEqual(profile["id"], "minimal-course-tutor")
        normalized = " ".join(profile["instructions"].split())
        self.assertIn("no files, retrieval, tools, or external data", normalized)

    def test_rejects_extra_keys_and_instruction_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "agent"
            shutil.copytree(ROOT / "agent", target)
            profile_path = target / "profile.json"
            profile = json.loads(profile_path.read_text())
            profile_path.write_text(json.dumps({**profile, "extra": True}))
            with self.assertRaisesRegex(ValueError, "contain exactly"):
                load_agent_profile(target)
            profile_path.write_text(json.dumps(profile))
            (target / "instructions.md").unlink()
            (target / "instructions.md").symlink_to(ROOT / "agent" / "instructions.md")
            with self.assertRaisesRegex(ValueError, "non-symlink"):
                load_agent_profile(target)

    def test_shared_golden_request_preserves_input(self) -> None:
        golden = json.loads((ROOT / "tests/golden/provider-request.json").read_text())
        input_items = golden["arguments"]["input"]
        actual = build_provider_request(
            input_items=input_items,
            instructions=golden["arguments"]["instructions"],
            model=golden["arguments"]["model"],
            previous_response_id=golden["arguments"]["previous_response_id"],
        )
        self.assertEqual(actual, golden["expected"])
        self.assertIs(actual["input"], input_items)


if __name__ == "__main__":
    unittest.main()
