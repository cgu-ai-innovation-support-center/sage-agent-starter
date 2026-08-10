"""Fixed-path Agent behavior profile shared with the Node template."""

from __future__ import annotations

import json
from pathlib import Path

DEFAULT_AGENT_DIRECTORY = Path(__file__).resolve().parents[1] / "agent"
MAX_PROFILE_BYTES = 4_096
MAX_INSTRUCTIONS_BYTES = 32_768
PROFILE_KEYS = {"display_name", "id", "instructions_file", "schema"}


def _read_fixed_file(path: Path, maximum: int, label: str, root: Path) -> str:
    resolved_root = root.resolve(strict=True)
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label} must be a regular non-symlink file")
    resolved = path.resolve(strict=True)
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ValueError(f"{label} must stay inside the fixed agent directory")
    size = path.stat().st_size
    if not 1 <= size <= maximum:
        raise ValueError(f"{label} must contain 1 to {maximum} bytes")
    try:
        return path.read_bytes().decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{label} must be valid UTF-8") from exc


def load_agent_profile(agent_directory: Path | None = None) -> dict[str, str]:
    root = (agent_directory or DEFAULT_AGENT_DIRECTORY).resolve()
    profile_path = root / "profile.json"
    try:
        profile = json.loads(
            _read_fixed_file(profile_path, MAX_PROFILE_BYTES, "agent profile", root)
        )
    except json.JSONDecodeError as exc:
        raise ValueError("agent profile must be valid JSON") from exc
    if not isinstance(profile, dict) or set(profile) != PROFILE_KEYS:
        raise ValueError(
            "agent profile must contain exactly: "
            + ", ".join(sorted(PROFILE_KEYS))
        )
    if profile["schema"] != "sage-agent-profile-v1":
        raise ValueError("unsupported agent profile schema")
    identifier = profile["id"]
    if (
        not isinstance(identifier, str)
        or not 3 <= len(identifier) <= 64
        or not identifier[0].isalpha()
        or not identifier[0].islower()
        or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in identifier)
    ):
        raise ValueError("agent profile id must be a bounded lowercase slug")
    display_name = profile["display_name"]
    if (
        not isinstance(display_name, str)
        or display_name != display_name.strip()
        or not 1 <= len(display_name) <= 120
    ):
        raise ValueError("agent profile display_name must contain 1 to 120 characters")
    if profile["instructions_file"] != "instructions.md":
        raise ValueError(
            "agent profile instructions_file must be exactly instructions.md"
        )
    instructions = _read_fixed_file(
        root / "instructions.md",
        MAX_INSTRUCTIONS_BYTES,
        "agent instructions",
        root,
    ).strip()
    if not instructions or "\x00" in instructions:
        raise ValueError(
            "agent instructions must contain bounded text without NUL bytes"
        )
    return {
        "display_name": display_name,
        "id": identifier,
        "instructions": instructions,
    }
