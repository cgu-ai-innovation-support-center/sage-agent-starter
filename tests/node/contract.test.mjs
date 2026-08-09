import assert from "node:assert/strict";
import test from "node:test";
import {
  isPreviousResponseError,
  validateExternalArtifactUrl,
  validatePlatformContract,
  validatePlatformOrigin,
} from "../../node/contract.mjs";

const conversationId = "11111111-1111-4111-8111-111111111111";
const platformOrigin = "https://sage.example.edu";
const headers = {
  "x-sage-conversation-id": conversationId,
  "x-sage-responses-profile": "stateful-v1",
};
const modelAccess = {
  base_url: "https://sage.example.edu/api/agents/model-proxy/v1",
  expires_at: "2099-01-01T00:00:00.000Z",
  mode: "platform_proxy_v1",
  token: `mp1.${"a".repeat(43)}`,
};
const artifactAccess = {
  accepted_media_types: ["image/png", "image/jpeg", "image/webp"],
  expires_at: "2099-01-01T00:00:00.000Z",
  max_file_bytes: 10_485_760,
  max_files: 4,
  max_total_bytes: 20_971_520,
  token: `af1.${"b".repeat(43)}`,
  upload_url: "https://sage.example.edu/api/agents/artifacts",
};

function request(input, overrides = {}) {
  return {
    artifact_access: artifactAccess,
    input,
    model: "agent",
    model_access: modelAccess,
    stream: true,
    ...overrides,
  };
}

test("accepts newest-input, chained, and structurally bounded approval turns", () => {
  const first = validatePlatformContract(headers, request([{ content: "first", role: "user" }]), platformOrigin);
  assert.equal(first.conversationId, conversationId);
  assert.equal(first.previous, undefined);
  const next = validatePlatformContract(
    headers,
    request([{ content: "next", role: "user" }], { previous_response_id: "resp-1" }),
    platformOrigin,
  );
  assert.equal(next.previous, "resp-1");

  const approvals = Array.from({ length: 12 }, (_, index) => ({
    approval_request_id: `approval-${index}`,
    approve: index % 2 === 0,
    type: "mcp_approval_response",
  }));
  assert.equal(
    validatePlatformContract(headers, request(approvals, { previous_response_id: "resp-approval" }), platformOrigin).input.length,
    12,
  );
  assert.throws(
    () => validatePlatformContract(
      headers,
      request([approvals[0], { ...approvals[1], approval_request_id: "approval-0" }], {
        previous_response_id: "resp-approval",
      }),
      platformOrigin,
    ),
    /invalid approval continuation/,
  );
});

test("rejects full history, missing scope, and malformed run leases", () => {
  assert.throws(
    () => validatePlatformContract(headers, request([
      { content: "first", role: "user" },
      { content: "answer", role: "assistant" },
      { content: "next", role: "user" },
    ]), platformOrigin),
    /one new user input/,
  );
  assert.throws(
    () => validatePlatformContract({}, request([{ content: "first", role: "user" }]), platformOrigin),
    /stateful-v1 profile required/,
  );
  assert.throws(
    () => validatePlatformContract(headers, {
      ...request([{ content: "first", role: "user" }]),
      model_access: { ...modelAccess, expires_at: "2000-01-01T00:00:00.000Z" },
    }, platformOrigin),
    /expired model proxy lease/,
  );
  assert.throws(
    () => validatePlatformContract(headers, {
      ...request([{ content: "first", role: "user" }]),
      model_access: { ...modelAccess, expires_at: "2099-01-01T00:00:00" },
    }, platformOrigin),
    /expired model proxy lease/,
  );
  assert.throws(
    () => validatePlatformContract(headers, {
      ...request([{ content: "first", role: "user" }]),
      artifact_access: { ...artifactAccess, upload_url: "http://sage.example.edu/api/agents/artifacts" },
    }, platformOrigin),
    /artifact upload URL/,
  );
  assert.throws(
    () => validatePlatformContract(headers, {
      ...request([{ content: "first", role: "user" }]),
      model_access: {
        ...modelAccess,
        base_url: "https://attacker.example/api/agents/model-proxy/v1",
      },
    }, platformOrigin),
    /model proxy URL/,
  );
  assert.throws(
    () => validatePlatformContract(headers, {
      ...request([{ content: "first", role: "user" }]),
      artifact_access: {
        ...artifactAccess,
        upload_url: "https://fass.de/api/agents/artifacts",
      },
      model_access: {
        ...modelAccess,
        base_url: "https://faß.de/api/agents/model-proxy/v1",
      },
    }, "https://fass.de"),
    /model proxy URL/,
  );
});

test("normalizes only exact continuation loss", () => {
  assert.equal(
    isPreviousResponseError(
      404,
      Buffer.from(JSON.stringify({ error: { code: "previous_response_not_found" } })),
      true,
    ),
    true,
  );
  assert.equal(
    isPreviousResponseError(404, Buffer.from(JSON.stringify({ error: { code: "not_found" } })), true),
    false,
  );
});

test("accepts only credential-free external Artifact links", () => {
  assert.equal(
    validateExternalArtifactUrl("https://files.example.edu/output/report.pdf"),
    "https://files.example.edu/output/report.pdf",
  );
  assert.throws(
    () => validateExternalArtifactUrl("https://files.example.edu/report.pdf?token=secret"),
    /credential-free HTTPS/,
  );
  assert.throws(
    () => validateExternalArtifactUrl("https://user:secret@files.example.edu/report.pdf"),
    /credential-free HTTPS/,
  );
});

test("requires a canonical ASCII SAGE platform origin", () => {
  assert.equal(validatePlatformOrigin(platformOrigin), platformOrigin);
  assert.throws(() => validatePlatformOrigin("https://sage.example.edu/path"), /platform origin/);
  assert.throws(() => validatePlatformOrigin("https://faß.de"), /platform origin/);
});
