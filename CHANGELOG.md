# Changelog

## 0.1.5 - 2026-08-12

- Report a locally configured Agent model as unverified until a real SAGE run
  confirms that the selected Budget permits the exact alias.
- Require both application images to label the exact clean source commit with
  `org.opencontainers.image.revision`, and verify it in the full local gate.

## 0.1.4 - 2026-08-12

- Add one exact-prompt, no-side-effect approval demonstration to both runtime
  templates so a teacher can verify the real SAGE approval/result UI without
  granting an external tool or data mutation.
- Persist conversation-scoped pending actions for at least seven days, require
  the complete ordered approval set, consume it once, reject replay, and keep
  the provider continuation head usable after the local result.
- Extend Node and FastAPI tests through restart, approve, deny, replay
  rejection, backup/restore, and post-approval continuation.
- Upgrade FastAPI, Starlette, and Uvicorn past the audited Starlette advisories,
  then enforce SHA-256 hashes for every Python dependency artifact during the
  container build.

## 0.1.3 - 2026-08-10

- Add a coding-agent harness with task routing, architecture/code references,
  a machine-readable safe-customization policy, and a minimal course-tutor
  vertical slice shared by Node and FastAPI.
- Add top-level provider `instructions` without changing SAGE's newest-input
  or continuation behavior, plus shared golden parity tests.
- Add an optional non-root, capability-dropped Caddy private-CA HTTPS profile,
  exact public-only `sage-agent-trust.json`, certificate/data checks, and TLS
  doctor while keeping network reachability under SAGE safe-egress policy.
- Separate SHA-pinned maintainer lightweight CI from the Docker-backed local
  full gate; the full gate starts both runtimes and tests HTTP/TLS readiness.
- Log sanitized Node stream outcomes for completed, failed, and incomplete
  provider streams.

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
