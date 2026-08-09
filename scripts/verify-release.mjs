#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("compatibility.json", root), "utf8"));
const tag = manifest.starter.release_tag;

function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

const status = git("status", "--porcelain=v1", "--untracked-files=all");
if (status) throw new Error("release verification requires a clean worktree");

const head = git("rev-parse", "HEAD");
const tagObjectType = git("cat-file", "-t", `refs/tags/${tag}`);
if (tagObjectType !== "tag") throw new Error(`${tag} must be an annotated tag`);

const taggedCommit = git("rev-parse", `${tag}^{commit}`);
if (taggedCommit !== head) {
  throw new Error(`${tag} does not resolve to current HEAD ${head}`);
}

process.stdout.write(`Verified annotated ${tag} at ${head}.\n`);
