# 15-minute quickstart

This Starter lets you give a teaching requirement to **Codex / Claude Code**
and have the coding assistant work inside reviewed protocol and security
boundaries. You do not need to learn the complete API contract first.

## 1. Write a requirement brief

Describe:

1. Users and learning outcome.
2. Expected input and output.
3. External data or tools, including actions that require approval.
4. Sensitive data or files and their retention.
5. Model, traffic, Budget, and failure expectations.
6. The owner for deployment, monitoring, backup, credential rotation, and
   rollback.

Give the following prompt to your coding assistant:

```text
Read AGENTS.md, ARCHITECTURE.md, agent/requirements.md,
agent/acceptance.md, and SECURITY.md
first. Implement the requirement below in the most suitable Node or FastAPI
template by changing the fixed agent profile/instructions seam first. Do not
add a full-history, direct model-key, private-network, TLS-verification, or
credential fallback. Run npm run customization:check and npm run test:light
after the change. List deployment, data, and tool risks that still need human
review.

Requirement: <paste the brief>
```

## 2. Check the environment

Use Node.js 22.13 or newer and Python 3.12:

```bash
git clone --branch v0.1.7 --depth 1 https://github.com/cgu-ai-innovation-support-center/sage-agent-starter.git
cd sage-agent-starter
npm run doctor
npm run test:light
cp .env.example .env
```

Replace local placeholders in `.env`. Never commit that file or paste it into
a conversation. The invocation credential and model/provider credentials are
different secrets and must not be reused. Set `SAGE_PLATFORM_ORIGIN` to only
the public HTTPS origin of SAGE (for example `https://sage.example.edu`), with
no path. The Starter sends short-lived leases only back to that origin.
If you load `.env` and rerun doctor, a configured `AGENT_MODEL` remains a
warning: only a real SAGE run can verify that the selected Budget permits that
exact alias.

## 3. Choose a template

- Node keeps the HTTP implementation framework-free.
- FastAPI fits an existing Python service.

Both must pass the same contract tests. Framework choice does not change the
SAGE protocol.

The included [`minimal-course-tutor`](../../agent/requirements.md) is one
complete vertical slice: requirements, fixed-path instructions, profile, and
acceptance prompts. Start by editing only those `agent/` files.

## 4. Run locally

Node:

```bash
set -a; . ./.env; set +a
node node/server.mjs
```

FastAPI:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r fastapi/requirements.txt
set -a; . ./.env; set +a
uvicorn --app-dir fastapi app:app --host 127.0.0.1 --port 8080
```

Verify `/healthz` and `/readyz`. In a real deployment `AGENT_STATE_DB` must be
on persistent storage. Replace SQLite with a shared database adapter for a
multi-host deployment.

Alternatively, start one hardened Compose profile. Node binds to
`127.0.0.1:8080`; FastAPI binds to `127.0.0.1:8081`:

```bash
npm run compose:up -- --profile node
# or
npm run compose:up -- --profile fastapi
```

The maintained wrapper rejects a dirty source tree, isolates Git repository
selection, exports only the committed index into the Docker build context, and
stores that exact commit in the standard
`org.opencontainers.image.revision` label. Routine `docker compose ps`,
`logs`, `restart`, and `down` remain available without reconstructing build
metadata.

## 5. Before registration

1. Build one Dockerfile without putting secrets in an image layer.
2. Test health/readiness, timeout, and cancellation behind an HTTPS reverse
   proxy.
3. Include the state volume in backup/restore and rehearse rollback.
4. Create the Agent in SAGE with the HTTPS Base URL and a distinct invocation
   credential.
5. Select Responses API and platform model access.
6. In a new conversation send exact `SAGE_APPROVAL_DEMO`. Confirm its input is
   `effect: none`, restart the runtime before answering, approve once, verify
   the no-side-effect result and replay rejection, then test denial in another
   new conversation. This fixed rehearsal is not a real/domain tool.
7. Test first and second ordinary turns and cancellation.

If SAGE receives `previous_response_not_found`, start a new conversation. Do
not resend full history.

Before registration, run `npm run test:full` locally. It builds and starts both
reference images and verifies HTTP, restart-safe approval, backup/restore unit,
and private-CA TLS smoke. Teachers do not
need GitHub Actions or CI quota to run or deploy the Agent. If a public
certificate is inconvenient, use the [private HTTPS guide](private-https.md).
