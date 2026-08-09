import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "fastapi"))

from contract import (  # noqa: E402
    ContractError,
    is_previous_response_error,
    validate_external_artifact_url,
    validate_platform_contract,
    validate_platform_origin,
)


class ContractTests(unittest.TestCase):
    platform_origin = "https://sage.example.edu"
    headers = {
        "x-sage-conversation-id": "11111111-1111-4111-8111-111111111111",
        "x-sage-responses-profile": "stateful-v1",
    }
    model_access = {
        "base_url": "https://sage.example.edu/api/agents/model-proxy/v1",
        "expires_at": "2099-01-01T00:00:00.000Z",
        "mode": "platform_proxy_v1",
        "token": "mp1." + "a" * 43,
    }
    artifact_access = {
        "accepted_media_types": ["image/png", "image/jpeg", "image/webp"],
        "expires_at": "2099-01-01T00:00:00.000Z",
        "max_file_bytes": 10_485_760,
        "max_files": 4,
        "max_total_bytes": 20_971_520,
        "token": "af1." + "b" * 43,
        "upload_url": "https://sage.example.edu/api/agents/artifacts",
    }

    def request(self, items: list[object], **overrides: object) -> dict[str, object]:
        return {
            "artifact_access": self.artifact_access,
            "input": items,
            "model": "agent",
            "model_access": self.model_access,
            "stream": True,
            **overrides,
        }

    def test_newest_input_chain_and_approval(self) -> None:
        parsed = validate_platform_contract(
            self.headers,
            self.request([{"content": "first", "role": "user"}]),
            self.platform_origin,
        )
        self.assertEqual(parsed[4], self.headers["x-sage-conversation-id"])
        approvals = [
            {
                "approval_request_id": f"approval-{index}",
                "approve": index % 2 == 0,
                "type": "mcp_approval_response",
            }
            for index in range(12)
        ]
        parsed = validate_platform_contract(
            self.headers,
            self.request(approvals, previous_response_id="resp-approval"),
            self.platform_origin,
        )
        self.assertEqual(len(parsed[0]), 12)
        self.assertEqual(parsed[1], "resp-approval")

    def test_rejects_full_history_and_bad_lease(self) -> None:
        with self.assertRaisesRegex(ContractError, "one new user input"):
            validate_platform_contract(
                self.headers,
                self.request(
                    [
                        {"content": "first", "role": "user"},
                        {"content": "answer", "role": "assistant"},
                    ]
                ),
                self.platform_origin,
            )
        with self.assertRaisesRegex(ContractError, "artifact upload URL"):
            validate_platform_contract(
                self.headers,
                self.request(
                    [{"content": "first", "role": "user"}],
                    artifact_access={
                        **self.artifact_access,
                        "upload_url": "http://sage.example.edu/api/agents/artifacts",
                    },
                ),
                self.platform_origin,
            )
        with self.assertRaisesRegex(ContractError, "model proxy expiry"):
            validate_platform_contract(
                self.headers,
                self.request(
                    [{"content": "first", "role": "user"}],
                    model_access={
                        **self.model_access,
                        "expires_at": "2099-01-01T00:00:00",
                    },
                ),
                self.platform_origin,
            )
        with self.assertRaisesRegex(ContractError, "model proxy URL"):
            validate_platform_contract(
                self.headers,
                self.request(
                    [{"content": "first", "role": "user"}],
                    model_access={
                        **self.model_access,
                        "base_url": "https://attacker.example/api/agents/model-proxy/v1",
                    },
                ),
                self.platform_origin,
            )
        with self.assertRaisesRegex(ContractError, "model proxy URL"):
            validate_platform_contract(
                self.headers,
                self.request(
                    [{"content": "first", "role": "user"}],
                    artifact_access={
                        **self.artifact_access,
                        "upload_url": "https://fass.de/api/agents/artifacts",
                    },
                    model_access={
                        **self.model_access,
                        "base_url": "https://faß.de/api/agents/model-proxy/v1",
                    },
                ),
                "https://fass.de",
            )

    def test_exact_continuation_loss_only(self) -> None:
        self.assertTrue(
            is_previous_response_error(
                404,
                json.dumps(
                    {"error": {"code": "previous_response_not_found"}}
                ).encode(),
                True,
            )
        )
        self.assertFalse(
            is_previous_response_error(
                404, json.dumps({"error": {"code": "not_found"}}).encode(), True
            )
        )

    def test_external_artifact_links_are_credential_free(self) -> None:
        self.assertEqual(
            validate_external_artifact_url(
                "https://files.example.edu/output/report.pdf"
            ),
            "https://files.example.edu/output/report.pdf",
        )
        with self.assertRaisesRegex(ContractError, "credential-free HTTPS"):
            validate_external_artifact_url(
                "https://files.example.edu/report.pdf?token=secret"
            )
        with self.assertRaisesRegex(ContractError, "credential-free HTTPS"):
            validate_external_artifact_url(
                "https://user:secret@files.example.edu/report.pdf"
            )
        with self.assertRaisesRegex(ContractError, "credential-free HTTPS"):
            validate_external_artifact_url("https://:443/report.pdf")

    def test_platform_origin_is_canonical_ascii(self) -> None:
        self.assertEqual(
            validate_platform_origin(self.platform_origin), self.platform_origin
        )
        with self.assertRaisesRegex(ContractError, "platform origin"):
            validate_platform_origin("https://sage.example.edu/path")
        with self.assertRaisesRegex(ContractError, "platform origin"):
            validate_platform_origin("https://faß.de")


if __name__ == "__main__":
    unittest.main()
