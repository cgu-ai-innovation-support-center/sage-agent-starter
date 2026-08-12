# SAGE Agent Starter

Build a self-hosted Agent that can be registered in CGU SAGE without first
learning the platform protocol in detail. This repository is designed to be
used directly or with a coding assistant such as **Codex / Claude Code**.

> This repository is publicly viewable source, but it is **not open source**.
> Use is governed by the [CGU Internal Use License](LICENSE).

## Choose your language

- [繁體中文：15 分鐘開始使用](docs/zh-TW/quickstart.md)
- [English: 15-minute quickstart](docs/en-US/quickstart.md)

Both templates implement the same reviewed `stateful-v1` contract:

- [`node/`](node/) — no web framework, Node.js 22 or newer.
- [`fastapi/`](fastapi/) — Python 3.12, FastAPI, and HTTPX.

The templates accept one new input at a time, validate SAGE's short-lived
model and Artifact leases, scope continuation state to the immutable SAGE
conversation ID, and stream Responses events. They never receive or store a
LiteLLM Virtual Key or provider credential. Both lease endpoints must match the
exact `SAGE_PLATFORM_ORIGIN` configured by the operator.

Both templates also read the same bounded fixed-path
[`agent/profile.json`](agent/profile.json) and
[`agent/instructions.md`](agent/instructions.md). The included
[minimal course tutor](agent/requirements.md) provides requirements,
instructions, and acceptance prompts without adding files, tools, RAG, or a
third runtime.

Both runtimes include one fixed `SAGE_APPROVAL_DEMO` protocol rehearsal. It
persists a no-side-effect pending action, survives restart, and exercises real
approve/deny/result UI behavior. It cannot call a network service, read a file,
or mutate application data when the approval is executed, and is not a general
tool seam. The ordinary first-turn model response still uses SAGE model access.

## Fastest local check

```bash
npm run doctor
npm run test:light
```

If your system `python3` is older but Python 3.12 is installed separately, set
`PYTHON=/path/to/python3.12` for both commands.

When `AGENT_MODEL` is configured, doctor reports it as a warning: the local
check can validate only that the alias is present and non-placeholder. Only a
real SAGE run can verify that the selected Budget permits that exact alias.

`npm run test:light` validates the compatibility and customization manifests,
known exposure rules, pinned dependencies/actions, shared golden cases, and
dependency-free Node/Python tests. A SHA-pinned maintainer PR workflow runs the
same lightweight sensor. Teachers do not need that workflow, GitHub Actions,
or CI quota to run or deploy an Agent.

Before registration or release, run `npm run test:full`. It additionally builds
and starts both reference containers from a temporary committed-index export,
verifies that each image carries that exact source commit in
`org.opencontainers.image.revision`, probes HTTP
health/readiness, and proves the pinned Caddy private-CA TLS handshake. Commit
the intended source before this gate; a dirty tree cannot be represented by an
exact Git revision. Ignored worktree files are not part of the exported image
context. `npm test` is an alias for this full local gate.

Maintainers run `npm run release:verify` after creating an annotated release
tag. It rejects a dirty worktree, a lightweight tag, or a tag that does not
resolve to the current commit, and invokes the full local gate.

To run a template, copy the placeholders and follow the language quickstart:

```bash
cp .env.example .env
```

Never commit `.env`, the invocation credential, a model-proxy lease, an
Artifact lease, real SAGE URLs, user data, or request bodies.

Deployment and rollback guides:

- [繁體中文](docs/zh-TW/deployment.md)
- [English](docs/en-US/deployment.md)

## Repository contract

- [`contracts/stateful-v1.md`](contracts/stateful-v1.md) is the public author
  contract for this release.
- [`compatibility.json`](compatibility.json) identifies the compatible SAGE
  profile and the parent SAGE baseline used to prepare the release.
- SAGE pins a reviewed release tag and exact commit. It never consumes this
  repository's moving `main` branch as a runtime dependency.
- A version mismatch, missing continuation state, malformed lease, or unknown
  capability fails explicitly. There is no full-history or credential
  fallback.
- [`AGENTS.md`](AGENTS.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), and the
  [code reference](docs/code-reference.md) form the coding-agent harness.
- [`harness/customization-policy.json`](harness/customization-policy.json) and
  `npm run customization:check` distinguish the safe behavior seam from
  review-required protocol/security code.

## Supported and intentionally unsupported

Supported in v0.1:

- Responses-compatible `stateful-v1` ordinary and approval turns.
- Exact `previous_response_not_found` continuation-loss behavior.
- Run-scoped `platform_proxy_v1` model access.
- Run-scoped private image Artifact upload lease validation.
- Restart-safe, conversation-scoped local SQLite state.
- A restart-safe, replay-resistant, no-side-effect approval/result rehearsal.
- Health/readiness endpoints, bounded requests/streams, container builds, and
  secret-safe operational logs.
- A fixed-profile minimal course tutor and top-level provider `instructions`
  that leave SAGE's newest `input` unchanged.
- Optional per-Agent private HTTPS with automatic Caddy leaf renewal and an
  exact public-only SAGE trust bundle.

Not included:

- Reading SAGE's canonical conversation transcript.
- SAGE deployment, registration automation, public/private network routing,
  or managed production hosting.
- A direct LiteLLM key, provider key, or private-network fallback.
- Files, real/domain tools, RAG, LangGraph, or Agents SDK. Add them only after
  defining the data, approval, operational, and verification boundaries. The
  fixed approval demo is validation infrastructure, not a domain tool.

## Security and support

Read [SECURITY.md](SECURITY.md) before publishing an endpoint. Public Agents
remain subject to SAGE HTTPS and safe-egress checks. The Agent owns its tools,
files, state store, malware policy, backups, rollback, and runtime operations.
If public certificates are operationally unsuitable, follow the
[Private HTTPS guide](docs/en-US/private-https.md); never disable verification.
