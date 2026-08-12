import { spawnSync } from "node:child_process";

export function exactCleanSourceRevision(cwd) {
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  if (status.status !== 0) throw new Error("could not inspect the source worktree");
  if (status.stdout) {
    throw new Error("a clean committed source tree is required; dirty HEAD is not an exact image revision");
  }

  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const revision = head.stdout.trim();
  if (
    head.status !== 0 ||
    !/^[0-9a-f]{40}$/u.test(revision) ||
    revision === "0".repeat(40)
  ) {
    throw new Error("could not resolve an exact non-zero source commit");
  }
  return revision;
}
