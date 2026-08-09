const conversationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function contractError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function hasOnlyKeys(value, allowed) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validApproval(item) {
  return (
    hasOnlyKeys(
      item,
      new Set(["approval_request_id", "approve", "reason", "type"])
    ) &&
    item.type === "mcp_approval_response" &&
    typeof item.approval_request_id === "string" &&
    item.approval_request_id === item.approval_request_id.trim() &&
    item.approval_request_id.length >= 1 &&
    item.approval_request_id.length <= 200 &&
    typeof item.approve === "boolean" &&
    (item.reason === undefined ||
      (typeof item.reason === "string" &&
        item.reason === item.reason.trim() &&
        item.reason.length >= 1 &&
        item.reason.length <= 500))
  );
}

function platformOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw contractError("invalid configured SAGE platform origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw contractError("invalid configured SAGE platform origin");
  }
  return url.origin;
}

function modelAccess(body, expectedOrigin) {
  const value = body?.model_access;
  if (
    !hasOnlyKeys(
      value,
      new Set(["base_url", "expires_at", "mode", "token"])
    ) ||
    value.mode !== "platform_proxy_v1" ||
    typeof value.base_url !== "string" ||
    typeof value.expires_at !== "string" ||
    typeof value.token !== "string" ||
    !/^mp1\.[A-Za-z0-9_-]{43}$/.test(value.token)
  ) {
    throw contractError("invalid model proxy lease");
  }
  let url;
  try {
    url = new URL(value.base_url);
  } catch {
    throw contractError("invalid model proxy URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== "/api/agents/model-proxy/v1" ||
    url.origin !== platformOrigin(expectedOrigin)
  ) {
    throw contractError("invalid model proxy URL");
  }
  const expiresAt = Date.parse(value.expires_at);
  if (
    !timestampPattern.test(value.expires_at) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    throw contractError("expired model proxy lease");
  }
  return {
    baseUrl: value.base_url.replace(/\/$/, ""),
    token: value.token,
  };
}

function artifactAccess(body, expectedOrigin) {
  const value = body?.artifact_access;
  if (
    !hasOnlyKeys(
      value,
      new Set([
        "accepted_media_types",
        "expires_at",
        "max_file_bytes",
        "max_files",
        "max_total_bytes",
        "token",
        "upload_url",
      ])
    ) ||
    !Array.isArray(value.accepted_media_types) ||
    value.accepted_media_types.length !== 3 ||
    new Set(value.accepted_media_types).size !== 3 ||
    !["image/jpeg", "image/png", "image/webp"].every((mediaType) =>
      value.accepted_media_types.includes(mediaType)
    ) ||
    value.max_file_bytes !== 10_485_760 ||
    value.max_files !== 4 ||
    value.max_total_bytes !== 20_971_520 ||
    typeof value.expires_at !== "string" ||
    typeof value.token !== "string" ||
    !/^af1\.[A-Za-z0-9_-]{43}$/.test(value.token)
  ) {
    throw contractError("invalid artifact upload lease");
  }
  let uploadUrl;
  try {
    uploadUrl = new URL(value.upload_url);
  } catch {
    throw contractError("invalid artifact upload URL");
  }
  if (
    uploadUrl.protocol !== "https:" ||
    uploadUrl.username ||
    uploadUrl.password ||
    uploadUrl.search ||
    uploadUrl.hash ||
    uploadUrl.pathname !== "/api/agents/artifacts" ||
    uploadUrl.origin !== platformOrigin(expectedOrigin)
  ) {
    throw contractError("invalid artifact upload URL");
  }
  const expiresAt = Date.parse(value.expires_at);
  if (
    !timestampPattern.test(value.expires_at) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    throw contractError("expired artifact upload lease");
  }
  return { token: value.token, uploadUrl: uploadUrl.toString() };
}

export function validateShowcaseContract(headers, body, expectedOrigin) {
  if (headers["x-sage-responses-profile"] !== "stateful-v1") {
    throw contractError("stateful-v1 profile required");
  }
  const conversationId = headers["x-sage-conversation-id"];
  if (
    typeof conversationId !== "string" ||
    !conversationIdPattern.test(conversationId)
  ) {
    throw contractError("invalid conversation scope");
  }
  if (
    !hasOnlyKeys(
      body,
      new Set([
        "artifact_access",
        "input",
        "model",
        "model_access",
        "previous_response_id",
        "stream",
      ])
    ) ||
    body.model !== "agent" ||
    body.stream !== true ||
    !Array.isArray(body.input) ||
    body.input.length !== 1 ||
    !hasOnlyKeys(body.input[0], new Set(["content", "role"])) ||
    body.input[0]?.role !== "user" ||
    typeof body.input[0]?.content !== "string" ||
    body.input[0].content !== body.input[0].content.trim() ||
    body.input[0].content.length < 1 ||
    body.input[0].content.length > 65_536
  ) {
    throw contractError("invalid showcase Responses profile");
  }
  const previous = body.previous_response_id;
  if (
    previous !== undefined &&
    (typeof previous !== "string" ||
      previous !== previous.trim() ||
      previous.length < 1 ||
      previous.length > 512)
  ) {
    throw contractError("invalid previous response ID");
  }
  modelAccess(body, expectedOrigin);
  return {
    artifact: artifactAccess(body, expectedOrigin),
    conversationId: conversationId.toLowerCase(),
    input: body.input[0].content,
    previous,
  };
}

export function validatePlatformContract(headers, body, expectedOrigin) {
  if (headers["x-sage-responses-profile"] !== "stateful-v1") {
    throw contractError("stateful-v1 profile required");
  }
  const conversationId = headers["x-sage-conversation-id"];
  if (
    typeof conversationId !== "string" ||
    !conversationIdPattern.test(conversationId)
  ) {
    throw contractError("invalid conversation scope");
  }
  if (
    !hasOnlyKeys(
      body,
      new Set([
        "artifact_access",
        "input",
        "model",
        "model_access",
        "previous_response_id",
        "stream",
      ])
    ) ||
    body.model !== "agent" ||
    body.stream !== true
  ) {
    throw contractError("invalid Responses profile");
  }
  artifactAccess(body, expectedOrigin);
  const proxy = modelAccess(body, expectedOrigin);
  if (!Array.isArray(body.input) || body.input.length < 1) {
    throw contractError("input must be a bounded list");
  }
  const previous = body.previous_response_id;
  if (
    previous !== undefined &&
    (typeof previous !== "string" ||
      previous !== previous.trim() ||
      previous.length < 1 ||
      previous.length > 512)
  ) {
    throw contractError("invalid previous response ID");
  }
  const approvalContinuation = body.input.every(
    (item) => item?.type === "mcp_approval_response"
  );
  if (approvalContinuation) {
    const approvalIds = body.input.map((item) => item.approval_request_id);
    if (
      previous === undefined ||
      !body.input.every(validApproval) ||
      new Set(approvalIds).size !== body.input.length
    ) {
      throw contractError("invalid approval continuation");
    }
  }
  if (
    !approvalContinuation &&
    (body.input.length !== 1 ||
      !hasOnlyKeys(body.input[0], new Set(["content", "role"])) ||
      body.input[0]?.role !== "user" ||
      typeof body.input[0]?.content !== "string" ||
      body.input[0].content !== body.input[0].content.trim() ||
      body.input[0].content.length < 1 ||
      body.input[0].content.length > 65_536)
  ) {
    throw contractError("normal turns require one new user input");
  }
  return {
    artifact: artifactAccess(body, expectedOrigin),
    conversationId: conversationId.toLowerCase(),
    input: body.input,
    previous,
    proxy,
  };
}

export function isPreviousResponseError(status, raw, hadPrevious) {
  if (!hadPrevious || ![400, 404, 409, 410].includes(status)) {
    return false;
  }
  try {
    const payload = JSON.parse(raw.toString("utf8"));
    return (
      payload?.error?.code === "previous_response_not_found" ||
      payload?.code === "previous_response_not_found"
    );
  } catch {
    return false;
  }
}

export function validateExternalArtifactUrl(raw) {
  if (typeof raw !== "string" || raw !== raw.trim() || raw.length < 1) {
    throw contractError("invalid external Artifact URL");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw contractError("invalid external Artifact URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw contractError("external Artifact URL must be credential-free HTTPS");
  }
  return raw;
}
