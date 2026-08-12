#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const full = process.argv.slice(2).includes("--full");
const pythonCommand = process.env.PYTHON?.trim() || "python3";
if (process.argv.slice(2).some((argument) => argument !== "--full")) {
  throw new Error("usage: validate.mjs [--full]");
}

const requiredFiles = [
  ".dockerignore",
  ".env.example",
  ".github/workflows/maintainer-ci.yml",
  ".gitignore",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY.md",
  "agent/acceptance.md",
  "agent/instructions.md",
  "agent/profile.json",
  "agent/requirements.md",
  "compatibility.json",
  "compose.yaml",
  "contracts/stateful-v1.md",
  "deploy/https/Caddyfile",
  "deploy/https/run-caddy-unprivileged.sh",
  "docs/code-reference.md",
  "docs/customization.md",
  "docs/en-US/deployment.md",
  "docs/en-US/private-https.md",
  "docs/en-US/quickstart.md",
  "docs/zh-TW/deployment.md",
  "docs/zh-TW/private-https.md",
  "docs/zh-TW/quickstart.md",
  "fastapi/Dockerfile",
  "fastapi/agent_profile.py",
  "fastapi/approval_demo.py",
  "fastapi/app.py",
  "fastapi/contract.py",
  "fastapi/provider_request.py",
  "fastapi/requirements.in",
  "fastapi/requirements.txt",
  "fastapi/state_store.py",
  "harness/customization-policy.json",
  "node/Dockerfile",
  "node/agent-profile.mjs",
  "node/approval-demo.mjs",
  "node/contract.mjs",
  "node/provider-request.mjs",
  "node/server.mjs",
  "node/state-store.mjs",
  "package.json",
  "scripts/check-customization.mjs",
  "scripts/doctor.mjs",
  "scripts/https-kit.mjs",
  "scripts/run-python-tests.mjs",
  "scripts/source-revision.mjs",
  "scripts/smoke-containers.mjs",
  "scripts/verify-release.mjs",
  "tests/golden/provider-request.json",
  "tests/node/agent-profile.test.mjs",
  "tests/node/approval-demo.test.mjs",
  "tests/node/contract.test.mjs",
  "tests/node/doctor.test.mjs",
  "tests/node/https-kit.test.mjs",
  "tests/node/source-revision.test.mjs",
  "tests/node/state-store.test.mjs",
  "tests/python/test_agent_profile.py",
  "tests/python/test_approval_demo.py",
  "tests/python/test_contract.py",
  "tests/python/test_state_store.py",
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const pythonVersion = spawnSync(pythonCommand, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"], {
  cwd: root,
  encoding: "utf8",
});
requireCondition(pythonVersion.status === 0, `${pythonCommand} is unavailable`);
const [pythonMajor, pythonMinor] = pythonVersion.stdout.trim().split(".").map(Number);
requireCondition(
  pythonMajor > 3 || (pythonMajor === 3 && pythonMinor >= 12),
  `Python 3.12 or newer is required; ${pythonCommand} reported ${pythonVersion.stdout.trim() || "an unknown version"}`,
);

for (const path of requiredFiles) readFileSync(new URL(path, root));

const manifest = JSON.parse(readFileSync(new URL("compatibility.json", root), "utf8"));
requireCondition(manifest.schema_version === 1, "unsupported compatibility schema");
requireCondition(manifest.starter.release_tag === `v${manifest.starter.version}`, "release tag/version mismatch");
requireCondition(manifest.sage.profile === "stateful-v1", "unexpected SAGE profile");
requireCondition(/^[0-9a-f]{40}$/.test(manifest.sage.baseline_commit), "invalid SAGE baseline commit");
const contract = readFileSync(new URL(manifest.sage.contract_file, root));
const digest = `sha256:${createHash("sha256").update(contract).digest("hex")}`;
requireCondition(manifest.sage.contract_sha256 === digest, "contract digest mismatch");
requireCondition(
  JSON.stringify(manifest.templates.map(({ id }) => id).sort()) === JSON.stringify(["fastapi", "node"]),
  "exactly the Node and FastAPI templates must be declared",
);

const policy = JSON.parse(readFileSync(new URL("harness/customization-policy.json", root), "utf8"));
requireCondition(policy.schema === "sage-starter-customization-policy-v1", "unsupported customization policy");
for (const key of ["safe_customization_paths", "review_required_prefixes", "review_required_paths"]) {
  requireCondition(Array.isArray(policy[key]) && policy[key].length > 0, `customization policy ${key} must be non-empty`);
  requireCondition(new Set(policy[key]).size === policy[key].length, `customization policy ${key} contains duplicates`);
}
for (const path of policy.safe_customization_paths) {
  requireCondition(path.startsWith("agent/") && !path.includes(".."), `unsafe customization path: ${path}`);
  readFileSync(new URL(path, root));
}
for (const prefix of policy.review_required_prefixes) {
  requireCondition(prefix.endsWith("/") && !prefix.startsWith("agent/"), `invalid review-required prefix: ${prefix}`);
}

