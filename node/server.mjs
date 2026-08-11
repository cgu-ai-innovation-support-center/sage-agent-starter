import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { loadAgentProfile } from "./agent-profile.mjs";
import {
  isPreviousResponseError,
  validateExternalArtifactUrl,
  validatePlatformContract,
  validatePlatformOrigin,
  validateShowcaseContract,
} from "./contract.mjs";
import {
  showcaseEvents,
  showcaseResponseId,
  uploadShowcaseArtifact,
} from "./showcase.mjs";
import {
  commitThenReleaseTerminal,
  DurableResponseStreamGate,
  SqliteResponseStateStore,
} from "./state-store.mjs";
import { buildProviderRequest } from "./provider-request.mjs";
import {
  approvalDemoPendingAction,
  approvalDemoRequestFrames,
  approvalDemoResultFrames,
  approvalRequestId,
  approvalResultResponseId,
  isApprovalDemoInput,
} from "./approval-demo.mjs";

const MAX_BODY_BYTES = 256_000;
const MAX_UPSTREAM_BYTES = 8_000_000;
const MAX_ERROR_BYTES = 64_000;
const RESPONSE_WRITE_TIMEOUT_MS = 60_000;
const SHOWCASE_REASONING_HOLD_MS = 5_000;
const listenHost = process.env.HOST?.trim() || "127.0.0.1";
const listenPort = Number(process.env.PORT ?? "8080");
const agentProfile = loadAgentProfile();

if (!new Set(["127.0.0.1", "0.0.0.0"]).has(listenHost)) {
  throw new Error("HOST must be the literal 127.0.0.1 or 0.0.0.0");
}
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

function required(name, minimum = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimum || value.includes("replace-with")) {
    throw new Error(`missing or invalid required environment variable: ${name}`);
  }
  return value;
}

