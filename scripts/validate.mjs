#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const requiredFiles = [
  ".env.example",
  ".dockerignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "compatibility.json",
  "compose.yaml",
  "contracts/stateful-v1.md",
  "docs/en-US/deployment.md",
  "docs/en-US/quickstart.md",
  "docs/zh-TW/deployment.md",
  "docs/zh-TW/quickstart.md",
  "fastapi/Dockerfile",
  "fastapi/app.py",
  "fastapi/contract.py",
  "fastapi/state_store.py",
  "fastapi/requirements.in",
  "node/Dockerfile",
  "node/contract.mjs",
  "node/server.mjs",
  "node/state-store.mjs",
  "scripts/verify-release.mjs",
  "THIRD_PARTY.md",
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

for (const path of requiredFiles) {
  readFileSync(new URL(path, root));
}

const manifest = JSON.parse(readFileSync(new URL("compatibility.json", root), "utf8"));
requireCondition(manifest.schema_version === 1, "unsupported compatibility schema");
requireCondition(manifest.starter.release_tag === `v${manifest.starter.version}`, "release tag/version mismatch");
requireCondition(manifest.sage.profile === "stateful-v1", "unexpected SAGE profile");
requireCondition(/^[0-9a-f]{40}$/.test(manifest.sage.baseline_commit), "invalid SAGE baseline commit");
const contract = readFileSync(new URL(manifest.sage.contract_file, root));
const digest = `sha256:${createHash("sha256").update(contract).digest("hex")}`;
requireCondition(manifest.sage.contract_sha256 === digest, "contract digest mismatch");
requireCondition(new Set(manifest.templates.map(({ id }) => id)).size === 2, "template IDs must be unique");

for (const locale of ["zh-TW", "en-US"]) {
  const quickstart = readFileSync(new URL(`docs/${locale}/quickstart.md`, root), "utf8");
  requireCondition(quickstart.includes("Codex / Claude Code"), `${locale} quickstart must use the approved assistant wording`);
  for (const heading of ["## 1.", "## 2.", "## 3.", "## 4.", "## 5."]) {
    requireCondition(quickstart.includes(heading), `${locale} quickstart is missing ${heading}`);
  }
}

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "buffer",
});
requireCondition(listed.status === 0, "could not list repository files");
const paths = listed.stdout.toString("utf8").split("\0").filter(Boolean);
requireCondition(!paths.some((path) => path === ".env" || path.endsWith("/.env")), "a runtime .env file is tracked");
requireCondition(!paths.some((path) => path.startsWith(".github/workflows/")), "GitHub Actions are intentionally out of the v0.1 release gate");

const privateIpv4 = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;
const secretShape = /\b(?:sk-|mp1\.|af1\.)[A-Za-z0-9_-]{24,}\b/g;
for (const path of paths) {
  if (path.startsWith(".git/") || /\.(?:png|jpg|jpeg|webp)$/i.test(path)) continue;
  const text = readFileSync(new URL(path, root), "utf8");
  requireCondition(!privateIpv4.test(text), `${path} contains a private IPv4 address`);
  privateIpv4.lastIndex = 0;
  for (const match of text.matchAll(secretShape)) {
    const body = match[0].replace(/^(?:sk-|mp1\.|af1\.)/, "");
    requireCondition(new Set(body).size <= 3, `${path} contains a credential-shaped high-entropy value`);
  }
}

for (const [label, command, args] of [
  ["Node tests", process.execPath, ["--test", "tests/node/contract.test.mjs", "tests/node/state-store.test.mjs"]],
  ["Python tests", process.env.PYTHON?.trim() || "python3", ["-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py"]],
]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  requireCondition(result.status === 0, `${label} failed`);
}

process.stdout.write(`Validated ${paths.length} source files for Starter ${manifest.starter.version}.\n`);
