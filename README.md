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

## Fastest local check

```bash
npm run doctor
npm test
```

If your system `python3` is older but Python 3.12 is installed separately, set
`PYTHON=/path/to/python3.12` for both commands.

`npm test` is the release gate while GitHub-hosted automation is intentionally
disabled. It validates the compatibility manifest, checks release source for
known credential-shaped and private-IPv4 literals, and runs the dependency-free
Node and Python contract/state tests.

Maintainers run `npm run release:verify` after creating an annotated release
tag. It rejects a dirty worktree, a lightweight tag, or a tag that does not
resolve to the current commit.

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

## Supported and intentionally unsupported

Supported in v0.1:

- Responses-compatible `stateful-v1` ordinary and approval turns.
- Exact `previous_response_not_found` continuation-loss behavior.
- Run-scoped `platform_proxy_v1` model access.
- Run-scoped private image Artifact upload lease validation.
- Restart-safe, conversation-scoped local SQLite state.
- Health/readiness endpoints, bounded requests/streams, container builds, and
  secret-safe operational logs.

Not included:

- Reading SAGE's canonical conversation transcript.
- SAGE deployment, registration automation, or production hosting.
- A direct LiteLLM key, provider key, or private-network fallback.
- LangGraph, Agents SDK, or domain-specific teaching prompts. Add those only
  after the base contract remains green.

## Security and support

Read [SECURITY.md](SECURITY.md) before publishing an endpoint. Public Agents
remain subject to SAGE HTTPS and safe-egress checks. The Agent owns its tools,
files, state store, malware policy, backups, rollback, and runtime operations.
