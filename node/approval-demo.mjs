import { createHmac } from "node:crypto";

export const APPROVAL_DEMO_PROMPT = "SAGE_APPROVAL_DEMO";
const TOOL_NAME = "preview_safe_course_hint";
const SERVER_LABEL = "SAGE Starter demo";
const ARGUMENTS = Object.freeze({
  action: TOOL_NAME,
  effect: "none",
});

function bounded(value, name, maximum = 512) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > maximum
  ) {
    throw new TypeError(`${name} must be bounded non-empty text`);
  }
  return value;
}

function digest(invocationKey, fields) {
  bounded(invocationKey, "invocationKey", 4096);
  const mac = createHmac("sha256", invocationKey);
  for (const field of fields) {
    mac.update("\0");
    mac.update(bounded(field, "digest field", 131_072));
  }
  return mac.digest("base64url");
}

function frame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function isApprovalDemoInput(input) {
  return (
    Array.isArray(input) &&
    input.length === 1 &&
    input[0]?.role === "user" &&
    input[0]?.content === APPROVAL_DEMO_PROMPT
  );
}

export function approvalRequestId(invocationKey, conversationId, providerResponseId) {
  return `mcpr_${digest(invocationKey, [
    "approval-request-v1",
    conversationId,
    providerResponseId,
  ])}`;
}

export function approvalResultResponseId(
  invocationKey,
  conversationId,
  previousResponseId,
  responses,
) {
  if (!Array.isArray(responses) || responses.length < 1) {
    throw new TypeError("approval responses must be non-empty");
  }
  const decision = responses
    .map((response) => {
      const id = bounded(
        response.approvalRequestId ?? response.approval_request_id,
        "approvalRequestId",
        200,
      );
      const approved = response.approved ?? response.approve;
      if (typeof approved !== "boolean") {
        throw new TypeError("approved must be boolean");
      }
      return `${id}:${approved ? "approve" : "deny"}`;
    })
    .join("\n");
  return `resp_demo_${digest(invocationKey, [
    "approval-result-v1",
    conversationId,
    previousResponseId,
    decision,
  ])}`;
}

export function approvalDemoPendingAction(approvalId) {
  return {
    approvalRequestId: bounded(approvalId, "approvalId", 200),
    argumentsJson: JSON.stringify(ARGUMENTS),
    serverLabel: SERVER_LABEL,
    toolName: TOOL_NAME,
  };
}

export function approvalDemoRequestFrames(action) {
  const item = {
    arguments: action.argumentsJson,
    id: action.approvalRequestId,
    name: action.toolName,
    server_label: action.serverLabel,
    type: "mcp_approval_request",
  };
  return [
    frame({ item, type: "response.output_item.added" }),
    frame({ item, type: "response.output_item.done" }),
  ];
}

export function approvalDemoResultFrames({ actions, responseId }) {
  if (!Array.isArray(actions) || actions.length < 1) {
    throw new TypeError("approval actions must be non-empty");
  }
  const frames = [];
  for (const action of actions) {
    if (action.approved) {
      frames.push(frame({
        item: {
          approval_request_id: action.approvalRequestId,
          arguments: action.argumentsJson,
          id: `result_${action.approvalRequestId}`,
          name: action.toolName,
          output: "Approved preview completed. No external action was performed.",
          server_label: action.serverLabel,
          status: "completed",
          type: "mcp_call",
        },
        type: "response.output_item.done",
      }));
    }
  }
  const allApproved = actions.every((action) => action.approved);
  frames.push(frame({
    delta: allApproved
      ? "Approval recorded. This bounded demonstration only returned a preview; No external action was performed."
      : "The demonstration was denied. No action was performed.",
    type: "response.output_text.delta",
  }));
  frames.push(frame({
    response: { id: bounded(responseId, "responseId") },
    type: "response.completed",
  }));
  return frames;
}
