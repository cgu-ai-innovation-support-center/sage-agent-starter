# Deployment and rollback

The Starter does not deploy the service. The Agent operator owns runtime,
domain, TLS, state, secrets, monitoring, patching, and recovery.

## Container

```bash
docker build --pull -f node/Dockerfile -t my-sage-agent:v0.1.2 .
# or
docker build --pull -f fastapi/Dockerfile -t my-sage-agent:v0.1.2 .
```

Run as a non-root user, drop all capabilities, use a read-only filesystem, and
mount only `/data` as persistent storage. Inject secrets only through the
runtime secret store.

## HTTPS and network

Place a maintained HTTPS reverse proxy in front of the Agent. SAGE rejects
redirects and public endpoints resolving to loopback, private, link-local,
metadata, or otherwise unsafe addresses. Do not disable those protections. A
campus-private route requires a separate, exact, deployment-owned connectivity
profile configured by platform operators.

## State, backup, and scale

The SQLite adapter supports local development and a persistent shared volume
on one host. Use a WAL-aware consistent backup that protects the database and
its `-wal` and `-shm` state. Implement a shared database adapter before a
multi-host deployment; do not fall back to memory.

## Rollback

1. Retain the previous image digest and a compatible state backup.
2. Drain new traffic and stop the current container.
3. If the schema is unchanged, start the prior image. If it changed, follow
   that release's migration/restore runbook; do not guess at a downgrade.
4. Check `/readyz` and complete two turns in a new SAGE test conversation.
5. If old state cannot continue, return exact `previous_response_not_found`;
   never replay history.

## Credential rotation

Add the new invocation credential to the Agent secret store, replace it in the
SAGE Agent settings, run a smoke test, and then revoke the old value. Never use
the same value for the invocation credential and a model/provider key.