for (const locale of ["zh-TW", "en-US"]) {
  const quickstart = readFileSync(new URL(`docs/${locale}/quickstart.md`, root), "utf8");
  requireCondition(quickstart.includes("Codex / Claude Code"), `${locale} quickstart must use the approved assistant wording`);
  for (const heading of ["## 1.", "## 2.", "## 3.", "## 4.", "## 5."]) {
    requireCondition(quickstart.includes(heading), `${locale} quickstart is missing ${heading}`);
  }
  requireCondition(quickstart.includes("SAGE_APPROVAL_DEMO"), `${locale} quickstart must include the durable approval rehearsal`);
  const privateHttps = readFileSync(new URL(`docs/${locale}/private-https.md`, root), "utf8");
  requireCondition(privateHttps.includes("sage-agent-trust.json"), `${locale} private HTTPS guide must name the public trust file`);
  requireCondition(privateHttps.includes("private-network") || privateHttps.includes("私有網路"), `${locale} private HTTPS guide must separate TLS trust from routing`);
}

const workflow = readFileSync(new URL(".github/workflows/maintainer-ci.yml", root), "utf8");
const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
requireCondition(uses.length === 3 && uses.every((value) => /@[0-9a-f]{40}$/.test(value)), "every GitHub Action must be SHA-pinned");
requireCondition(workflow.includes("npm run test:light"), "maintainer CI must own the lightweight gate");
requireCondition(
  workflow.includes("if: github.repository == 'cgu-ai-innovation-support-center/sage-agent-starter' && github.event.pull_request.head.repo.full_name == github.repository"),
  "maintainer CI must run only for same-repository PRs in the canonical repository",
);
requireCondition(!workflow.includes("secrets."), "maintainer lightweight CI must not use secrets");
requireCondition(workflow.includes("contents: read"), "maintainer CI must use read-only repository permissions");

