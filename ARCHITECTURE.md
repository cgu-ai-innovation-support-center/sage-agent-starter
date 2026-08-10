# Architecture

SAGE Agent Starter contains two equivalent application servers and one
optional HTTPS edge. A deployment selects either Node or FastAPI; it never runs
both for one Agent endpoint.

```text
SAGE Chat broker
  |  HTTPS + per-run invocation/model/Artifact capabilities
  v
Caddy private HTTPS edge (optional Starter deployment kit)
  |  loopback/container-network HTTP
  v
Node server OR FastAPI server
  |-- reads fixed agent/profile.json + agent/instructions.md
  |-- stores conversation-scoped response mappings in SQLite
  `-- calls the exact SAGE model-proxy lease URL
```

## Ownership boundaries

- **SAGE** owns user authorization, Groups, Budget enforcement, canonical chat
  history, lease minting, safe egress, and endpoint trust registration.
- **The Agent application** owns instructions, tools, application data,
  continuation mappings, request bounds, cancellation, and provider stream
  normalization.
- **The Agent operator** owns its host, endpoint reachability, invocation
  credential, persistent state, TLS private material, backup, patching,
  monitoring, and rollback.
- **The Starter HTTPS kit** owns only TLS termination for the selected Agent.
  Its private CA is not a network tunnel and does not authorize loopback,
  private, link-local, metadata, or other protected destinations.

## Runtime paths

Both servers validate the same `stateful-v1` request, resolve the prior
provider response only within the immutable SAGE conversation ID, and build a
provider request with these independent top-level fields:

- `model`: the operator-selected SAGE model alias;
- `instructions`: the bounded fixed-path contents of
  `agent/instructions.md`;
- `input`: SAGE's unchanged newest input or complete approval-result set;
- `previous_response_id`: only the conversation-scoped provider mapping;
- `stream: true`.

Instructions never replace, prepend to, or otherwise mutate `input`. A
terminal completion is withheld until its response mapping is durably stored.
Failure, incomplete, early `[DONE]`, malformed, or missing terminal streams do
not advance continuation state.

## State and scale

SQLite is persistent and restart-safe for one host. The database and WAL state
live on the selected persistent volume. Multi-host deployment requires one
shared state adapter with equivalent constraints; memory fallback is forbidden.

## Private HTTPS

The optional Caddy sidecar uses its internal issuer to maintain a server leaf
certificate. The CA and leaf lifecycle persist under `data/https/caddy-data`.
Only the public CA certificate and canonical Base URL are exported in
`sage-agent-trust.json`; the CA private key and server keys remain on the host.
SAGE must apply that CA only to the matching Agent endpoint while retaining
normal certificate name verification and safe-egress controls.

## Verification layers

- `npm run test:light` validates tracked harness, exposure rules, shared
  golden cases, and dependency-free unit tests. Maintainer PR CI runs this.
- `npm run test:full` additionally builds and starts both application images,
  probes their HTTP health/readiness endpoints, and proves a private-CA TLS
  handshake through the pinned Caddy image.
- `npm run release:verify` requires a clean annotated release tag and invokes
  the full local gate. It is not a deployment command.