function same(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    event,
    level: "info",
    timestamp: new Date().toISOString(),
    ...fields,
  })}\n`);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function continuationLost(response) {
  sendJson(response, 409, {
    error: {
      code: "previous_response_not_found",
      message: "The Agent cannot continue from that response ID.",
    },
  });
}

async function writeFrame(response, frame) {
  if (response.write(frame)) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      response.destroy();
      reject(new Error("client did not accept response data before the deadline"));
    }, RESPONSE_WRITE_TIMEOUT_MS);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("client disconnected while receiving response"));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    if (response.destroyed) onClose();
  });
}

function artifactEvent() {
  const raw = process.env.AGENT_ARTIFACT_URL?.trim();
  if (!raw) return null;
  validateExternalArtifactUrl(raw);
  return `data: ${JSON.stringify({
    type: "sage.artifact.link",
    url: raw,
    name: "agent-output",
  })}\n\n`;
}

async function readBoundedBody(stream, maximum) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream ?? []) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("upstream response too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readRequestBody(request) {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error("request too large"), { status: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request too large"), { status: 413 });
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

const state = new SqliteResponseStateStore();
state.prune();

const server = createServer(async (request, response) => {
  const started = Date.now();
  let status = 500;
  let streamOutcome = null;
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      status = 204;
      response.writeHead(status, { "cache-control": "no-store" }).end();
      return;
    }
    if (request.method === "GET" && request.url === "/readyz") {
      try {
        required("AGENT_INVOCATION_KEY", 32);
        required("AGENT_MODEL");
        validatePlatformOrigin(required("SAGE_PLATFORM_ORIGIN"));
        const configuredArtifactUrl = process.env.AGENT_ARTIFACT_URL?.trim();
        if (configuredArtifactUrl) validateExternalArtifactUrl(configuredArtifactUrl);
        if (!state.ready()) throw new Error("state store unavailable");
      } catch {
        status = 503;
        response.writeHead(status, { "cache-control": "no-store" }).end();
        return;
      }
      status = 204;
      response.writeHead(status, { "cache-control": "no-store" }).end();
      return;
    }

    const showcase = request.url === "/showcase/v1/responses";
    if (request.method !== "POST" || (!showcase && request.url !== "/v1/responses")) {
      status = 404;
      response.writeHead(status).end();
      return;
    }
    if (!same(request.headers.authorization ?? "", `Bearer ${required("AGENT_INVOCATION_KEY", 32)}`)) {
      status = 401;
      response.writeHead(status, { "cache-control": "no-store" }).end();
      return;
    }

    const body = await readRequestBody(request);
    if (showcase) {
      const contract = validateShowcaseContract(
        request.headers,
        body,
        required("SAGE_PLATFORM_ORIGIN"),
      );
      const responseId = showcaseResponseId(required("AGENT_INVOCATION_KEY", 32), contract.conversationId);
      if (contract.previous && contract.previous !== responseId) {
        status = 409;
        continuationLost(response);
        return;
      }
      if (contract.input.includes("SAGE_SHOWCASE_FAIL")) {
        status = 200;
        response.writeHead(status, {
          "cache-control": "no-store",
          "content-type": "text/event-stream",
        });
        await writeFrame(response, `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "SAGE_SHOWCASE_PARTIAL_MUST_NOT_PERSIST",
        })}\n\n`);
        response.end(`data: ${JSON.stringify({ type: "response.failed" })}\n\n`);
        return;
      }
      const fileId = await uploadShowcaseArtifact(contract.artifact);
      status = 200;
      response.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
      });
      for (const event of showcaseEvents(fileId, responseId)) {
        await writeFrame(response, `data: ${JSON.stringify(event)}\n\n`);
        if (event.type === "response.output_item.added" && event.item?.id === "showcase-tool-item-2") {
          await new Promise((resolve) => setTimeout(resolve, SHOWCASE_REASONING_HOLD_MS));
        }
      }
      response.end();
      return;
    }

    const contract = validatePlatformContract(
      request.headers,
      body,
      required("SAGE_PLATFORM_ORIGIN"),
    );
    const approvalContinuation = contract.input.every(
      (item) => item?.type === "mcp_approval_response",
    );
    if (approvalContinuation) {
      const responses = contract.input.map((item) => ({
        approvalRequestId: item.approval_request_id,
        approved: item.approve,
      }));
      const resultResponseId = approvalResultResponseId(
        required("AGENT_INVOCATION_KEY", 32),
        contract.conversationId,
        contract.previous,
        responses,
      );
      const consumed = state.consumePending({
        conversationId: contract.conversationId,
        responseId: contract.previous,
        responses,
        resultResponseId,
      });
      if (!consumed) {
        status = 409;
        continuationLost(response);
        return;
      }
      status = 200;
      streamOutcome = "completed";
      response.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
      });
      for (const frame of approvalDemoResultFrames({
        actions: consumed.actions,
        responseId: resultResponseId,
      })) {
        await writeFrame(response, frame);
      }
      response.end();
      return;
    }

    const approvalDemo = isApprovalDemoInput(contract.input);
    let providerPrevious;
    if (contract.previous) {
      if (state.hasPending(contract.conversationId, contract.previous)) {
        status = 409;
        continuationLost(response);
        return;
      }
      providerPrevious = state.resolve(contract.conversationId, contract.previous);
      if (!providerPrevious) {
        status = 409;
        continuationLost(response);
        return;
      }
    }

    const abort = new AbortController();
    request.once("aborted", () => abort.abort());
    response.once("close", () => {
      if (!response.writableEnded) abort.abort();
    });
    const upstream = await fetch(new URL("responses", `${contract.proxy.baseUrl}/`), {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${contract.proxy.token}`,
        "content-type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
      body: JSON.stringify(buildProviderRequest({
        model: required("AGENT_MODEL"),
        instructions: agentProfile.instructions,
        input: contract.input,
        previousResponseId: providerPrevious,
      })),
    });

    if (!upstream.ok) {
      const rawError = await readBoundedBody(upstream.body, MAX_ERROR_BYTES);
      if (isPreviousResponseError(upstream.status, rawError, Boolean(providerPrevious))) {
        status = 409;
        continuationLost(response);
        return;
      }
      throw Object.assign(new Error("model gateway rejected request"), { status: 502 });
    }
    if (!upstream.body || !upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
      await upstream.body?.cancel();
      throw Object.assign(new Error("model gateway returned an invalid stream"), { status: 502 });
    }

    status = 200;
    streamOutcome = "incomplete";
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "text/event-stream",
    });
    const artifact = artifactEvent();
    if (artifact) await writeFrame(response, artifact);
    const gate = new DurableResponseStreamGate();
    let transferred = 0;
    for await (const chunk of upstream.body) {
      transferred += chunk.length;
      if (transferred > MAX_UPSTREAM_BYTES) throw new Error("upstream response too large");
      for (const frame of gate.push(chunk)) await writeFrame(response, frame);
    }
    const completion = gate.finish();
    streamOutcome = completion.streamOutcome;
    for (const frame of completion.outputFrames) await writeFrame(response, frame);
    const terminalFrames = [];
    if (approvalDemo && completion.completedResponseId) {
      const action = approvalDemoPendingAction(approvalRequestId(
        required("AGENT_INVOCATION_KEY", 32),
        contract.conversationId,
        completion.completedResponseId,
      ));
      state.recordPending({
        actions: [action],
        conversationId: contract.conversationId,
        providerResponseId: completion.completedResponseId,
      });
      for (const frame of approvalDemoRequestFrames(action)) {
        await writeFrame(response, frame);
      }
      terminalFrames.push(...completion.terminalFrames);
    } else {
      commitThenReleaseTerminal({
        completion,
        conversationId: contract.conversationId,
        state,
        write: (frame) => terminalFrames.push(frame),
      });
    }
    for (const frame of terminalFrames) await writeFrame(response, frame);
    response.end();
  } catch (error) {
    status = Number.isInteger(error?.status) ? error.status : 500;
    if (response.headersSent && streamOutcome !== "completed") streamOutcome = "failed";
    if (!response.headersSent) {
      sendJson(response, status, {
        error: { code: status < 500 ? "request_rejected" : "agent_unavailable" },
      });
    } else {
      response.destroy();
    }
  } finally {
    log("request_finished", {
      duration_ms: Date.now() - started,
      method: request.method,
      route: request.url?.split("?", 1)[0] ?? "unknown",
      status,
      ...(streamOutcome ? { stream_outcome: streamOutcome } : {}),
    });
  }
});

server.listen(listenPort, listenHost, () => {
  log("server_ready", { host: listenHost, port: listenPort });
});

function shutdown(signal) {
  log("server_stopping", { signal });
  server.close(() => {
    state.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