const compose = readFileSync(new URL("compose.yaml", root), "utf8");
const caddyReference = "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
requireCondition(compose.match(new RegExp(caddyReference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length === 2, "both HTTPS profiles must use the reviewed Caddy digest");
requireCondition(compose.includes("/caddy-data:/data") && compose.includes("/caddy-config:/config"), "Caddy state must use persistent bind mounts");
requireCondition(!compose.includes("cap_add:") && !compose.includes("NET_BIND_SERVICE"), "every Starter container must run without added Linux capabilities");
requireCondition(compose.match(/user: "\$\{SAGE_AGENT_HTTPS_UID:-1000\}:\$\{SAGE_AGENT_HTTPS_GID:-1000\}"/gu)?.length === 2, "both Caddy sidecars must use the generated non-root identity");
const pythonRequirements = readFileSync(new URL("fastapi/requirements.txt", root), "utf8");
const requirementStarts = [...pythonRequirements.matchAll(/^([a-z0-9-]+)==[^\n]+$/gmu)];
requireCondition(requirementStarts.length >= 10, "Python lock must contain the resolved dependency set");
for (const [index, match] of requirementStarts.entries()) {
  const start = match.index ?? 0;
  const end = requirementStarts[index + 1]?.index ?? pythonRequirements.length;
  requireCondition(
    pythonRequirements.slice(start, end).includes("--hash=sha256:"),
    `Python lock is missing artifact hashes for ${match[1]}`,
  );
}
const fastapiDockerfile = readFileSync(new URL("fastapi/Dockerfile", root), "utf8");
requireCondition(fastapiDockerfile.includes("--require-hashes -r requirements.txt"), "FastAPI image must enforce the Python artifact hash lock");
for (const [name, dockerfile] of [
  ["Node", readFileSync(new URL("node/Dockerfile", root), "utf8")],
  ["FastAPI", fastapiDockerfile],
]) {
  requireCondition(
    dockerfile.includes("ARG SAGE_AGENT_SOURCE_REVISION"),
    `${name} image must require the source revision build argument`,
  );
  requireCondition(
    dockerfile.includes('LABEL org.opencontainers.image.revision="${SAGE_AGENT_SOURCE_REVISION}"'),
    `${name} image must carry the standard OCI source revision label`,
  );
  requireCondition(
    dockerfile.includes("0000000000000000000000000000000000000000") &&
      dockerfile.includes("${#SAGE_AGENT_SOURCE_REVISION}") &&
      dockerfile.includes("*[!0-9a-f]*"),
    `${name} image must reject an empty, all-zero, or non-40-hex revision`,
  );
}
requireCondition(
  compose.match(/SAGE_AGENT_SOURCE_REVISION: \$\{SAGE_AGENT_SOURCE_REVISION:-\}/gu)?.length === 2,
  "both application Compose builds must pass a lifecycle-safe optional source revision",
);
const caddyfile = readFileSync(new URL("deploy/https/Caddyfile", root), "utf8");
requireCondition(caddyfile.includes("tls internal") && !caddyfile.includes("tls_insecure"), "Caddy must issue private-CA TLS without an insecure transport bypass");
const caddyRunner = readFileSync(new URL("deploy/https/run-caddy-unprivileged.sh", root), "utf8");
requireCondition(caddyRunner.includes("cp /usr/bin/caddy /tmp/caddy-unprivileged") && caddyRunner.includes("exec /tmp/caddy-unprivileged run"), "Caddy must discard the official binary file capability before running");

const releaseVerifier = readFileSync(new URL("scripts/verify-release.mjs", root), "utf8");
requireCondition(releaseVerifier.includes('"--full"'), "release verification must invoke the full local gate");
const httpsKit = readFileSync(new URL("scripts/https-kit.mjs", root), "utf8");
requireCondition(
  httpsKit.includes("exactCleanSourceRevision(root)") &&
    httpsKit.includes("SAGE_AGENT_SOURCE_REVISION: sourceRevision"),
  "private HTTPS startup must inject the exact clean source revision into Compose",
);

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "buffer",
});
requireCondition(listed.status === 0, "could not list repository files");
const paths = listed.stdout.toString("utf8").split("\0").filter(Boolean);
const nodeTests = paths.filter((path) => /^tests\/node\/[^/]+\.test\.mjs$/u.test(path)).sort();
requireCondition(nodeTests.length > 0, "at least one owned Node test is required");
requireCondition(
  paths.filter((path) => path.startsWith("tests/node/")).every((path) => nodeTests.includes(path)),
  "every Node test file must use the maintained *.test.mjs boundary",
);
requireCondition(
  !paths.some((path) => {
    const basename = path.split("/").at(-1);
    return basename?.startsWith(".env") && basename !== ".env.example";
  }),
  "a runtime .env variant is tracked",
);
requireCondition(
  paths.filter((path) => path.startsWith(".github/workflows/")).every((path) => path === ".github/workflows/maintainer-ci.yml"),
  "only the maintainer lightweight workflow is allowed",
);
requireCondition(!paths.some((path) => path === "sage-agent-trust.json" || path.startsWith("data/https/")), "generated trust or private TLS material is tracked");

const privateIpv4 = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;
const secretShape = /\b(?:sk-|mp1\.|af1\.)[A-Za-z0-9_-]{24,}\b/g;
const quotedSecretAssignment = /\b[A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*\b\s*[:=]\s*["']([A-Za-z0-9_./+=-]{24,})["']/gi;
const envSecretAssignment = /^[A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*=([^\s#]{24,})$/gim;
for (const path of paths) {
  if (path.startsWith(".git/") || /\.(?:png|jpg|jpeg|webp)$/i.test(path)) continue;
  const text = readFileSync(new URL(path, root), "utf8");
  requireCondition(!privateIpv4.test(text), `${path} contains a private IPv4 address`);
  privateIpv4.lastIndex = 0;
  for (const match of text.matchAll(secretShape)) {
    const body = match[0].replace(/^(?:sk-|mp1\.|af1\.)/, "");
    requireCondition(new Set(body).size <= 3, `${path} contains a credential-shaped high-entropy value`);
  }
  for (const pattern of [quotedSecretAssignment, envSecretAssignment]) {
    for (const match of text.matchAll(pattern)) {
      const body = match[1];
      requireCondition(body.includes("replace-with") || new Set(body).size <= 6, `${path} contains a high-entropy credential assignment`);
    }
  }
}

for (const [label, command, args] of [
  ["Node tests", process.execPath, ["--test", ...nodeTests]],
  ["Python tests", pythonCommand, ["-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py"]],
]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  requireCondition(result.status === 0, `${label} failed`);
}

if (full) {
  const smoke = spawnSync(process.execPath, ["scripts/smoke-containers.mjs"], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  requireCondition(smoke.status === 0, "container and private HTTPS smoke failed");
}

process.stdout.write(`Validated ${paths.length} source files for Starter ${manifest.starter.version} (${full ? "full" : "lightweight"} gate).\n`);
