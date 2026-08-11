# Third-party components

The Node template uses only Node.js standard-library APIs. The FastAPI
template pins the following direct and transitive packages in
`fastapi/requirements.txt`. Every resolved artifact has a SHA-256 hash and the
container install uses `--require-hashes`. License identifiers come from the
installed wheel metadata reviewed for the v0.1.4 build; FastAPI declares MIT
through its package classifier.

| Package | License |
| --- | --- |
| annotated-doc | MIT |
| annotated-types | MIT |
| anyio | MIT |
| certifi | MPL-2.0 |
| click | BSD-3-Clause |
| fastapi | MIT |
| h11 | MIT |
| httpcore | BSD-3-Clause |
| httpx | BSD-3-Clause |
| idna | BSD-3-Clause |
| pydantic | MIT |
| pydantic-core | MIT |
| starlette | BSD-3-Clause |
| typing-extensions | PSF-2.0 |
| typing-inspection | MIT |
| uvicorn | BSD-3-Clause |

The optional HTTPS profile uses the official Caddy `2.10.2-alpine`
multi-platform OCI index pinned at
`sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`.
Caddy is licensed under Apache-2.0. The official image also contains Alpine
components governed by their respective package licenses. Re-review the image,
SBOM, advisories, and license material before changing its tag or digest.

Re-resolve the complete dependency set and re-review its metadata, licenses,
and vulnerabilities before each release.

`fastapi/requirements.txt` is fully version-resolved and hash-locked from the
public package index for Python 3.12. Regenerate it from `requirements.in`,
review the complete diff and licenses, run the vulnerability audit, and build
every supported container architecture before changing a dependency.

The Dockerfiles and Caddy sidecar pin official multi-platform image digests. A
digest makes the selected image reproducible; it does not mean the image is
free of vulnerabilities. Re-review and intentionally update each tag and
digest for every Starter release.

No code from the OpenAI Agents SDK, LangGraph, SAGE's private dependencies, or
the Dify submodule is redistributed in this repository.
