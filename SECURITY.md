# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, exposed credential,
private endpoint, or user data. Use GitHub's private vulnerability reporting
for this repository. Include the affected release, a minimal reproduction, and
impact without including a usable secret or real student record.

The repository has one maintainer. Receipt and remediation timing cannot be
guaranteed. Revoke any exposed credential immediately; do not wait for a code
change.

## Supported versions

Only the release tag and exact commit pinned by the current CGU SAGE
compatibility lock are supported. The moving `main` branch and downstream
forks are not production support commitments.

## Runtime boundary

- Keep `AGENT_INVOCATION_KEY` only in a server-side secret store.
- Keep SAGE model and Artifact leases in memory for the current request only.
- Never log authorization headers, request bodies, prompts, lease objects,
  uploaded content, or provider responses.
- Do not add a direct model-key or private-network fallback.
- Terminate public traffic with HTTPS and retain SAGE's safe-egress checks.
- Patch the runtime, dependencies, base images, reverse proxy, and host under
  the Agent operator's own maintenance process.
