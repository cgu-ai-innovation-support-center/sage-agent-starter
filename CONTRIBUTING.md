# Contributing

This is a CGU-maintained, source-available repository. Version 0.1 does not
accept external pull requests or transfer contributor rights. Authorized CGU
maintainers may prepare changes in an organization-controlled branch and must
run `npm run test:full` before tagging a release. The SHA-pinned pull-request
workflow runs only `npm run test:light` as a maintainer sensor; it is not a
teacher deployment gate and must not be expanded with secrets or heavyweight
container checks. Its job guard is also false in copied or forked repositories,
so teachers do not consume Actions quota unless they intentionally replace that
policy for their own repository.

Ordinary tutor changes should stay in the four safe files declared by
`harness/customization-policy.json`. Run `npm run customization:check` against
the reviewed release base. Runtime, contract, security, TLS, dependency, or
harness changes require maintainer review and Node/FastAPI parity evidence.

Public issues may be used for non-sensitive documentation feedback. Security
reports must follow [SECURITY.md](SECURITY.md).

Do not contribute real endpoints, internal topology, credentials, student or
staff data, request logs, screenshots containing personal information, or code
whose redistribution rights are unclear.
