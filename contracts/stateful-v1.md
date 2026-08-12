# SAGE Responses profile: `stateful-v1`

Contract revision: `2026-08-12`

This file is the public Agent-author contract for Starter release `v0.1.6`.
The SAGE platform remains authoritative for authorization, Budgets, safe
egress, canonical transcripts, and runtime enforcement.

## Request

SAGE sends `POST /v1/responses` with:

- `Authorization: Bearer <Agent invocation credential>`.
- `X-Sage-Responses-Profile: stateful-v1`.
- `X-Sage-Conversation-Id: <UUID>` as the immutable Agent state scope.
- `model: "agent"` and `stream: true`.
- Exactly one newest user input for an ordinary turn, never full history.
- `previous_response_id` after the first successful turn.
- For an approval continuation, the complete unique pending-to-responded set
  of structurally bounded `mcp_approval_response` items and a previous ID.
- A short-lived `model_access` lease with mode `platform_proxy_v1`.
- A short-lived `artifact_access` lease for private image uploads.

The Agent must reject unknown fields, malformed scopes, expired or malformed
leases, ordinary full history, duplicate approval IDs, and approval responses
without a previous ID.

## State and continuation

The conversation UUID scopes Agent-owned state; it is not user identity and
must not be forwarded to a model provider. A previous response ID must resolve
inside the same conversation. Keep an ordinary response head for at least 30
days from creation and a pending action checkpoint for at least 7 days.

State must survive process restart and every instance serving the endpoint
must share the same durable backend. The included SQLite adapter is suitable
for local development and one host with a shared persistent volume. Replace it
with an equivalently strict managed database adapter before multi-host use.

If a supplied previous ID cannot be resolved, or the provider returns the
exact standardized continuation-loss code, return HTTP 409:

```json
{"error":{"code":"previous_response_not_found","message":"The Agent cannot continue from that response ID."}}
```

Do not accept or reconstruct a full-history fallback.

## Model access

The model lease contains only an HTTPS SAGE proxy base URL, an opaque `mp1.*`
token, and an expiry. It is minted after the exact run and Budget are
authorized. Keep it in memory for that request, use only its `models`,
`responses`, or `chat/completions` surface, and never persist, log, delegate,
or reuse it for background work. The Agent never receives the underlying
Virtual Key or provider key. Require the proxy and Artifact lease URLs to match
the exact operator-configured SAGE HTTPS origin before sending either token.

The Agent may send its fixed local behavior text as the provider request's
top-level `instructions`. It must forward SAGE's validated newest `input`
unchanged rather than prepending instructions, reconstructing history, or
changing the approval-result set.

## Artifacts and tools

The Artifact lease is a request-local `af1.*` capability for the exact SAGE
upload endpoint and bounded PNG, JPEG, or WebP bytes. Uploading returns a
platform `file_id`; never expose the lease or upload URL as output.

The Agent executes its own functions and tools. SAGE may display bounded
reasoning summaries and MCP approval/result lifecycle events, but the browser
does not execute a returned function. External files may be exposed only as
credential-free HTTPS `sage.artifact.link` events without userinfo, query, or
fragment components, and remain untrusted links.

The two templates include one exact `SAGE_APPROVAL_DEMO` validation path. It
creates a fixed `effect: "none"` pending action, persists it before releasing
the terminal response, requires the complete ordered decision set, consumes
it once, and returns a local preview result without network, file, or data
mutation. It is a protocol rehearsal, not a general tool executor. A denied
decision executes nothing. Approval reasons are not persisted by the demo.

## Response and errors

Return a bounded `text/event-stream` using OpenAI Responses event shapes.
Unknown provider errors become generic 502 responses. Do not relay provider
error bodies, secrets, request bodies, prompts, or internal network details.
Cancellation closes the upstream request. Withhold the terminal
`response.completed` frame until its conversation-scoped continuation mapping
has been committed durably; a persistence failure closes an incomplete stream
without releasing that frame. A provider `[DONE]`, failure, incomplete, or
error terminal observed before `response.completed` is irreversible and must
never be followed by a persisted completion. Replace provider-supplied SSE
failure, incomplete, and error frames with one fixed generic `response.failed`
event so their fields cannot disclose upstream details.
