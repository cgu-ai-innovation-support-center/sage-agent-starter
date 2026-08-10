export function buildProviderRequest({
  input,
  instructions,
  model,
  previousResponseId,
}) {
  if (!Array.isArray(input)) throw new TypeError("provider input must be an array");
  if (typeof instructions !== "string" || !instructions.trim()) {
    throw new TypeError("provider instructions must be non-empty text");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new TypeError("provider model must be non-empty text");
  }
  return {
    model,
    instructions,
    input,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    stream: true,
  };
}
