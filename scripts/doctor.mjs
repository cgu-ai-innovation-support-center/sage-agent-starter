#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  validateExternalArtifactUrl,
  validatePlatformOrigin,
} from "../node/contract.mjs";

const failures = [];
const warnings = [];

function pass(message) {
  process.stdout.write(`PASS  ${message}\n`);
}

function fail(message) {
  failures.push(message);
  process.stdout.write(`FAIL  ${message}\n`);
}

function warn(message) {
  warnings.push(message);
  process.stdout.write(`WARN  ${message}\n`);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 13)) {
  pass(`Node ${process.versions.node}`);
} else {
  fail("Node 22.13 or newer is required");
}

const pythonCommand = process.env.PYTHON?.trim() || "python3";
const python = spawnSync(pythonCommand, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
  encoding: "utf8",
});
if (python.status === 0) {
  const version = python.stdout.trim();
  const [pythonMajor, pythonMinor] = version.split(".").map(Number);
  if (pythonMajor > 3 || (pythonMajor === 3 && pythonMinor >= 12)) {
    pass(`Python ${version}`);
  } else {
    fail("Python 3.12 or newer is required");
  }
} else {
  fail(`${pythonCommand} is unavailable`);
}

const manifest = JSON.parse(readFileSync(new URL("../compatibility.json", import.meta.url), "utf8"));
const contract = readFileSync(new URL(`../${manifest.sage.contract_file}`, import.meta.url));
const digest = `sha256:${createHash("sha256").update(contract).digest("hex")}`;
if (manifest.sage.contract_sha256 === digest) pass("compatibility contract digest");
else fail("compatibility contract digest does not match the tracked contract");

const invocationKey = process.env.AGENT_INVOCATION_KEY?.trim();
if (!invocationKey) warn("AGENT_INVOCATION_KEY is not loaded; this is expected before local run setup");
else if (invocationKey.length < 32 || invocationKey.includes("replace-with")) {
  fail("AGENT_INVOCATION_KEY must be a non-placeholder value of at least 32 characters");
} else pass("Agent invocation credential shape");

const model = process.env.AGENT_MODEL?.trim();
if (!model) warn("AGENT_MODEL is not loaded; this is expected before local run setup");
else if (model.includes("replace-with")) fail("AGENT_MODEL is still a placeholder");
else pass("Agent model alias");

const platformOrigin = process.env.SAGE_PLATFORM_ORIGIN?.trim();
if (!platformOrigin) warn("SAGE_PLATFORM_ORIGIN is not loaded; this is expected before local run setup");
else {
  try {
    if (platformOrigin.includes("replace-with")) throw new Error();
    validatePlatformOrigin(platformOrigin);
    pass("SAGE platform origin");
  } catch {
    fail("SAGE_PLATFORM_ORIGIN must be an exact non-placeholder HTTPS origin");
  }
}

const artifactUrl = process.env.AGENT_ARTIFACT_URL?.trim();
if (!artifactUrl) warn("AGENT_ARTIFACT_URL is not loaded; external links stay disabled");
else {
  try {
    validateExternalArtifactUrl(artifactUrl);
    pass("external Artifact URL");
  } catch {
    fail("AGENT_ARTIFACT_URL must be credential-free ASCII HTTPS without query or fragment");
  }
}

const statePath = process.env.AGENT_STATE_DB?.trim();
if (!statePath) warn("AGENT_STATE_DB is not loaded; templates default to ./data/agent-state.sqlite");
else if (statePath === ":memory:") fail("AGENT_STATE_DB may not use an in-memory database");
else pass("durable state path");

const docker = spawnSync("docker", ["version", "--format", "{{.Client.Version}}"], {
  encoding: "utf8",
});
if (docker.status === 0) pass(`Docker client ${docker.stdout.trim()}`);
else warn("Docker is unavailable; contract tests still work, but container build cannot be checked");

process.stdout.write(`\n${failures.length} failure(s), ${warnings.length} warning(s)\n`);
if (failures.length > 0) process.exit(1);
