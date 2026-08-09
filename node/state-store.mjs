import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ORDINARY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      if (this.terminalState === "completed") this.terminalSuffix.push(serialized);
      else return [serialized];
      return [];
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      if (this.terminalState !== "open") {
        throw new Error(`substantive SSE data followed response.${this.terminalState}`);
      }
      return [serialized];
    }
    if (this.terminalState !== "open") {
      throw new Error(`substantive SSE event followed response.${this.terminalState}`);
    }
    if (event?.type === "response.created") {
      this.createdId = validResponseId(event.response?.id);
      if (!this.createdId) throw new Error("invalid response.created ID");
    } else if (event?.type === "response.completed") {
      const completedId = validResponseId(event.response?.id);
      if (!completedId || (this.createdId && this.createdId !== completedId)) {
        throw new Error("invalid response.completed ID");
      }
      this.completedResponseId = completedId;
      this.terminalFrame = serialized;
      this.terminalState = "completed";
      return [];
    } else if (["error", "response.failed", "response.incomplete"].includes(event?.type)) {
      this.terminalState = "failed";
    }
    return [serialized];
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
