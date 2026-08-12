#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withExactSourceContext } from "./source-revision.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const args = process.argv.slice(2);
const profile = args[1];
const detach = args[2] === "--detach";
if (
  (args.length !== 2 && args.length !== 3) ||
  args[0] !== "--profile" ||
  (args.length === 3 && !detach) ||
  !["node", "fastapi"].includes(profile) ||
  args.some((argument) => /[\0\r\n]/u.test(argument))
) {
  throw new Error("usage: compose-up.mjs --profile node|fastapi [--detach]");
}

withExactSourceContext(root, ({ context, revision }) => {
  const composeArgs = [
    "compose",
    "-f",
    join(context, "compose.yaml"),
    "--project-directory",
    rootPath,
    "--profile",
    profile,
    "up",
    "--build",
  ];
  if (detach) composeArgs.push("--detach");
  const started = spawnSync("docker", composeArgs, {
    encoding: "utf8",
    env: {
      ...process.env,
      SAGE_AGENT_BUILD_CONTEXT: context,
      SAGE_AGENT_SOURCE_REVISION: revision,
    },
    stdio: "inherit",
  });
  if (started.status !== 0) throw new Error(`Docker Compose ${profile} startup failed`);
});
