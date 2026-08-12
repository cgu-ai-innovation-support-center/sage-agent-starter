import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const doctor = fileURLToPath(new URL("../../scripts/doctor.mjs", import.meta.url));

test("doctor treats a configured model alias as locally configured but SAGE/Budget-unverified", () => {
  const result = spawnSync(process.execPath, [doctor], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_ARTIFACT_URL: "",
      AGENT_INVOCATION_KEY: "d".repeat(32),
      AGENT_MODEL: "sage-managed-model-alias",
      AGENT_STATE_DB: "./data/agent-state.sqlite",
      SAGE_PLATFORM_ORIGIN: "https://sage.example.edu",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /WARN  Agent model alias is configured locally; SAGE and the selected Budget have not verified access/,
  );
  assert.doesNotMatch(result.stdout, /PASS  Agent model alias/);
});
