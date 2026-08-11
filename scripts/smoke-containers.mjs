#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chownSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTrustBundle, verifyTlsEndpoint } from "./https-kit.mjs";

const root = new URL("../", import.meta.url);
const nonce = `${process.pid}-${randomUUID().slice(0, 8)}`.toLowerCase();
const prefix = `sage-starter-smoke-${nonce}`;
const temporary = mkdtempSync(join(tmpdir(), `${prefix}-`));
const resources = { containers: [], images: [], networks: [], volumes: [] };
const invocationKey = `fixture-${"x".repeat(40)}`;
const providerKey = `mp1.${"a".repeat(43)}`;
const platformOrigin = "https://platform-fixture:9443";
const caddyImage = "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const processUid = typeof process.getuid === "function" ? process.getuid() : 1_000;
const processGid = typeof process.getgid === "function" ? process.getgid() : 1_000;
const caddyUid = processUid === 0 ? 10_001 : processUid;
const caddyGid = processUid === 0 || processGid === 0 ? caddyUid : processGid;
const runtimeIdentity = `${caddyUid}:${caddyGid}`;
const dockerHost = process.env.SAGE_SMOKE_DOCKER_HOST?.trim() || "127.0.0.1";
const publishAddress = dockerHost === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";

function hostUrl(protocol, port, path) {
  const host = dockerHost.includes(":") ? `[${dockerHost}]` : dockerHost;
  return `${protocol}://${host}:${port}${path}`;
}

function docker(args, { inherit = false, allowFailure = false, env } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: inherit ? "inherit" : "pipe",
  });
  if (!allowFailure && result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`docker ${args.join(" ")} failed`);
  }
  return result;
}

function mappedPort(container, port) {
  const output = docker(["port", container, `${port}/tcp`]).stdout.trim().split(/\r?\n/u)[0];
  const match = output.match(/:(\d+)$/u);
  if (!match) throw new Error(`could not resolve mapped port for ${container}`);
  return Number(match[1]);
}

async function waitForProbe(url, expected = 204, timeoutMs = 60_000, container = null) {
  const deadline = Date.now() + timeoutMs;
  let last = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.status === expected) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  let diagnostics = "";
  if (container) {
    const state = docker(["inspect", "--format", "{{json .State}}", container], { allowFailure: true });
    const logs = docker(["logs", container], { allowFailure: true });
    diagnostics = `\n${state.stdout.trim()}\n${logs.stdout.trim()}\n${logs.stderr.trim()}`;
  }
  throw new Error(`${url} did not return ${expected}: ${last}${diagnostics}`);
}

async function waitForFile(path, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (!existsSync(path)) throw new Error(`${label} was not created before the deadline`);
}

function createVolume(suffix) {
  const name = `${prefix}-${suffix}`;
  docker(["volume", "create", name]);
  resources.volumes.push(name);
  return name;
}

function runCaddy({ configPath, data, config, name, network, networkAliases = [], environment, publishedPort }) {
  mkdirSync(data, { mode: 0o700, recursive: true });
  mkdirSync(config, { mode: 0o700, recursive: true });
  if (processUid === 0) {
    chownSync(data, caddyUid, caddyGid);
    chownSync(config, caddyUid, caddyGid);
  }
  const args = [
    "run", "-d", "--name", name,
    "--network", network,
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--user", runtimeIdentity,
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,size=64m,mode=1777",
    "-e", "XDG_CONFIG_HOME=/config",
    "-e", "XDG_DATA_HOME=/data",
  ];
  for (const alias of networkAliases) args.push("--network-alias", alias);
  for (const [key, value] of Object.entries(environment ?? {})) args.push("-e", `${key}=${value}`);
  if (publishedPort) args.push("-p", `${publishAddress}::${publishedPort}`);
  args.push(
    "--mount", `type=bind,source=${configPath},target=/etc/caddy/Caddyfile,readonly`,
    "--mount", `type=bind,source=${fileURLToPath(new URL("../deploy/https/run-caddy-unprivileged.sh", import.meta.url))},target=/etc/caddy/run-caddy-unprivileged.sh,readonly`,
    "--mount", `type=bind,source=${data},target=/data`,
    "--mount", `type=bind,source=${config},target=/config`,
    "--entrypoint", "/bin/sh",
    caddyImage,
    "/etc/caddy/run-caddy-unprivileged.sh",
  );
  docker(args);
  resources.containers.push(name);
}

