# Agent Notes

This file is the routing index for coding assistants working in this Starter.
Keep protocol and security decisions in the linked documents instead of
expanding this index.

## Start here

- Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for runtime ownership and data flow.
- Read [`docs/code-reference.md`](docs/code-reference.md) before changing code.
- Read [`docs/customization.md`](docs/customization.md) before changing Agent
  behavior.
- Read [`SECURITY.md`](SECURITY.md) before deployment, TLS, credential, file,
  tool, or network work.

## Task routing

| Task | Read first | Boundary |
| --- | --- | --- |
| Change the example tutor's behavior | [`agent/requirements.md`](agent/requirements.md), [`agent/instructions.md`](agent/instructions.md), [`agent/acceptance.md`](agent/acceptance.md) | Stay inside `agent/` unless the requirement truly changes runtime or protocol behavior. |
| Choose Node or FastAPI | [`docs/code-reference.md`](docs/code-reference.md) | Both implementations must keep the same `stateful-v1` request behavior and top-level `instructions`. Do not create a third server. |
| Change SAGE request or response handling | [`contracts/stateful-v1.md`](contracts/stateful-v1.md), [`docs/code-reference.md`](docs/code-reference.md) | Protocol, state, leases, error normalization, and security controls are review-required. Preserve Node/FastAPI parity. |
| Add real tools, files, RAG, or external data | [`SECURITY.md`](SECURITY.md), [`docs/customization.md`](docs/customization.md) | The minimal example has only a fixed no-side-effect approval rehearsal. Define approval, data, retention, and failure behavior before adding a real tool. |
| Configure private HTTPS | [`docs/zh-TW/private-https.md`](docs/zh-TW/private-https.md) or [`docs/en-US/private-https.md`](docs/en-US/private-https.md) | Upload only the generated public trust JSON. Private keys stay on the Agent host. TLS trust never grants private-network reachability. |
| Validate a teacher customization | [`harness/customization-policy.json`](harness/customization-policy.json) | Run `npm run customization:check`, then the local tests named in the guide. |
| Prepare a maintained release | [`CONTRIBUTING.md`](CONTRIBUTING.md) | Run the full local gate. GitHub Actions is a maintainer sensor, not a teacher deployment requirement. |

## Invariants

- Never add a full-history, direct model-key, disabled-TLS-verification,
  credential, or private-network fallback.
- Never log request bodies, prompts, leases, provider responses, credentials,
  private keys, or student data.
- Keep `agent/profile.json` and `agent/instructions.md` as the only default
  behavior customization seam shared by Node and FastAPI.
- Treat paths marked `review_required` in
  [`harness/customization-policy.json`](harness/customization-policy.json) as
  frozen for ordinary teacher customization.
- Run `npm run test:full` after runtime, container, TLS, or protocol changes.
