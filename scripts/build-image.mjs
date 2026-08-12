#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { withExactSourceContext } from "./source-revision.mjs";

const root = new URL("../", import.meta.url);

const args = process.argv.slice(2);
const runtime = args[1];
const tag = args[3];
if (
  args.length !== 4 ||
  args[0] !== "--runtime" ||
  args[2] !== "--tag" ||
  !["node", "fastapi"].includes(runtime) ||
  typeof tag !== "string" ||
  tag.length === 0 ||
  tag.length > 256 ||
  tag.startsWith("-") ||
  /[\0\s]/u.test(tag)
) {
  throw new Error("usage: build-image.mjs --runtime node|fastapi --tag IMAGE_TAG");
}

withExactSourceContext(root, ({ context, revision }) => {
  const built = spawnSync("docker", [
    "build",
    "--pull",
    "--build-arg",
    `SAGE_AGENT_SOURCE_REVISION=${revision}`,
    "-f",
    join(context, runtime, "Dockerfile"),
    "-t",
    tag,
    context,
  ], { encoding: "utf8", env: process.env, stdio: "inherit" });
  if (built.status !== 0) throw new Error(`Docker ${runtime} image build failed`);

  const inspected = spawnSync("docker", [
    "image",
    "inspect",
    "--format",
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
    tag,
  ], { encoding: "utf8", env: process.env });
  if (inspected.status !== 0 || inspected.stdout.trim() !== revision) {
    throw new Error("built image does not carry the exact exported source revision");
  }
  process.stdout.write(`Built ${runtime} image from exact source revision ${revision}.\n`);
});
