import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commitThenReleaseTerminal,
  DurableResponseStreamGate,
  ORDINARY_RETENTION_MS,
  SqliteResponseStateStore,
} from "../../node/state-store.mjs";

const conversation = "11111111-1111-4111-8111-111111111111";

test("SQLite response state survives restart and remains conversation scoped", () => {
  const directory = mkdtempSync(join(tmpdir(), "sage-agent-state-"));
  const path = join(directory, "state.sqlite");
  try {
    const first = new SqliteResponseStateStore(path);
    first.record({
      conversationId: conversation,
      providerResponseId: "resp-provider-1",
    });
    first.close();

    const restarted = new SqliteResponseStateStore(path);
    assert.equal(restarted.resolve(conversation, "resp-provider-1"), "resp-provider-1");
    assert.equal(
      restarted.resolve("22222222-2222-4222-8222-222222222222", "resp-provider-1"),
      null,
    );
    restarted.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("SQLite response state rejects memory and expires explicitly", () => {
  assert.throws(() => new SqliteResponseStateStore(":memory:"), /in-memory/);
  const directory = mkdtempSync(join(tmpdir(), "sage-agent-state-"));
  try {
    const store = new SqliteResponseStateStore(join(directory, "state.sqlite"));
    const now = 1_800_000_000_000;
    store.record({
      conversationId: conversation,
      now,
      providerResponseId: "resp-expiring",
      retentionMs: ORDINARY_RETENTION_MS,
    });
    assert.equal(store.resolve(conversation, "resp-expiring", now), "resp-expiring");
    assert.equal(store.resolve(conversation, "resp-expiring", now + ORDINARY_RETENTION_MS), null);
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("stream gate withholds completion until state is durably recorded", () => {
  const gate = new DurableResponseStreamGate();
  const stream = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp-1" } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-1" } })}\n\n`,
  ].join("");
  const output = [
    ...gate.push(Buffer.from(stream.slice(0, 41))),
    ...gate.push(Buffer.from(stream.slice(41))),
  ];
  assert.equal(output.some((frame) => frame.includes("response.completed")), false);
  const completion = gate.finish();
  assert.equal(completion.completedResponseId, "resp-1");
  assert.equal(completion.streamOutcome, "completed");

  const order = [];
  commitThenReleaseTerminal({
    completion,
    conversationId: conversation,
    state: { record: () => order.push("record") },
    write: () => order.push("terminal"),
  });
  assert.deepEqual(order, ["record", "terminal"]);

  const releasedAfterFailure = [];
  assert.throws(
    () => commitThenReleaseTerminal({
      completion,
      conversationId: conversation,
      state: { record: () => { throw new Error("disk unavailable"); } },
      write: (frame) => releasedAfterFailure.push(frame),
    }),
    /disk unavailable/,
  );
  assert.deepEqual(releasedAfterFailure, []);

  const failed = new DurableResponseStreamGate();
  failed.push(Buffer.from(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp-2" } })}\n\n`));
  const failedOutput = failed.push(Buffer.from(`data: ${JSON.stringify({
    type: "response.failed",
    error: { message: "secret at https://internal.example.invalid" },
  })}\n\n`));
  assert.equal(failedOutput.some((frame) => frame.includes("response.failed")), true);
  assert.equal(failedOutput.some((frame) => frame.includes("secret")), false);
  assert.equal(failedOutput.some((frame) => frame.includes("internal.example")), false);
  assert.throws(
    () => failed.push(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-2" } })}\n\n`)),
    /followed response.failed/,
  );
  assert.equal(failed.finish().completedResponseId, null);
  assert.equal(failed.finish().streamOutcome, "failed");
  const failedRelease = [];
  commitThenReleaseTerminal({
    completion: failed.finish(),
    conversationId: conversation,
    state: { record: () => { throw new Error("must not record"); } },
    write: (frame) => failedRelease.push(frame),
  });
  assert.deepEqual(failedRelease, []);

  const headerFailure = new DurableResponseStreamGate();
  const sanitizedHeaderFailure = headerFailure.push(Buffer.from(
    "event: response.failed\ndata: {\"message\":\"secret at https://internal.example.invalid\"}\n\n",
  ));
  assert.equal(sanitizedHeaderFailure.some((frame) => frame.includes("secret")), false);
  assert.equal(sanitizedHeaderFailure.some((frame) => frame.includes("response.failed")), true);
  const emptyHeaderFailure = new DurableResponseStreamGate();
  assert.equal(
    emptyHeaderFailure.push(Buffer.from("event: response.failed\ndata: [DONE]\n\n"))[0],
    `data: ${JSON.stringify({ type: "response.failed" })}\n\n`,
  );
  assert.throws(
    () => emptyHeaderFailure.push(Buffer.from(
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-late\"}}\n\n",
    )),
    /followed response.failed/,
  );
  assert.throws(
    () => new DurableResponseStreamGate().push(Buffer.from(
      "event: response.completed\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n",
    )),
    /does not match/,
  );
  assert.throws(
    () => new DurableResponseStreamGate().push(Buffer.from(
      "event: response.completed\ndata: [DONE] \n\n",
    )),
    /not allowed with \[DONE\]/,
  );
  assert.throws(
    () => new DurableResponseStreamGate().push(Buffer.from(
      "data: {\"error\":{\"message\":\"secret at https://internal.example.invalid\"}}\n\n",
    )),
    /non-empty type/,
  );

  const duplicateType = new DurableResponseStreamGate();
  assert.throws(
    () => duplicateType.push(Buffer.from(
      "data: {\"type\":\"response.failed\",\"type\":\"response.output_text.delta\",\"delta\":\"secret at https://internal.example.invalid\"}\n\n",
    )),
    /valid JSON/,
  );
  assert.throws(
    () => duplicateType.push(Buffer.from(
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-late\"}}\n\n",
    )),
    /followed response.failed/,
  );

  const earlyDone = new DurableResponseStreamGate();
  earlyDone.push(Buffer.from("data: [DONE]\n\n"));
  assert.throws(
    () => earlyDone.push(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-late" } })}\n\n`)),
    /followed response.failed/,
  );
  assert.equal(earlyDone.finish().completedResponseId, null);
  assert.equal(earlyDone.finish().streamOutcome, "failed");

  const noTerminal = new DurableResponseStreamGate();
  noTerminal.push(Buffer.from(`data: ${JSON.stringify({
    type: "response.output_text.delta",
    delta: "partial",
  })}\n\n`));
  assert.equal(noTerminal.finish().streamOutcome, "incomplete");
});
