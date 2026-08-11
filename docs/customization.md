# Safe customization boundary

For the minimal course tutor, change only files under `agent/`. Run:

```bash
npm run customization:check
npm run test:light
```

`customization:check` compares the working tree with a selected Git base and
fails if ordinary customization touched a review-required path. Use
`--base <ref>` when the intended base is not the current release tag.

Changing `node/`, `fastapi/`, `contracts/`, `deploy/`, `scripts/`, Compose,
security policy, dependencies, or test gates changes reviewed runtime or
security behavior. Such a change is possible for maintainers, but it is not an
ordinary prompt edit: update Node/FastAPI parity, tests, architecture/docs, and
run the full local gate.

Before adding a tool, file input, RAG source, network call, or write action,
document:

1. the exact learning need and expected output;
2. data source, owner, sensitivity, retention, and deletion;
3. authorization and user approval boundary;
4. network destinations and credential custody;
5. bounded timeout, size, cost, and failure behavior;
6. acceptance and misuse tests.

The included tutor deliberately has no files, RAG, external data, or real
domain tool. The exact `SAGE_APPROVAL_DEMO` runtime path is fixed validation
infrastructure with `effect: none`; do not turn it into a real action inside
the safe customization seam.
