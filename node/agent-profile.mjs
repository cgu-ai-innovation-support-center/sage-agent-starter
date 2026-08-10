import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AGENT_DIRECTORY = fileURLToPath(new URL("../agent/", import.meta.url));
const MAX_PROFILE_BYTES = 4_096;
const MAX_INSTRUCTIONS_BYTES = 32_768;
const PROFILE_KEYS = ["display_name", "id", "instructions_file", "schema"];

function readFixedFile(path, maximum, label, root) {
  const absolute = resolve(path);
  const realRoot = realpathSync(root);
  const realPath = realpathSync(absolute);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`${label} must stay inside the fixed agent directory`);
  }
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.size < 1 || metadata.size > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} bytes`);
  }
  const bytes = readFileSync(absolute);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}
function exactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function loadAgentProfile(agentDirectory = DEFAULT_AGENT_DIRECTORY) {
  const root = resolve(agentDirectory);
  const profilePath = resolve(root, "profile.json");
  let profile;
  try {
    profile = JSON.parse(readFixedFile(profilePath, MAX_PROFILE_BYTES, "agent profile", root));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("agent profile must be valid JSON");
    throw error;
  }
  if (!exactKeys(profile, PROFILE_KEYS)) {
    throw new Error(`agent profile must contain exactly: ${PROFILE_KEYS.join(", ")}`);
  }
  if (profile.schema !== "sage-agent-profile-v1") {
    throw new Error("unsupported agent profile schema");
  }
  if (typeof profile.id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(profile.id)) {
    throw new Error("agent profile id must be a bounded lowercase slug");
  }
  if (
    typeof profile.display_name !== "string" ||
    profile.display_name !== profile.display_name.trim() ||
    profile.display_name.length < 1 ||
    profile.display_name.length > 120
  ) {
    throw new Error("agent profile display_name must contain 1 to 120 characters");
  }
  if (profile.instructions_file !== "instructions.md") {
    throw new Error("agent profile instructions_file must be exactly instructions.md");
  }
  const instructionsPath = resolve(dirname(profilePath), "instructions.md");
  const instructions = readFixedFile(
    instructionsPath,
    MAX_INSTRUCTIONS_BYTES,
    "agent instructions",
    root,
  ).trim();
  if (!instructions || instructions.includes("\0")) {
    throw new Error("agent instructions must contain bounded text without NUL bytes");
  }
  return Object.freeze({
    displayName: profile.display_name,
    id: profile.id,
    instructions,
  });
}
