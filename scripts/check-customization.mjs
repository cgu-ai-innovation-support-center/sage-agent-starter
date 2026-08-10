#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const policy = JSON.parse(readFileSync(new URL("harness/customization-policy.json", root), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("compatibility.json", root), "utf8"));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const raw = process.argv.slice(2);
let base = manifest.starter.release_tag;
if (raw.length) {
  if (raw.length !== 2 || raw[0] !== "--base" || !raw[1]) {
    fail("usage: check-customization.mjs [--base <git-ref>]");
  }
  base = raw[1];
}

const ref = spawnSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
  cwd: root,
  encoding: "utf8",
});
if (ref.status !== 0) {
  fail(`customization base ${base} is unavailable; pass --base with the reviewed starting ref`);
}

function gitPaths(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "buffer" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed`);
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

const changed = new Set([
  ...gitPaths(["diff", "--name-only", "-z", base, "--"]),
  ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"]),
]);
const safe = new Set(policy.safe_customization_paths);
const reviewRequired = [...changed].filter((path) => !safe.has(path)).sort();

if (reviewRequired.length) {
  process.stderr.write("Ordinary teacher customization touched review-required paths:\n");
  for (const path of reviewRequired) process.stderr.write(`- ${path}\n`);
  process.stderr.write("Revert those changes or route them through maintainer review and npm run test:full.\n");
  process.exit(1);
}

process.stdout.write(`Customization boundary passed: ${changed.size} changed file(s), all inside the fixed agent seam.\n`);
