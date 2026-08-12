import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function filesystemPath(cwd) {
  return resolve(cwd instanceof URL ? fileURLToPath(cwd) : cwd);
}

function gitEnvironment() {
  return {
    ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
    ),
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function git(cwd, args, encoding = "utf8") {
  return spawnSync("git", args, {
    cwd,
    encoding,
    env: gitEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function exactTreeEntries(sourceRoot, revision) {
  const listed = git(sourceRoot, ["ls-tree", "-r", "-z", "--full-tree", revision], "buffer");
  if (listed.status !== 0) throw new Error("could not inspect the exact source tree");
  return listed.stdout.subarray(0, -1).toString("utf8").split("\0").map((record) => {
    const match = record.match(/^([0-7]{6}) blob ([0-9a-f]{40})\t(.+)$/u);
    if (!match || !["100644", "100755"].includes(match[1])) {
      throw new Error("exact source tree contains an unsupported entry");
    }
    const path = match[3];
    const components = path.split("/");
    if (
      Buffer.from(record, "utf8").toString("utf8") !== record ||
      path.startsWith("/") ||
      components.some((component) => component === "" || component === "." || component === "..")
    ) {
      throw new Error("exact source tree contains an unsafe path");
    }
    return { executable: match[1] === "100755", object: match[2], path };
  });
}

function exactBlob(sourceRoot, object) {
  const blob = git(sourceRoot, ["cat-file", "blob", object], "buffer");
  if (blob.status !== 0) throw new Error("could not read an exact source blob");
  const digest = createHash("sha1")
    .update(`blob ${blob.stdout.length}\0`)
    .update(blob.stdout)
    .digest("hex");
  if (digest !== object) throw new Error("exact source blob does not match its Git object ID");
  return blob.stdout;
}

export function exactCleanSourceRevision(cwd) {
  const sourceRoot = filesystemPath(cwd);
  const topLevel = git(sourceRoot, ["rev-parse", "--show-toplevel"]);
  if (
    topLevel.status !== 0 ||
    !topLevel.stdout.trim() ||
    realpathSync(topLevel.stdout.trim()) !== realpathSync(sourceRoot)
  ) {
    throw new Error("source path must be the exact Git worktree root");
  }

  const status = git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.status !== 0) throw new Error("could not inspect the source worktree");
  if (status.stdout) {
    throw new Error("a clean committed source tree is required; dirty HEAD is not an exact image revision");
  }

  const head = git(sourceRoot, ["rev-parse", "HEAD"]);
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

export function createExactSourceContext(cwd) {
  const sourceRoot = filesystemPath(cwd);
  const revision = exactCleanSourceRevision(sourceRoot);
  const temporary = mkdtempSync(join(tmpdir(), "sage-agent-source-"));
  const context = join(temporary, "context");
  try {
    mkdirSync(context, { mode: 0o700 });
    for (const entry of exactTreeEntries(sourceRoot, revision)) {
      const target = join(context, ...entry.path.split("/"));
      if (!target.startsWith(`${context}${sep}`)) throw new Error("exact source path escaped its context");
      mkdirSync(dirname(target), { mode: 0o755, recursive: true });
      writeFileSync(target, exactBlob(sourceRoot, entry.object), { flag: "wx", mode: 0o600 });
      chmodSync(target, entry.executable ? 0o755 : 0o644);
    }
    if (exactCleanSourceRevision(sourceRoot) !== revision) {
      throw new Error("source revision changed while exporting the exact build context");
    }
    let cleaned = false;
    return {
      context,
      revision,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        rmSync(temporary, { force: true, recursive: true });
      },
    };
  } catch (error) {
    rmSync(temporary, { force: true, recursive: true });
    throw error;
  }
}

export function withExactSourceContext(cwd, operation) {
  if (typeof operation !== "function") throw new TypeError("exact source context operation is required");
  const exact = createExactSourceContext(cwd);
  try {
    return operation(exact);
  } finally {
    exact.cleanup();
  }
}
