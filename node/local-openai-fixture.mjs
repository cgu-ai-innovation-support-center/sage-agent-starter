import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

const host = "127.0.0.1";
const port = Number(process.env.SAGE_LOCAL_FIXTURE_MODEL_PORT ?? "3910");
const apiKey = process.env.SAGE_LOCAL_FIXTURE_PROVIDER_KEY?.trim();
const model = "sage-local-fixture";
const outputText = "SAGE_AGENT_E2E_OK";
const maxBodyBytes = 256_000;

if (!apiKey || apiKey.length < 32) {
  throw new Error("SAGE_LOCAL_FIXTURE_PROVIDER_KEY must contain at least 32 characters");
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("SAGE_LOCAL_FIXTURE_MODEL_PORT must be a valid TCP port");
}

function authorized(request) {
  const received = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw Object.assign(new Error("request too large"), { status: 413 });
    }
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
  return value;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
}

function responseDocument(id, createdAt) {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [
      {
        id: `msg_${randomUUID().replaceAll("-", "")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            annotations: [],
            text: outputText,
          },
        ],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 20,
    },
    user: null,
  };
}

function writeEvent(response, value) {
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

function streamResponse(response) {
  const id = `resp_${randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const itemId = `msg_${randomUUID().replaceAll("-", "")}`;
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/event-stream",
    connection: "keep-alive",
  });
  writeEvent(response, {
    type: "response.created",
    response: {
      ...responseDocument(id, createdAt),
      status: "in_progress",
      output: [],
      usage: null,
    },
    sequence_number: 0,
  });
  writeEvent(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    sequence_number: 1,
  });
  writeEvent(response, {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", annotations: [], text: "" },
    sequence_number: 2,
  });
  writeEvent(response, {
    type: "response.output_text.delta",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: outputText,
    logprobs: [],
    sequence_number: 3,
  });
  writeEvent(response, {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text: outputText,
    logprobs: [],
    sequence_number: 4,
  });
  writeEvent(response, {
    type: "response.content_part.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", annotations: [], text: outputText },
    sequence_number: 5,
  });
  writeEvent(response, {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], text: outputText }],
    },
    sequence_number: 6,
  });
  writeEvent(response, {
    type: "response.completed",
    response: responseDocument(id, createdAt),
    sequence_number: 7,
  });
  response.end();
}

function streamChatCompletion(response) {
  const id = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/event-stream",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: outputText }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      if (!authorized(request)) {
        sendJson(response, 401, { error: { message: "unauthorized", type: "authentication_error" } });
        return;
      }
      sendJson(response, 200, {
        object: "list",
        data: [{ id: model, object: "model", created: 0, owned_by: "sage-local" }],
      });
      return;
    }
    if (
      request.method !== "POST" ||
      !new Set(["/v1/chat/completions", "/v1/responses"]).has(request.url)
    ) {
      sendJson(response, 404, { error: { message: "not found", type: "invalid_request_error" } });
      return;
    }
    if (!authorized(request)) {
      sendJson(response, 401, { error: { message: "unauthorized", type: "authentication_error" } });
      return;
    }
    const body = await readJson(request);
    if (request.url === "/v1/responses") {
      if (body.stream === true) streamResponse(response);
      else sendJson(response, 200, responseDocument(`resp_${randomUUID().replaceAll("-", "")}`, Math.floor(Date.now() / 1000)));
      return;
    }
    if (body.stream === true) {
      streamChatCompletion(response);
      return;
    }
    sendJson(response, 200, {
      id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: outputText, refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, Number.isInteger(error?.status) ? error.status : 500, {
        error: { message: "fixture request rejected", type: "invalid_request_error" },
      });
    } else {
      response.end();
    }
  }
}).listen(port, host, () => {
  process.stdout.write(`[local-openai-fixture] listening on http://${host}:${port}\n`);
});
