"""Deterministic, no-side-effect approval demonstration for Starter validation."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

APPROVAL_DEMO_PROMPT = "SAGE_APPROVAL_DEMO"
TOOL_NAME = "preview_safe_course_hint"
SERVER_LABEL = "SAGE Starter demo"
ARGUMENTS = {"action": TOOL_NAME, "effect": "none"}


def _bounded(value: object, name: str, maximum: int = 512) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or not 1 <= len(value) <= maximum
    ):
        raise TypeError(f"{name} must be bounded non-empty text")
    return value


def _digest(invocation_key: str, fields: list[str]) -> str:
    key = _bounded(invocation_key, "invocation_key", 4096).encode()
    mac = hmac.new(key, digestmod=hashlib.sha256)
    for field in fields:
        mac.update(b"\0")
        mac.update(_bounded(field, "digest field", 131_072).encode())
    return base64.urlsafe_b64encode(mac.digest()).decode().rstrip("=")


def _frame(value: dict[str, object]) -> bytes:
    return f"data: {json.dumps(value, separators=(',', ':'))}\n\n".encode()


def is_approval_demo_input(items: list[object]) -> bool:
    return (
        len(items) == 1
        and isinstance(items[0], dict)
        and items[0].get("role") == "user"
        and items[0].get("content") == APPROVAL_DEMO_PROMPT
    )


def approval_request_id(
    invocation_key: str, conversation_id: str, provider_response_id: str
) -> str:
    return "mcpr_" + _digest(
        invocation_key,
        ["approval-request-v1", conversation_id, provider_response_id],
    )


def approval_result_response_id(
    invocation_key: str,
    conversation_id: str,
    previous_response_id: str,
    responses: list[dict[str, object]],
) -> str:
    if not responses:
        raise TypeError("approval responses must be non-empty")
    decisions: list[str] = []
    for response in responses:
        approval_id = _bounded(
            response.get("approval_request_id", response.get("approvalRequestId")),
            "approval_request_id",
            200,
        )
        approved = response.get("approve", response.get("approved"))
        if not isinstance(approved, bool):
            raise TypeError("approve must be boolean")
        decisions.append(f"{approval_id}:{'approve' if approved else 'deny'}")
    return "resp_demo_" + _digest(
        invocation_key,
        [
            "approval-result-v1",
            conversation_id,
            previous_response_id,
            "\n".join(decisions),
        ],
    )


def approval_demo_pending_action(approval_id: str) -> dict[str, object]:
    return {
        "approval_request_id": _bounded(approval_id, "approval_id", 200),
        "arguments_json": json.dumps(ARGUMENTS, separators=(",", ":")),
        "effect": "none",
        "server_label": SERVER_LABEL,
        "tool_name": TOOL_NAME,
    }


def approval_demo_request_frames(action: dict[str, object]) -> tuple[bytes, ...]:
    item = {
        "arguments": action["arguments_json"],
        "id": action["approval_request_id"],
        "name": action["tool_name"],
        "server_label": action["server_label"],
        "type": "mcp_approval_request",
    }
    return (
        _frame({"item": item, "type": "response.output_item.added"}),
        _frame({"item": item, "type": "response.output_item.done"}),
    )


def approval_demo_result_frames(
    actions: list[dict[str, object]], response_id: str
) -> tuple[bytes, ...]:
    if not actions:
        raise TypeError("approval actions must be non-empty")
    frames: list[bytes] = []
    for action in actions:
        if action["approved"]:
            frames.append(
                _frame(
                    {
                        "item": {
                            "approval_request_id": action["approval_request_id"],
                            "arguments": action["arguments_json"],
                            "id": f"result_{action['approval_request_id']}",
                            "name": action["tool_name"],
                            "output": "Approved preview completed. No external action was performed.",
                            "server_label": action["server_label"],
                            "status": "completed",
                            "type": "mcp_call",
                        },
                        "type": "response.output_item.done",
                    }
                )
            )
    all_approved = all(bool(action["approved"]) for action in actions)
    frames.append(
        _frame(
            {
                "delta": (
                    "Approval recorded. This bounded demonstration only returned a preview; No external action was performed."
                    if all_approved
                    else "The demonstration was denied. No action was performed."
                ),
                "type": "response.output_text.delta",
            }
        )
    )
    frames.append(
        _frame(
            {
                "response": {"id": _bounded(response_id, "response_id")},
                "type": "response.completed",
            }
        )
    )
    return tuple(frames)
