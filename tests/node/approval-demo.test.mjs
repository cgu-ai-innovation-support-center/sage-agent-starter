import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_DEMO_PROMPT,
  approvalDemoPendingAction,
  approvalDemoRequestFrames,
  approvalDemoResultFrames,
  approvalRequestId,
  approvalResultResponseId,
  isApprovalDemoInput,
} from "../../node/approval-demo.mjs";

const invocationKey = `fixture-${"x".repeat(40)}`;
const conversationId = "11111111-1111-4111-8111-111111111111";

test("approval demo is an exact, deterministic, no-side-effect surface", () => {
  assert.equal(
    isApprovalDemoInput([{ content: APPROVAL_DEMO_PROMPT, role: "user" }]),
    true,
  );
  assert.equal(
    isApprovalDemoInput([{ content: `${APPROVAL_DEMO_PROMPT} please`, role: "user" }]),
    false,
  );
  assert.equal(
    isApprovalDemoInput([{ content: APPROVAL_DEMO_PROMPT, role: "assistant" }]),
    false,
  );

  const approvalId = approvalRequestId(
    invocationKey,
    conversationId,
    "resp-provider-1",
  );
  assert.match(approvalId, /^mcpr_[A-Za-z0-9_-]{43}$/u);
  assert.equal(
    approvalId,
    approvalRequestId(invocationKey, conversationId, "resp-provider-1"),
  );
  assert.notEqual(
    approvalId,
    approvalRequestId(invocationKey, conversationId, "resp-provider-2"),
  );

  const action = approvalDemoPendingAction(approvalId);
  assert.deepEqual(action, {
    approvalRequestId: approvalId,
    argumentsJson: '{"action":"preview_safe_course_hint","effect":"none"}',
    serverLabel: "SAGE Starter demo",
    toolName: "preview_safe_course_hint",
  });

  const requestFrames = approvalDemoRequestFrames(action);
  const requestBody = requestFrames.join("");
  const firstEvent = JSON.parse(requestFrames[0].slice(6));
  assert.match(requestBody, /mcp_approval_request/u);
  assert.deepEqual(JSON.parse(firstEvent.item.arguments), {
    action: "preview_safe_course_hint",
    effect: "none",
  });
  assert.doesNotMatch(requestBody, /AGENT_INVOCATION_KEY|model_access|authorization/iu);
});

test("approval demo result IDs and frames distinguish approve and deny", () => {
  const approvals = [
    { approvalRequestId: "mcpr_demo", approved: true },
  ];
  const resultId = approvalResultResponseId(
    invocationKey,
    conversationId,
    "resp-pending",
    approvals,
  );
  assert.match(resultId, /^resp_demo_[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(
    resultId,
    approvalResultResponseId(invocationKey, conversationId, "resp-pending", [
      { approvalRequestId: "mcpr_demo", approved: false },
    ]),
  );

  const action = approvalDemoPendingAction("mcpr_demo");
  const approvedBody = approvalDemoResultFrames({
    actions: [{ ...action, approved: true }],
    responseId: resultId,
  }).join("");
  assert.match(approvedBody, /response\.output_item\.done/u);
  assert.match(approvedBody, /No external action was performed/u);
  assert.match(approvedBody, /response\.completed/u);

  const deniedBody = approvalDemoResultFrames({
    actions: [{ ...action, approved: false }],
    responseId: "resp_demo_denied",
  }).join("");
  assert.doesNotMatch(deniedBody, /response\.output_item\.done/u);
  assert.match(deniedBody, /denied/u);
  assert.match(deniedBody, /No action was performed/u);
});
