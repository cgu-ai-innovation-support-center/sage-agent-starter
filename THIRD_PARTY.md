# Third-party components

The Node template uses only Node.js standard-library APIs. The FastAPI
template pins the following direct and transitive packages in
`fastapi/requirements.txt`. License identifiers come from the installed wheel
metadata for the v0.1.0 build; FastAPI declares MIT through its package
classifier.

| Package | License |
| --- | --- |
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

Re-resolve the complete dependency set and re-review its metadata, licenses,
and vulnerabilities before each release.

The Dockerfiles pin official Node and Python multi-platform image digests. A
digest makes the selected image reproducible; it does not mean the image is
free of vulnerabilities. Re-review and intentionally update the tag and digest
for every Starter release.

No code from the OpenAI Agents SDK, LangGraph, SAGE's private dependencies, or
the Dify submodule is redistributed in this repository.
