import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exactCleanSourceRevision } from "../../scripts/source-revision.mjs";

test("source revision resolves the clean commit and rejects a dirty-HEAD guess", () => {
  const directory = mkdtempSync(join(tmpdir(), "sage-source-revision-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    writeFileSync(join(directory, "source.txt"), "committed\n");
    execFileSync("git", ["add", "source.txt"], { cwd: directory });
    execFileSync("git", [
      "-c", "user.name=SAGE Starter Test",
      "-c", "user.email=sage-starter-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: directory });
    const expected = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    }).trim();

    assert.equal(exactCleanSourceRevision(directory), expected);
    writeFileSync(join(directory, "source.txt"), "dirty\n");
    assert.throws(() => exactCleanSourceRevision(directory), /dirty HEAD is not an exact image revision/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
