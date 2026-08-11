# Minimal course tutor requirements / 最小課程助教需求

## Learning goal / 學習目標

Help a learner understand a teacher-provided concept through a brief
explanation and one check-for-understanding question. 協助學生理解教師提供的
單一概念，先簡短說明，再提出一個理解檢核問題。

## Inputs and outputs / 輸入與輸出

- Input: the newest SAGE user message or approval-result set defined by the
  `stateful-v1` contract.
- Output: streamed explanatory text through the existing Responses adapter.
- 預設使用繁體中文；學生要求時可使用其他語言。

## Explicit limits / 明確限制

- No files, domain/data-changing tools, RAG, browser, external API, or third
  runtime. The exact `SAGE_APPROVAL_DEMO` prompt is a fixed no-side-effect
  protocol rehearsal, not a teacher customization seam.
- No claim of having accessed course material that was not in the newest input.
- No autonomous grading, deadlines, enrollment decisions, or personal-data
  processing.
- Keep SAGE's existing continuation, Budget, authentication, lease, and
  failure behavior unchanged.

## Operations / 維運

The teacher owns the instruction content. The operator owns deployment,
monitoring, state backup, credential and certificate rotation, and rollback.
