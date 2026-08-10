# Code reference

## Shared behavior seam

| Path | Responsibility | Ordinary teacher change? |
| --- | --- | --- |
| `agent/profile.json` | Bounded profile identity and fixed instructions filename | Yes |
| `agent/instructions.md` | Top-level model instructions used by both runtimes | Yes |
| `agent/requirements.md` | Human-readable learning requirement | Yes |
| `agent/acceptance.md` | Manual acceptance prompts and expected behavior | Yes |

The runtime reads exactly `agent/profile.json`; its `instructions_file` must be
exactly `instructions.md`. It does not accept an environment-provided path,
absolute path, parent traversal, symlink, or arbitrary runtime module.

## Node template

| Path | Responsibility |
| --- | --- |
| `node/server.mjs` | HTTP auth, bounded requests, SAGE lease use, streaming, cancellation, and health |
| `node/agent-profile.mjs` | Fixed-path profile/instructions loading and bounds |
| `node/provider-request.mjs` | Builds the unchanged `stateful-v1` provider request plus top-level instructions |
| `node/contract.mjs` | Exact public request and capability validation |
| `node/state-store.mjs` | SQLite response mapping and durable terminal stream gate |
| `node/showcase.mjs` | Platform-owned deterministic E2E fixture; not a teacher behavior seam |

## FastAPI template

| Path | Responsibility |
| --- | --- |
| `fastapi/app.py` | FastAPI equivalent of the Node HTTP runtime |
| `fastapi/agent_profile.py` | Fixed-path profile/instructions loading and bounds |
| `fastapi/provider_request.py` | Provider payload parity with Node |
| `fastapi/contract.py` | Exact public request and capability validation |
| `fastapi/state_store.py` | SQLite response mapping and durable terminal stream gate |

## HTTPS and deployment

| Path | Responsibility |
| --- | --- |
| `compose.yaml` | Hardened Node/FastAPI HTTP profiles and optional Caddy HTTPS profiles |
| `deploy/https/Caddyfile` | Internal private-CA TLS termination and reverse proxy |
| `deploy/https/run-caddy-unprivileged.sh` | Removes the official binary file capability by copying it into bounded tmpfs before capability-free execution |
| `scripts/https-kit.mjs` | Setup, public trust export, and verified TLS doctor |
| `harness/customization-policy.json` | Machine-readable safe/review-required path boundary |

## Tests and gates

Node and Python unit tests consume the same golden provider request under
`tests/golden/`. The lightweight validator checks docs, manifests, policy,
secret-shaped content, pinned actions/images, and all unit cases. The full
smoke creates isolated Docker resources, never depends on GitHub Actions, and
removes only the exact resources it created.
