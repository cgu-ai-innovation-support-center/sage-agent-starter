# Changelog

## 0.1.2 - 2026-08-10

- Replace provider-supplied SSE failure fields with one fixed generic terminal
  event so upstream error details cannot reach the browser or logs.
- Reject malformed, untyped, mismatched, and duplicate-key SSE events before
  they can advance durable continuation state.
- Bound Node response backpressure and align FastAPI URL host validation with
  the Node template.

## 0.1.1 - 2026-08-10

- Treat an early provider failure, incomplete event, error, or `[DONE]` as an
  irreversible non-success terminal.
- Validate configured SAGE and optional Artifact URLs during readiness.
- Reject non-ASCII lease origins to keep Node and HTTPX origin comparison
  identical.

## 0.1.0 - 2026-08-10

- Publish matching Node and FastAPI `stateful-v1` starter templates.
- Add local SQLite continuation-state adapters and restart tests.
- Gate terminal completion on a durable conversation-scoped state write.
- Add compatibility, exposure, contract, and doctor checks.
- Document the Codex / Claude Code workflow, container build, registration,
  rollback, and security boundaries in Traditional Chinese and English.
