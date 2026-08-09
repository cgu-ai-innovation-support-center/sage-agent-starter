"""Dependency-free validation for the Sage stateful Responses profile."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import RFC_4122, UUID

MAX_ERROR_BYTES = 64_000
TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)


class ContractError(ValueError):
    """The platform request does not conform to the stateful profile."""


def _has_only_keys(value: object, allowed: set[str]) -> bool:
    return isinstance(value, dict) and set(value).issubset(allowed)


def _valid_approval(item: object) -> bool:
    if not _has_only_keys(
        item, {"approval_request_id", "approve", "reason", "type"}
    ):
        return False
    approval_id = item.get("approval_request_id")
    reason = item.get("reason")
    return (
        item.get("type") == "mcp_approval_response"
        and isinstance(approval_id, str)
        and approval_id == approval_id.strip()
        and 1 <= len(approval_id) <= 200
        and isinstance(item.get("approve"), bool)
        and (
            "reason" not in item
            or (
                isinstance(reason, str)
                and reason == reason.strip()
                and 1 <= len(reason) <= 500
            )
        )
    )


def _parsed_origin(parsed) -> str:
    try:
        port = parsed.port
        host = parsed.hostname.lower()
    except (AttributeError, ValueError) as exc:
        raise ContractError("invalid configured SAGE platform origin") from exc
    rendered_host = f"[{host}]" if ":" in host else host
    suffix = "" if port in {None, 443} else f":{port}"
    return f"https://{rendered_host}{suffix}"


def validate_platform_origin(value: str) -> str:
    if not isinstance(value, str) or not value.isascii():
        raise ContractError("invalid configured SAGE platform origin")
    try:
        parsed = urlparse(value)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ContractError("invalid configured SAGE platform origin") from exc
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.params
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ContractError("invalid configured SAGE platform origin")
    return _parsed_origin(parsed)


def _model_access(
    body: dict[str, object], expected_origin: str
) -> tuple[str, str]:
    value = body.get("model_access")
    if not _has_only_keys(value, {"base_url", "expires_at", "mode", "token"}):
        raise ContractError("platform model proxy lease required")
    assert isinstance(value, dict)
    base_url = value.get("base_url")
    expires_at = value.get("expires_at")
    token = value.get("token")
    if value.get("mode") != "platform_proxy_v1" or not isinstance(
        base_url, str
    ):
        raise ContractError("invalid model proxy lease")
    parsed = urlparse(base_url)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.params
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") != "/api/agents/model-proxy/v1"
        or not base_url.isascii()
        or _parsed_origin(parsed) != validate_platform_origin(expected_origin)
    ):
        raise ContractError("invalid model proxy URL")
    if (
        not isinstance(token, str)
        or re.fullmatch(r"mp1\.[A-Za-z0-9_-]{43}", token) is None
    ):
        raise ContractError("invalid model proxy token")
    if not isinstance(expires_at, str) or TIMESTAMP_PATTERN.fullmatch(expires_at) is None:
        raise ContractError("invalid model proxy expiry")
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError("invalid model proxy expiry") from exc
    if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc):
        raise ContractError("expired model proxy lease")
    return base_url.rstrip("/"), token


def _artifact_access(body: dict[str, object], expected_origin: str) -> None:
    value = body.get("artifact_access")
    if not _has_only_keys(
        value,
        {
            "accepted_media_types",
            "expires_at",
            "max_file_bytes",
            "max_files",
            "max_total_bytes",
            "token",
            "upload_url",
        },
    ):
        raise ContractError("invalid artifact upload lease")
    assert isinstance(value, dict)
    accepted_media_types = value.get("accepted_media_types")
    token = value.get("token")
    if (
        not isinstance(accepted_media_types, list)
        or len(accepted_media_types) != 3
        or not all(isinstance(item, str) for item in accepted_media_types)
        or set(accepted_media_types)
        != {"image/jpeg", "image/png", "image/webp"}
        or value.get("max_file_bytes") != 10_485_760
        or value.get("max_files") != 4
        or value.get("max_total_bytes") != 20_971_520
        or not isinstance(token, str)
        or re.fullmatch(r"af1\.[A-Za-z0-9_-]{43}", token) is None
    ):
        raise ContractError("invalid artifact upload lease")
    upload_url = value.get("upload_url")
    if not isinstance(upload_url, str):
        raise ContractError("invalid artifact upload URL")
    parsed = urlparse(upload_url)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.params
        or parsed.query
        or parsed.fragment
        or parsed.path != "/api/agents/artifacts"
        or not upload_url.isascii()
        or _parsed_origin(parsed) != validate_platform_origin(expected_origin)
    ):
        raise ContractError("invalid artifact upload URL")
    expires_at = value.get("expires_at")
    if not isinstance(expires_at, str) or TIMESTAMP_PATTERN.fullmatch(expires_at) is None:
        raise ContractError("invalid artifact upload expiry")
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError("invalid artifact upload expiry") from exc
    if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc):
        raise ContractError("expired artifact upload lease")


def validate_platform_contract(
    headers: Mapping[str, str], body: object, expected_origin: str
) -> tuple[list[object], str | None, str, str, str]:
    if headers.get("x-sage-responses-profile") != "stateful-v1":
        raise ContractError("stateful-v1 profile required")
    conversation_id = headers.get("x-sage-conversation-id", "")
    try:
        parsed_conversation_id = UUID(conversation_id)
        if (
            str(parsed_conversation_id) != conversation_id.lower()
            or parsed_conversation_id.version not in {1, 2, 3, 4, 5}
            or parsed_conversation_id.variant != RFC_4122
        ):
            raise ValueError
    except (ValueError, AttributeError) as exc:
        raise ContractError("invalid conversation scope") from exc
    if (
        not isinstance(body, dict)
        or not _has_only_keys(
            body,
            {
                "artifact_access",
                "input",
                "model",
                "model_access",
                "previous_response_id",
                "stream",
            },
        )
        or body.get("model") != "agent"
        or body.get("stream") is not True
    ):
        raise ContractError("invalid Responses profile")
    _artifact_access(body, expected_origin)
    model_proxy_base_url, model_proxy_token = _model_access(body, expected_origin)
    items = body.get("input")
    if not isinstance(items, list) or len(items) < 1:
        raise ContractError("input must be a bounded list")
    previous = body.get("previous_response_id")
    if previous is not None and (
        not isinstance(previous, str)
        or previous != previous.strip()
        or not 1 <= len(previous) <= 512
    ):
        raise ContractError("invalid previous response ID")
    approval_continuation = all(
        isinstance(item, dict) and item.get("type") == "mcp_approval_response"
        for item in items
    )
    if approval_continuation:
        approval_ids = [item.get("approval_request_id") for item in items]
        if (
            previous is None
            or not all(map(_valid_approval, items))
            or len(set(approval_ids)) != len(items)
        ):
            raise ContractError("invalid approval continuation")
    if not approval_continuation and (
        len(items) != 1
        or not isinstance(items[0], dict)
        or not _has_only_keys(items[0], {"content", "role"})
        or items[0].get("role") != "user"
        or not isinstance(items[0].get("content"), str)
        or items[0]["content"] != items[0]["content"].strip()
        or not 1 <= len(items[0]["content"]) <= 65_536
    ):
        raise ContractError("normal turns require one new user input")
    return (
        items,
        previous,
        model_proxy_base_url,
        model_proxy_token,
        conversation_id.lower(),
    )


def is_previous_response_error(
    status_code: int, raw: bytes, had_previous: bool
) -> bool:
    if (
        not had_previous
        or status_code not in {400, 404, 409, 410}
        or len(raw) > MAX_ERROR_BYTES
    ):
        return False
    try:
        payload = json.loads(raw)
        error = payload.get("error") if isinstance(payload, dict) else None
        code = error.get("code") if isinstance(error, dict) else payload.get("code")
    except (AttributeError, json.JSONDecodeError, UnicodeDecodeError):
        return False
    return code == "previous_response_not_found"


def validate_external_artifact_url(raw: object) -> str:
    if not isinstance(raw, str) or raw != raw.strip() or not raw:
        raise ContractError("invalid external Artifact URL")
    parsed = urlparse(raw)
    try:
        parsed.port
    except ValueError as exc:
        raise ContractError("invalid external Artifact URL") from exc
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.params
        or parsed.query
        or parsed.fragment
        or not raw.isascii()
    ):
        raise ContractError("external Artifact URL must be credential-free HTTPS")
    return raw