async function startPlatformFixture(nodeImage, network) {
  const provider = `${prefix}-provider`;
  docker([
    "run", "-d", "--name", provider,
    "--network", network,
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--read-only",
    "--tmpfs", "/tmp:size=16m,mode=1777",
    "-e", `SAGE_LOCAL_FIXTURE_PROVIDER_KEY=${providerKey}`,
    "-e", "SAGE_LOCAL_FIXTURE_MODEL_HOST=0.0.0.0",
    "-e", "SAGE_LOCAL_FIXTURE_MODEL_PORT=3910",
    nodeImage,
    "node", "node/local-openai-fixture.mjs",
  ]);
  resources.containers.push(provider);

  const caddyfile = join(temporary, "platform.Caddyfile");
  writeFileSync(caddyfile, `{
\tadmin off
\tauto_https disable_redirects
\tpersist_config off
}

https://platform-fixture:9443 {
\ttls internal
\thandle_path /api/agents/model-proxy/* {
\t\treverse_proxy ${provider}:3910
\t}
}
`);
  const data = join(temporary, "platform-caddy-data");
  const config = join(temporary, "platform-caddy-config");
  const caddy = `${prefix}-platform-caddy`;
  runCaddy({
    caddyfile,
    configPath: caddyfile,
    data,
    config,
    name: caddy,
    network,
    networkAliases: ["platform-fixture"],
  });
  const publicCa = join(data, "caddy/pki/authorities/local/root.crt");
  await waitForFile(publicCa, "platform fixture public CA");
  return publicCa;
}

function runAgent({ image, name, network, platformCa, volume }) {
  docker([
    "run", "-d", "--name", name,
    "--network", network,
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--read-only",
    "--tmpfs", "/tmp:size=16m,mode=1777",
    "--mount", `type=volume,source=${volume},target=/data`,
    "--mount", `type=bind,source=${platformCa},target=/trust/platform-ca.crt,readonly`,
    "-e", `AGENT_INVOCATION_KEY=${invocationKey}`,
    "-e", "AGENT_MODEL=sage-local-fixture",
    "-e", `SAGE_PLATFORM_ORIGIN=${platformOrigin}`,
    "-e", "NODE_EXTRA_CA_CERTS=/trust/platform-ca.crt",
    "-e", "SSL_CERT_FILE=/trust/platform-ca.crt",
    "-p", `${publishAddress}::8080`,
    image,
  ]);
  resources.containers.push(name);
}

function sageRequest(input, previousResponseId) {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  return {
    artifact_access: {
      accepted_media_types: ["image/png", "image/jpeg", "image/webp"],
      expires_at: expiresAt,
      max_file_bytes: 10_485_760,
      max_files: 4,
      max_total_bytes: 20_971_520,
      token: `af1.${"b".repeat(43)}`,
      upload_url: `${platformOrigin}/api/agents/artifacts`,
    },
    input,
    model: "agent",
    model_access: {
      base_url: `${platformOrigin}/api/agents/model-proxy/v1`,
      expires_at: expiresAt,
      mode: "platform_proxy_v1",
      token: providerKey,
    },
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    stream: true,
  };
}

