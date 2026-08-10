"""Provider request construction kept in parity with the Node template."""

from __future__ import annotations


def build_provider_request(
    *,
    input_items: list[object],
    instructions: str,
    model: str,
    previous_response_id: str | None,
) -> dict[str, object]:
    if not isinstance(input_items, list):
        raise TypeError("provider input must be an array")
    if not isinstance(instructions, str) or not instructions.strip():
        raise TypeError("provider instructions must be non-empty text")
    if not isinstance(model, str) or not model.strip():
        raise TypeError("provider model must be non-empty text")
    payload: dict[str, object] = {
        "model": model,
        "instructions": instructions,
        "input": input_items,
        "stream": True,
    }
    if previous_response_id:
        payload["previous_response_id"] = previous_response_id
    return payload
