import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ORDINARY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GENERIC_FAILURE_FRAME = `data: ${JSON.stringify({ type: "response.failed" })}\n\n`;

function boundedId(value, name) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 512
  ) {
    throw new TypeError(`${name} must be a trimmed string of 1 to 512 characters`);
  }
  return value;
}

function statePath(value) {
  const candidate = value?.trim() || "./data/agent-state.sqlite";
  if (candidate === ":memory:" || candidate.includes("mode=memory")) {
    throw new Error("in-memory Agent state is not permitted");
  }
  return resolve(candidate);
}

export class SqliteResponseStateStore {
  constructor(path = process.env.AGENT_STATE_DB) {
    this.path = statePath(path);
    mkdirSync(dirname(this.path), { mode: 0o700, recursive: true });
    this.database = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS response_heads (
        conversation_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        provider_response_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        retain_until_ms INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, response_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS response_heads_expiry
        ON response_heads (retain_until_ms);
    `);
    this.lookup = this.database.prepare(`
      SELECT provider_response_id, retain_until_ms
      FROM response_heads
      WHERE conversation_id = ? AND response_id = ?
    `);
    this.upsert = this.database.prepare(`
      INSERT INTO response_heads (
        conversation_id,
        response_id,
        provider_response_id,
        created_at_ms,
        retain_until_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (conversation_id, response_id) DO UPDATE SET
        provider_response_id = excluded.provider_response_id,
        retain_until_ms = MAX(response_heads.retain_until_ms, excluded.retain_until_ms)
    `);
    this.deleteOne = this.database.prepare(`
      DELETE FROM response_heads WHERE conversation_id = ? AND response_id = ?
    `);
    this.deleteExpired = this.database.prepare(`
      DELETE FROM response_heads WHERE retain_until_ms <= ?
    `);
    this.health = this.database.prepare("SELECT 1 AS ready");
  }

  resolve(conversationId, responseId, now = Date.now()) {
    const row = this.lookup.get(
      boundedId(conversationId, "conversationId"),
      boundedId(responseId, "responseId"),
    );
    if (!row) return null;
    if (row.retain_until_ms <= now) {
      this.deleteOne.run(conversationId, responseId);
      return null;
    }
    return row.provider_response_id;
  }

  record({
    conversationId,
    providerResponseId,
    responseId = providerResponseId,
    now = Date.now(),
    retentionMs = ORDINARY_RETENTION_MS,
  }) {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(retentionMs) || retentionMs < ORDINARY_RETENTION_MS) {
      throw new TypeError("response retention must be at least 30 days");
    }
    this.deleteExpired.run(now);
    this.upsert.run(
      boundedId(conversationId, "conversationId"),
      boundedId(responseId, "responseId"),
      boundedId(providerResponseId, "providerResponseId"),
      now,
      now + retentionMs,
    );
  }

  prune(now = Date.now()) {
    this.deleteExpired.run(now);
  }

  ready() {
    return this.health.get()?.ready === 1;
  }

  close() {
    this.database.close();
  }
}

export class DurableResponseStreamGate {
  constructor(maxFrameCharacters = 256_000) {
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.createdId = null;
    this.terminalFrame = null;
    this.terminalSuffix = [];
    this.terminalState = "open";
    this.completedResponseId = null;
    this.maxFrameCharacters = maxFrameCharacters;
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.#consume();
  }

  finish() {
    this.buffer += this.decoder.decode();
    const outputFrames = this.#consume(true);
    return {
      completedResponseId: this.completedResponseId,
      outputFrames,
      terminalFrames: this.terminalFrame
        ? [this.terminalFrame, ...this.terminalSuffix]
        : [],
    };
  }

  #consume(final = false) {
    const output = [];
    this.buffer = this.buffer.replaceAll("\r\n", "\n");
    while (true) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      output.push(...this.#accept(frame));
    }
    if (this.buffer.length > this.maxFrameCharacters) {
      throw new Error("upstream SSE frame is too large");
    }
    if (final && this.buffer.trim()) output.push(...this.#accept(this.buffer));
    if (final) this.buffer = "";
    return output;
  }

  #accept(frame) {
    if (frame.length > this.maxFrameCharacters) {
      throw new Error("upstream SSE frame is too large");
    }
    const serialized = `${frame}\n\n`;
    const eventNames = frame
      .split("\n")
      .filter((line) => line.startsWith("event:"))
      .map((line) => line.slice(6).trim());
    if (eventNames.length > 1 || eventNames.some((name) => !name)) {
      throw new Error("invalid SSE event field");
    }
    const eventName = eventNames[0] ?? null;
    const failureTypes = new Set(["error", "response.failed", "response.incomplete"]);
    if (eventName && failureTypes.has(eventName)) {
      if (this.terminalState !== "open") {
        throw new Error(`substantive SSE event followed response.${this.terminalState}`);
      }
      this.terminalState = "failed";
      return [GENERIC_FAILURE_FRAME];
    }
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.trim() === "[DONE]") {
      if (eventName) throw new Error("SSE event field is not allowed with [DONE]");
      if (this.terminalState === "open") this.terminalState = "failed";
      if (this.terminalState === "completed") this.terminalSuffix.push(serialized);
      else return [serialized];
      return [];
    }
    if (!data) {
      if (eventName) throw new Error("SSE event field requires JSON data");
      if (this.terminalState === "completed") this.terminalSuffix.push(serialized);
      else return [serialized];
      return [];
    }
    if (this.terminalState !== "open") {
      throw new Error(`substantive SSE event followed response.${this.terminalState}`);
    }
    let event;
    try {
      assertNoDuplicateJsonObjectKeys(data);
      event = JSON.parse(data);
    } catch {
      this.terminalState = "failed";
      throw new Error("SSE data must be valid JSON");
    }
    const dataType = typeof event?.type === "string" ? event.type : null;
    if (!dataType) throw new Error("SSE JSON event requires a non-empty type");
    if (dataType && failureTypes.has(dataType)) {
      this.terminalState = "failed";
      return [GENERIC_FAILURE_FRAME];
    }
    if (eventName && eventName !== dataType) {
      throw new Error("SSE event field does not match data type");
    }
    if (dataType === "response.created") {
      this.createdId = validResponseId(event.response?.id);
      if (!this.createdId) throw new Error("invalid response.created ID");
    } else if (dataType === "response.completed") {
      const completedId = validResponseId(event.response?.id);
      if (!completedId || (this.createdId && this.createdId !== completedId)) {
        throw new Error("invalid response.completed ID");
      }
      this.completedResponseId = completedId;
      this.terminalFrame = serialized;
      this.terminalState = "completed";
      return [];
    }
    return [serialized];
  }
}

function assertNoDuplicateJsonObjectKeys(source) {
  const containers = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      containers.push(new Set());
      continue;
    }
    if (character === "[") {
      containers.push(null);
      continue;
    }
    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }
    if (character !== '"') continue;

    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === '"') break;
      index += 1;
    }
    let next = index + 1;
    while (next < source.length && /\s/u.test(source[next])) next += 1;
    if (source[next] !== ":") continue;

    const keys = containers.at(-1);
    if (!(keys instanceof Set)) continue;
    const key = JSON.parse(source.slice(start, index + 1));
    if (keys.has(key)) throw new Error("duplicate JSON object key");
    keys.add(key);
  }
}

export function commitThenReleaseTerminal({
  completion,
  conversationId,
  state,
  write,
}) {
  if (completion.completedResponseId) {
    state.record({
      conversationId,
      providerResponseId: completion.completedResponseId,
    });
  }
  for (const frame of completion.terminalFrames) write(frame);
}

function validResponseId(value) {
  return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 512
    ? value
    : null;
}
