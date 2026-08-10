import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentProfile } from "../../node/agent-profile.mjs";
import { buildProviderRequest } from "../../node/provider-request.mjs";

const root = new URL("../../", import.meta.url);

test("loads the bounded fixed-path minimal tutor profile", () => {
  const profile = loadAgentProfile();
  assert.equal(profile.id, "minimal-course-tutor");
  assert.match(profile.instructions, /no files,[\s\S]*external data/i);
});

test("rejects profile path drift, extra keys, and instruction symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "sage-agent-profile-"));
  try {
    cpSync(new URL("../../agent/", import.meta.url), directory, { recursive: true });
    const profilePath = join(directory, "profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    writeFileSync(profilePath, JSON.stringify({ ...profile, extra: true }));
    assert.throws(() => loadAgentProfile(directory), /contain exactly/);
    writeFileSync(profilePath, JSON.stringify(profile));
    rmSync(join(directory, "instructions.md"));
    symlinkSync(new URL("../../agent/instructions.md", import.meta.url), join(directory, "instructions.md"));
    assert.throws(() => loadAgentProfile(directory), /inside the fixed agent directory|non-symlink/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("shared golden request keeps input unchanged and instructions top-level", () => {
  const golden = JSON.parse(readFileSync(new URL("../golden/provider-request.json", import.meta.url)));
  const input = golden.arguments.input;
  const actual = buildProviderRequest({
    input,
    instructions: golden.arguments.instructions,
    model: golden.arguments.model,
    previousResponseId: golden.arguments.previous_response_id,
  });
  assert.deepEqual(actual, golden.expected);
  assert.equal(actual.input, input);
});
