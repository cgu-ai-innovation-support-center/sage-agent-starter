# Private HTTPS without a public certificate

You do not need a SAGE-owned domain or a publicly trusted certificate. The
Starter can run a pinned Caddy sidecar that creates one private CA for this
Agent, renews its server leaf certificate automatically, and exports only the
public trust needed by SAGE.

This is for an endpoint that is already reachable from SAGE. Private HTTPS
authenticates and encrypts that route; it does not create a tunnel, traverse
NAT, or authorize a private-network destination. Campus-private routing still
requires an exact platform-operator connectivity profile.

## One-time setup

Prepare `.env` first. Choose either the Node or FastAPI application and use the
exact public Base URL that will be entered in SAGE. A stable public IP is fine;
no domain is required.

```bash
# Node example. 8443 avoids requiring a privileged port in the container.
npm run https:setup -- \
  --base-url https://agent.example.edu:8443 \
  --profile node \
  --start

# Or use --profile fastapi.
npm run https:doctor
```

`--start` builds the selected application, starts Caddy, persists its CA under
ignored `data/https/`, and writes `sage-agent-trust.json`. Without `--start`,
the setup command prints the exact Compose command; then run
`npm run https:export` yourself.

The data path must be new or an existing Starter-created directory with its
private-HTTPS marker and only the `caddy-data`/`caddy-config` top-level layout.
Setup refuses `.`, the repository, home/system directories, symlinks, and
pre-existing general-purpose directories; it never repurposes or chmods them.

Upload only `sage-agent-trust.json` in the SAGE Agent editor. It contains
exactly:

```json
{
  "schema": "sage-agent-trust-v1",
  "base_url": "https://agent.example.edu:8443",
  "ca_pem": "-----BEGIN CERTIFICATE-----\n(public CA only)\n-----END CERTIFICATE-----\n"
}
```

Never upload or copy `data/https`, `root.key`, another `.key`, `.p12`, or
`.pfx` file. The public trust JSON is not a private key.

## What the doctor proves

`https:doctor` fails unless:

- the trust JSON has the exact schema, canonical Base URL, and one self-signed
  CA certificate of at most 16 KiB;
- the Caddy data tree has no symlinks and private key files are owned by root
  or the setup user without group/world access;
- a normal certificate-verifying TLS handshake succeeds for the Base URL,
  including hostname or IP SAN verification; and
- the proxied `/readyz` endpoint returns HTTP 204.

It does not prove that SAGE's network can reach the host. Use the SAGE
**Test secure connection** action before enabling the Agent.

## Rotation, backup, and recovery

Caddy's internal issuer renews leaf certificates automatically. SAGE trusts
the per-Agent CA, so ordinary leaf renewal requires no teacher action. Preserve
`data/https/caddy-data` across restarts and include it in a protected backup;
it contains the CA private key and must never enter Git, chat, or SAGE.

This Starter and SAGE MVP accept one CA at a time; they do not provide an
old/new trust overlap. If the CA is lost or intentionally replaced, use a short
maintenance window: record every Group availability, set them all Inactive,
set the global Agent Inactive, replace the Agent-side CA, export the new public
trust, and replace it in SAGE while the Agent remains Inactive. Require both
the local doctor and SAGE secure-connection check to pass before restoring only
the exact pilot; restore the other recorded Group states only after its smoke
test. Keep the old private material offline only for the bounded rollback
window, then retire it. A host restore that loses the CA is a trust rotation,
never an instruction to disable certificate verification or trust the
currently presented leaf.

The sidecar runs with a generated non-root numeric UID/GID (never UID 0),
listens on unprivileged container port 8443, and drops every Linux capability.
The official image marks its binary with a file capability, so a fixed tracked
runner first copies that digest-pinned binary into a bounded executable tmpfs;
the copy carries no file capability. The sidecar otherwise uses a read-only
root filesystem and writes only its bind-mounted data/config and that tmpfs.
Its configuration never binds a privileged container port. The Docker daemon
maps the selected host port to container port 8443.

Use a distinct generated data directory for every Agent; never share one CA
private key across Agent registrations.
