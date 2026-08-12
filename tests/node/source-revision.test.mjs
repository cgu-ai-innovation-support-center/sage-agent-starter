import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  exactCleanSourceRevision,
  withExactSourceContext,
} from "../../scripts/source-revision.mjs";

function commitFixture(directory, content) {
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  writeFileSync(join(directory, "source.txt"), content);
  execFileSync("git", ["add", "source.txt"], { cwd: directory });
  execFileSync("git", [
    "-c", "user.name=SAGE Starter Test",
    "-c", "user.email=sage-starter-test@example.invalid",
    "commit", "--quiet", "-m", "fixture",
  ], { cwd: directory });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
}

test("source revision resolves the clean commit and rejects a dirty-HEAD guess", () => {
  const directory = mkdtempSync(join(tmpdir(), "sage-source-revision-"));
  try {
    const expected = commitFixture(directory, "committed\n");

    assert.equal(exactCleanSourceRevision(directory), expected);
    writeFileSync(join(directory, "source.txt"), "dirty\n");
    assert.throws(() => exactCleanSourceRevision(directory), /dirty HEAD is not an exact image revision/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("source revision ignores ambient Git repository-selection variables", () => {
  const directory = mkdtempSync(join(tmpdir(), "sage-source-revision-a-"));
  const other = mkdtempSync(join(tmpdir(), "sage-source-revision-b-"));
  const previousGitDir = process.env.GIT_DIR;
  const previousGitWorkTree = process.env.GIT_WORK_TREE;
  try {
    const expected = commitFixture(directory, "source-a\n");
    commitFixture(other, "source-b\n");
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    assert.equal(exactCleanSourceRevision(directory), expected);
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
    if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousGitWorkTree;
    rmSync(directory, { force: true, recursive: true });
    rmSync(other, { force: true, recursive: true });
  }
});

test("exact source context exports raw committed blobs without ignored files or smudge filters", () => {
  const directory = mkdtempSync(join(tmpdir(), "sage-source-context-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    mkdirSync(join(directory, "fastapi"));
    writeFileSync(join(directory, ".gitignore"), "fastapi/httpx.py\n");
    writeFileSync(join(directory, ".gitattributes"), "source.txt filter=probe\n");
    writeFileSync(join(directory, "source.txt"), "committed\n");
    execFileSync("git", ["add", ".gitattributes", ".gitignore", "source.txt"], { cwd: directory });
    execFileSync("git", [
      "-c", "user.name=SAGE Starter Test",
      "-c", "user.email=sage-starter-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: directory });
    const expected = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["config", "filter.probe.smudge", "sed s/committed/injected/"], {
      cwd: directory,
    });
    writeFileSync(join(directory, "fastapi/httpx.py"), "raise RuntimeError('must not ship')\n");

    const result = withExactSourceContext(directory, ({ context, revision }) => {
      assert.equal(revision, expected);
      assert.equal(readFileSync(join(context, "source.txt"), "utf8"), "committed\n");
      assert.equal(existsSync(join(context, "fastapi/httpx.py")), false);
      return context;
    });
    assert.equal(existsSync(result), false, "temporary exact context must be removed");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