async function invokeAgent(port, {
  authorization = `Bearer ${invocationKey}`,
  content,
  conversationId = randomUUID(),
  input,
  previousResponseId,
}) {
  const requestInput = input ?? [{ content, role: "user" }];
  const response = await fetch(hostUrl("http", port, "/v1/responses"), {
    method: "POST",
    headers: {
      ...(authorization ? { authorization } : {}),
      "content-type": "application/json",
      "x-sage-conversation-id": conversationId,
      "x-sage-responses-profile": "stateful-v1",
    },
    body: JSON.stringify(sageRequest(requestInput, previousResponseId)),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (body.length > 1_000_000) throw new Error("Agent smoke response was unexpectedly large");
  return { body, status: response.status };
}

function responseEvents(body) {
  return body
    .split(/\n\n/u)
    .map((frame) => frame
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n"))
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

function completedResponseId(events) {
  return events.findLast((event) => event.type === "response.completed")?.response?.id;
}

async function exerciseApprovalDemo(label, container, port) {
  let activePort = port;
  const conversationId = randomUUID();
  const requested = await invokeAgent(activePort, {
    content: "SAGE_APPROVAL_DEMO",
    conversationId,
  });
  const requestedEvents = responseEvents(requested.body);
  const approval = requestedEvents.find(
    (event) => event.type === "response.output_item.added" &&
      event.item?.type === "mcp_approval_request",
  )?.item;
  const pendingResponseId = completedResponseId(requestedEvents);
  if (
    requested.status !== 200 ||
    typeof approval?.id !== "string" ||
    typeof pendingResponseId !== "string" ||
    JSON.parse(approval.arguments).effect !== "none"
  ) {
    throw new Error(`${label} did not emit the bounded no-side-effect approval request`);
  }

  docker(["restart", container]);
  activePort = mappedPort(container, 8080);
  await waitForProbe(hostUrl("http", activePort, "/readyz"), 204, 60_000, container);
  const approved = await invokeAgent(activePort, {
    conversationId,
    input: [{
      approval_request_id: approval.id,
      approve: true,
      type: "mcp_approval_response",
    }],
    previousResponseId: pendingResponseId,
  });
  const approvedEvents = responseEvents(approved.body);
  const resultResponseId = completedResponseId(approvedEvents);
  if (
    approved.status !== 200 ||
    typeof resultResponseId !== "string" ||
    !approvedEvents.some(
      (event) => event.type === "response.output_item.done" &&
        event.item?.type === "mcp_call" &&
        event.item?.approval_request_id === approval.id &&
        event.item?.output?.includes("No external action was performed"),
    )
  ) {
    throw new Error(`${label} did not resume and complete the approved demo after restart`);
  }

  const replay = await invokeAgent(activePort, {
    conversationId,
    input: [{
      approval_request_id: approval.id,
      approve: true,
      type: "mcp_approval_response",
    }],
    previousResponseId: pendingResponseId,
  });
  if (
    replay.status !== 409 ||
    !replay.body.includes("previous_response_not_found")
  ) {
    throw new Error(`${label} accepted a replayed approval decision`);
  }

  const continued = await invokeAgent(activePort, {
    content: "Continue after the approval demo",
    conversationId,
    previousResponseId: resultResponseId,
  });
  if (
    continued.status !== 200 ||
    !continued.body.includes("SAGE_AGENT_E2E_OK") ||
    !continued.body.includes("response.completed")
  ) {
    throw new Error(`${label} did not retain the ordinary provider head after the demo`);
  }

  const deniedConversationId = randomUUID();
  const denyRequest = await invokeAgent(activePort, {
    content: "SAGE_APPROVAL_DEMO",
    conversationId: deniedConversationId,
  });
  const denyRequestEvents = responseEvents(denyRequest.body);
  const denyApproval = denyRequestEvents.find(
    (event) => event.type === "response.output_item.added" &&
      event.item?.type === "mcp_approval_request",
  )?.item;
  const denyPrevious = completedResponseId(denyRequestEvents);
  const denied = await invokeAgent(activePort, {
    conversationId: deniedConversationId,
    input: [{
      approval_request_id: denyApproval?.id,
      approve: false,
      reason: "Not needed for this rehearsal",
      type: "mcp_approval_response",
    }],
    previousResponseId: denyPrevious,
  });
  const deniedEvents = responseEvents(denied.body);
  if (
    denied.status !== 200 ||
    !denied.body.includes("demonstration was denied") ||
    deniedEvents.some(
      (event) => event.type === "response.output_item.done" &&
        event.item?.type === "mcp_call",
    )
  ) {
    throw new Error(`${label} did not preserve the no-execution denial branch`);
  }
  process.stdout.write(`PASS  ${label} durable approval, restart, replay rejection, continuation, and denial\n`);
}

async function waitForNodeOutcome(container, outcome) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const lines = docker(["logs", container]).stdout.split(/\r?\n/u);
    const found = lines.some((line) => {
      try {
        const event = JSON.parse(line);
        return event.event === "request_finished" && event.route === "/v1/responses" && event.stream_outcome === outcome;
      } catch {
        return false;
      }
    });
    if (found) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Node did not log sanitized stream_outcome=${outcome}`);
}

async function exerciseAgent(label, container, port, includeNonSuccess = false) {
  for (const authorization of [null, "Bearer wrong-credential"]) {
    const rejected = await invokeAgent(port, {
      authorization,
      content: "auth negative",
    });
    if (rejected.status !== 401 || rejected.body.includes(invocationKey)) {
      throw new Error(`${label} did not return a generic 401 for invalid authorization`);
    }
  }
  const success = await invokeAgent(port, { content: "Explain opportunity cost" });
  if (success.status !== 200 || !success.body.includes("SAGE_AGENT_E2E_OK") || !success.body.includes("response.completed")) {
    const logs = docker(["logs", container], { allowFailure: true });
    const platformLogs = docker(["logs", `${prefix}-platform-caddy`], { allowFailure: true });
    const providerLogs = docker(["logs", `${prefix}-provider`], { allowFailure: true });
    throw new Error(`${label} did not complete a bounded real /v1/responses smoke (HTTP ${success.status}, body ${JSON.stringify(success.body.slice(0, 500))})\nAgent:\n${logs.stdout}\n${logs.stderr}\nPlatform edge:\n${platformLogs.stdout}\n${platformLogs.stderr}\nProvider:\n${providerLogs.stdout}\n${providerLogs.stderr}`);
  }
  process.stdout.write(`PASS  ${label} auth rejection and real /v1/responses instruction relay\n`);

  if (!includeNonSuccess) return;
  await waitForNodeOutcome(container, "completed");
  for (const [sentinel, expectedBody, forbiddenBody, outcome] of [
    ["SAGE_FIXTURE_FAIL", "response.failed", "SAGE_FIXTURE_PRIVATE_DETAIL_MUST_NOT_RELAY", "failed"],
    ["SAGE_FIXTURE_INCOMPLETE", "response.failed", "SAGE_FIXTURE_PRIVATE_DETAIL_MUST_NOT_RELAY", "failed"],
    ["SAGE_FIXTURE_EARLY_DONE", "[DONE]", null, "failed"],
    ["SAGE_FIXTURE_NO_TERMINAL", "SAGE_FIXTURE_PARTIAL", null, "incomplete"],
  ]) {
    const result = await invokeAgent(port, { content: sentinel });
    if (result.status !== 200 || !result.body.includes(expectedBody) || (forbiddenBody && result.body.includes(forbiddenBody))) {
      throw new Error(`Node non-success stream regression failed for ${sentinel}`);
    }
    await waitForNodeOutcome(container, outcome);
  }
  process.stdout.write("PASS  Node sanitized completed/failed/incomplete stream outcomes\n");
}

async function smokeAgent(label, image, name, network, platformCa, includeNonSuccess = false) {
  const volume = createVolume(`${label.toLowerCase()}-state`);
  runAgent({ image, name, network, platformCa, volume });
  const port = mappedPort(name, 8080);
  await waitForProbe(hostUrl("http", port, "/healthz"), 204, 60_000, name);
  await waitForProbe(hostUrl("http", port, "/readyz"), 204, 60_000, name);
  process.stdout.write(`PASS  ${label} container startup, /healthz, and /readyz\n`);
  await exerciseAgent(label, name, port, includeNonSuccess);
  await exerciseApprovalDemo(label, name, port);
}

async function smokeTls(nodeContainer, network) {
  const data = join(temporary, "agent-caddy-data");
  const config = join(temporary, "agent-caddy-config");
  const name = `${prefix}-agent-caddy`;
  runCaddy({
    configPath: fileURLToPath(new URL("../deploy/https/Caddyfile", import.meta.url)),
    data,
    config,
    name,
    network,
    environment: {
      SAGE_AGENT_HTTPS_SITE: "localhost:8443",
      SAGE_AGENT_UPSTREAM: `${nodeContainer}:8080`,
    },
    publishedPort: 8443,
  });
  const publicCa = join(data, "caddy/pki/authorities/local/root.crt");
  await waitForFile(publicCa, "Agent private HTTPS public CA");
  const port = mappedPort(name, 8443);
  const trust = buildTrustBundle(`https://localhost:${port}`, readFileSync(publicCa, "utf8"));
  const serialized = JSON.stringify(trust);
  if (serialized.includes("PRIVATE KEY") || Object.keys(trust).join(",") !== "schema,base_url,ca_pem") {
    throw new Error("generated trust bundle is not exact and public-only");
  }
  await verifyTlsEndpoint(
    trust,
    20_000,
    dockerHost === "127.0.0.1" ? {} : { connectHost: dockerHost },
  );
  process.stdout.write("PASS  pinned Caddy private-CA TLS handshake and proxied /readyz\n");
}

function cleanup() {
  for (const container of resources.containers.reverse()) docker(["rm", "-f", container], { allowFailure: true });
  for (const network of resources.networks.reverse()) docker(["network", "rm", network], { allowFailure: true });
  for (const volume of resources.volumes.reverse()) docker(["volume", "rm", volume], { allowFailure: true });
  for (const image of resources.images.reverse()) docker(["image", "rm", image], { allowFailure: true });
  rmSync(temporary, { force: true, recursive: true });
}

async function main() {
  docker(["info"]);
  const envFile = join(temporary, "agent.env");
  writeFileSync(envFile, [
    `AGENT_INVOCATION_KEY=${invocationKey}`,
    "AGENT_MODEL=sage-local-fixture",
    "SAGE_PLATFORM_ORIGIN=https://sage.example.edu",
    "AGENT_STATE_DB=/data/agent-state.sqlite",
    "",
  ].join("\n"));
  docker(["compose", "--profile", "node-https", "config", "--quiet"], {
    env: {
      SAGE_AGENT_ENV_FILE: envFile,
      SAGE_AGENT_HTTPS_DATA_DIR: join(temporary, "compose-data"),
      SAGE_AGENT_HTTPS_GID: String(caddyGid),
      SAGE_AGENT_HTTPS_PORT: "18443",
      SAGE_AGENT_HTTPS_SITE: "localhost:8443",
      SAGE_AGENT_HTTPS_UID: String(caddyUid),
    },
  });
  process.stdout.write("PASS  Compose HTTP/private-HTTPS profile renders\n");

  const nodeImage = `${prefix}-node:local`;
  const fastapiImage = `${prefix}-fastapi:local`;
  for (const [dockerfile, image] of [["node/Dockerfile", nodeImage], ["fastapi/Dockerfile", fastapiImage]]) {
    docker(["build", "--pull", "-f", dockerfile, "-t", image, "."], { inherit: true });
    resources.images.push(image);
  }

  const network = `${prefix}-network`;
  docker(["network", "create", network]);
  resources.networks.push(network);
  const platformCa = await startPlatformFixture(nodeImage, network);
  const nodeContainer = `${prefix}-node`;
  await smokeAgent("Node", nodeImage, nodeContainer, network, platformCa, true);
  await smokeTls(nodeContainer, network);
  await smokeAgent("FastAPI", fastapiImage, `${prefix}-fastapi`, network, platformCa);
}

try {
  await main();
} finally {
  cleanup();
}
