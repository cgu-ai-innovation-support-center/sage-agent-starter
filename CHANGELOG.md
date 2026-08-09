# Changelog

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
