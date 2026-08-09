import { createHmac } from "node:crypto";

const SHOWCASE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABAAgMAAACYWpqdAAAADFBMVEX6zBU7gvYixV70P15tMCB3AAAACXBIWXMAAAsTAAALEwEAmpwYAAAAIUlEQVQ4y2P4jwRWIQGGUYlRiVEJhlAkwIAMRiVGJUYlADtm/R+uhhRzAAAAAElFTkSuQmCC",
  "base64"
);
const MAX_ARTIFACT_RESPONSE_BYTES = 64_000;

async function readBoundedJson(response) {
  const chunks = [];
  let transferred = 0;
  for await (const chunk of response.body ?? []) {
    transferred += chunk.length;
    if (transferred > MAX_ARTIFACT_RESPONSE_BYTES) {
      throw new Error("artifact upload response too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export function showcaseResponseId(invocationKey, conversationId) {
  return `showcase_${createHmac("sha256", invocationKey)
    .update(`response\0${conversationId}`)
    .digest("base64url")}`;
}

export async function uploadShowcaseArtifact(artifact, fetchImpl = fetch) {
  const response = await fetchImpl(artifact.uploadUrl, {
    body: SHOWCASE_PNG,
    headers: {
      authorization: `Bearer ${artifact.token}`,
      "content-length": String(SHOWCASE_PNG.length),
      "content-type": "image/png",
      "x-sage-artifact-name": "sage-showcase.png",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readBoundedJson(response);
  if (
    !response.ok ||
    typeof payload?.file_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.file_id
    )
  ) {
    throw Object.assign(new Error("artifact upload failed"), { status: 502 });
  }
  return payload.file_id.toLowerCase();
}

export function showcaseEvents(fileId, responseId) {
  const imageTool = {
    approval_request_id: "showcase-tool-1",
    arguments: '{"fixture":"image"}',
    id: "showcase-tool-item-1",
    name: "build_showcase_fixture",
    server_label: "SAGE showcase",
  };
  const safetyTool = {
    approval_request_id: "showcase-tool-2",
    arguments: '{"check":"safety"}',
    id: "showcase-tool-item-2",
    name: "verify_showcase_safety",
    server_label: "SAGE showcase",
  };
  return [
    {
      delta: "SAGE_RAW_REASONING_MUST_NOT_RENDER",
      type: "response.reasoning_text.delta",
    },
    {
      delta: "Verified the deterministic Chat response components.",
      item_id: "showcase-reasoning-1",
      summary_index: 0,
      type: "response.reasoning_summary_text.delta",
    },
    {
      item_id: "showcase-reasoning-1",
      summary_index: 0,
      type: "response.reasoning_summary_text.done",
    },
    {
      item: { ...imageTool, arguments: undefined, type: "mcp_call" },
      type: "response.output_item.added",
    },
    {
      arguments: imageTool.arguments,
      item_id: imageTool.id,
      type: "response.mcp_call_arguments.done",
    },
    {
      item: {
        ...imageTool,
        output: "Generated a platform image fixture.",
        status: "completed",
        type: "mcp_call",
      },
      type: "response.output_item.done",
    },
    {
      delta: "Checked tool and output safety boundaries.",
      item_id: "showcase-reasoning-2",
      summary_index: 0,
      type: "response.reasoning_summary_text.delta",
    },
    {
      item_id: "showcase-reasoning-2",
      summary_index: 0,
      type: "response.reasoning_summary_text.done",
    },
    {
      item: { ...safetyTool, arguments: undefined, type: "mcp_call" },
      type: "response.output_item.added",
    },
    {
      delta: '{"check":',
      item_id: safetyTool.id,
      type: "response.mcp_call_arguments.delta",
    },
    {
      delta: '"safety"}',
      item_id: safetyTool.id,
      type: "response.mcp_call_arguments.delta",
    },
    {
      arguments: safetyTool.arguments,
      item_id: safetyTool.id,
      type: "response.mcp_call_arguments.done",
    },
    {
      item_id: safetyTool.id,
      type: "response.mcp_call.failed",
    },
    { file_id: fileId, type: "sage.artifact.file" },
    {
      delta:
        "## SAGE_SHOWCASE_OK\n\n| Capability | Result |\n| --- | --- |\n| Markdown table | Passed |\n| Platform image | Passed |\n\n- Multiple tools preserve their individual states.\n- Reasoning summaries remain bounded and ordered.\n\n```json\n{\"artifact\":\"private\",\"remote_images\":\"blocked\"}\n```\n\n",
      type: "response.output_text.delta",
    },
    {
      delta:
        "Remote Markdown images stay blocked: ![blocked](https://attacker.example/pixel.png)",
      type: "response.output_text.delta",
    },
    { response: { id: responseId }, type: "response.completed" },
  ];
}
