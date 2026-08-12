#!/usr/bin/env node

import { randomUUID, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  chownSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { withExactSourceContext } from "./source-revision.mjs";

const root = realpathSync(new URL("../", import.meta.url));
const TRUST_SCHEMA = "sage-agent-trust-v1";
const TRUST_KEYS = ["base_url", "ca_pem", "schema"];
const DEFAULT_CONFIG_PATH = resolve(root, ".env.https");
const DEFAULT_TRUST_PATH = resolve(root, "sage-agent-trust.json");
const MAX_CA_BYTES = 16_384;
const FALLBACK_NON_ROOT_ID = 10_001;
const DATA_DIRECTORY_MARKER = ".sage-agent-private-https-v1";
const DATA_DIRECTORY_MARKER_CONTENT = "sage-agent-private-https-v1\n";
const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal", "metadata.azure.internal"]);
const BLOCKED_V4_RANGES = [
  [0x00_00_00_00, 8],
  [0x0a_00_00_00, 8],
  [0x64_40_00_00, 10],
  [0x7f_00_00_00, 8],
  [0xa9_fe_00_00, 16],
  [0xac_10_00_00, 12],
  [0xc0_00_00_00, 24],
  [0xc0_00_02_00, 24],
  [0xc0_a8_00_00, 16],
  [0xc6_12_00_00, 15],
  [0xc6_33_64_00, 24],
  [0xcb_00_71_00, 24],
  [0xe0_00_00_00, 4],
  [0xf0_00_00_00, 4],
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function canonicalizeBaseUrl(raw) {
  requireCondition(typeof raw === "string" && raw === raw.trim() && raw.length <= 2_048, "Base URL must be bounded trimmed text");
  requireCondition(Buffer.byteLength(raw, "utf8") === raw.length, "Base URL must use ASCII characters");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Base URL must be a valid URL");
  }
  requireCondition(url.protocol === "https:", "Base URL must use HTTPS");
  requireCondition(Boolean(url.hostname) && !url.username && !url.password, "Base URL must not contain credentials");
  requireCondition(!url.search && !url.hash, "Base URL must not contain a query or fragment");
  requireCondition(url.pathname === "/", "Starter private HTTPS Base URL must not contain a path");
  return url.toString().replace(/\/$/, "");
}

function normalizedHostname(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

function ipv4Number(address) {
  return address
    .split(".")
    .reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function inV4Range(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xff_ff_ff_ff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function expandV6(address) {
  let input = address.toLowerCase().split("%", 1)[0] ?? "";
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const mapped = ipv4Number(input.slice(lastColon + 1));
    input = `${input.slice(0, lastColon)}:${(mapped >>> 16).toString(16)}:${(mapped & 0xff_ff).toString(16)}`;
  }
  const [leftRaw, rightRaw = ""] = input.split("::");
  const left = leftRaw ? leftRaw.split(":").map((word) => Number.parseInt(word, 16)) : [];
  const right = rightRaw ? rightRaw.split(":").map((word) => Number.parseInt(word, 16)) : [];
  return input.includes("::")
    ? [...left, ...new Array(8 - left.length - right.length).fill(0), ...right]
    : left;
}

function isBlockedLiteral(address) {
  const normalized = normalizedHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    const value = ipv4Number(normalized);
    return BLOCKED_V4_RANGES.some(([base, prefix]) => inV4Range(value, base, prefix));
  }
  if (family !== 6) return true;
  const words = expandV6(normalized);
  if (words.length !== 8 || words.some((word) => !Number.isFinite(word))) return true;
  if (
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
  ) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xff_ff) {
    const mapped = `${(words[6] ?? 0) >>> 8}.${(words[6] ?? 0) & 255}.${(words[7] ?? 0) >>> 8}.${(words[7] ?? 0) & 255}`;
    return isBlockedLiteral(mapped);
  }
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  return words.slice(0, 6).every((word) => word === 0) ||
    (first & 0xfe_00) === 0xfc_00 ||
    (first & 0xff_c0) === 0xfe_80 ||
    (first & 0xff_00) === 0xff_00 ||
    first === 0x01_00 ||
    (first === 0x20_01 && second === 0x0d_b8) ||
    (first === 0x20_01 && second < 0x02_00) ||
    first === 0x20_02 ||
    (first === 0x00_64 && second === 0xff_9b);
}

function assertPublicSetupHost(baseUrl) {
  const hostname = normalizedHostname(new URL(baseUrl).hostname);
  requireCondition(
    !BLOCKED_NAMES.has(hostname) &&
      !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".local") &&
      !hostname.endsWith(".internal") &&
      !hostname.endsWith(".home.arpa"),
    "Starter private HTTPS requires a public SAGE-reachable hostname, not a local, internal, or metadata name",
  );
  if (isIP(hostname)) {
    requireCondition(!isBlockedLiteral(hostname), "Starter private HTTPS rejects loopback, private, link-local, unspecified, and reserved literal addresses");
  }
}

async function assertPublicEndpointResolution(baseUrl) {
  const hostname = normalizedHostname(new URL(baseUrl).hostname);
  assertPublicSetupHost(baseUrl);
  if (isIP(hostname)) return;
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Base URL DNS is not configured or cannot be resolved; network reachability is not proven");
  }
  requireCondition(addresses.length > 0, "Base URL DNS returned no addresses; network reachability is not proven");
  requireCondition(addresses.every(({ address }) => !isBlockedLiteral(address)), "Base URL DNS resolves to a loopback, private, link-local, unspecified, or reserved address rejected by SAGE");
}

function validatePublicCa(caPem) {
  requireCondition(typeof caPem === "string", "ca_pem must be text");
  requireCondition(Buffer.byteLength(caPem, "utf8") <= MAX_CA_BYTES, "ca_pem is too large");
  requireCondition(!/PRIVATE KEY/u.test(caPem), "trust material must never contain a private key");
  const certificates = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  requireCondition(certificates.length === 1 && certificates[0].trim() === caPem.trim(), "ca_pem must contain exactly one certificate");
  let certificate;
  try {
    certificate = new X509Certificate(caPem);
  } catch {
    throw new Error("ca_pem must contain a valid X.509 certificate");
  }
  requireCondition(certificate.ca === true, "ca_pem must contain a CA certificate");
  requireCondition(
    certificate.subject === certificate.issuer && certificate.verify(certificate.publicKey),
    "ca_pem must contain a self-signed CA certificate",
  );
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  const now = Date.now();
  requireCondition(Number.isFinite(validFrom) && validFrom <= now, "CA certificate is not valid yet");
  requireCondition(Number.isFinite(validTo) && validTo > now, "CA certificate is expired");
  return certificate;
}

export function buildTrustBundle(baseUrl, caPem) {
  validatePublicCa(caPem);
  return Object.freeze({
    schema: TRUST_SCHEMA,
    base_url: canonicalizeBaseUrl(baseUrl),
    ca_pem: `${caPem.trim()}\n`,
  });
}

export function validateTrustBundle(value, expectedBaseUrl) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), "trust bundle must be an object");
  requireCondition(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(TRUST_KEYS), `trust bundle must contain exactly: ${TRUST_KEYS.join(", ")}`);
  requireCondition(value.schema === TRUST_SCHEMA, "unsupported trust bundle schema");
  const baseUrl = canonicalizeBaseUrl(value.base_url);
  requireCondition(value.base_url === baseUrl, "trust bundle Base URL must be canonical");
  if (expectedBaseUrl) {
    requireCondition(baseUrl === canonicalizeBaseUrl(expectedBaseUrl), "trust bundle Base URL does not match this HTTPS setup");
  }
  const certificate = validatePublicCa(value.ca_pem);
  return { baseUrl, certificate };
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--start") {
      requireCondition(!options.has(key), `duplicate option: ${key}`);
      options.set(key, true);
      continue;
    }
    requireCondition(key.startsWith("--") && index + 1 < argv.length, `invalid option: ${key}`);
    requireCondition(!options.has(key), `duplicate option: ${key}`);
    options.set(key, argv[index + 1]);
    index += 1;
  }
  return options;
}

function assertAllowedOptions(options, allowed) {
  for (const key of options.keys()) {
    requireCondition(allowed.has(key), `unsupported option for this command: ${key}`);
  }
}

function pathOption(value, fallback) {
  if (!value) return fallback;
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function assertNoSymlinkAncestor(path, label) {
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    requireCondition(parent !== existing, `${label} has no existing parent directory`);
    existing = parent;
  }
  requireCondition(
    realpathSync(existing) === existing,
    `${label} must not traverse a symlinked path`,
  );
}

function assertSafeFileTarget(path, label) {
  assertNoSymlinkAncestor(path, label);
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular non-symlink file`);
}

function assertExistingGeneratedConfig(path, expected) {
  if (!existsSync(path)) return;
  const current = parseConfig(path);
  requireCondition(
    current.baseUrl === expected.baseUrl &&
      current.dataDirectory === expected.dataDirectory &&
      current.profile === expected.profile,
    "existing private HTTPS config belongs to a different setup; use a new config/data path",
  );
}

function assertSafeTrustOutput(path, expectedBaseUrl) {
  assertSafeFileTarget(path, "public trust output");
  if (!existsSync(path)) return;
  let current;
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("public trust output already exists and is not a generated trust bundle");
  }
  validateTrustBundle(current, expectedBaseUrl);
}

function atomicWriteFile(path, content, mode) {
  const temporary = resolve(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function runtimeIdentity() {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 1_000;
  const currentGid = typeof process.getgid === "function" ? process.getgid() : 1_000;
  const uid = currentUid === 0 ? FALLBACK_NON_ROOT_ID : currentUid;
  const gid = currentUid === 0 || currentGid === 0 ? uid : currentGid;
  return { currentUid, gid, uid };
}

function assertSafeDataDirectoryScope(dataDirectory) {
  const absolute = resolve(dataDirectory);
  assertNoSymlinkAncestor(absolute, "private HTTPS data directory");
  const filesystemRoot = resolve(absolute, sep);
  const broadSystemPaths = new Set([
    filesystemRoot,
    resolve(filesystemRoot, "Applications"),
    resolve(filesystemRoot, "Library"),
    resolve(filesystemRoot, "System"),
    resolve(filesystemRoot, "Users"),
    resolve(filesystemRoot, "etc"),
    resolve(filesystemRoot, "home"),
    resolve(filesystemRoot, "opt"),
    resolve(filesystemRoot, "srv"),
    resolve(filesystemRoot, "tmp"),
    resolve(filesystemRoot, "usr"),
    resolve(filesystemRoot, "var"),
    resolve(filesystemRoot, "var/tmp"),
  ]);
  requireCondition(
    absolute !== root &&
      absolute !== resolve(process.cwd()) &&
      absolute !== resolve(homedir()) &&
      !broadSystemPaths.has(absolute),
    "private HTTPS data directory must be a dedicated child path, not the repository, home, current, or system directory",
  );
}

function assertDedicatedDataDirectory(dataDirectory) {
  assertSafeDataDirectoryScope(dataDirectory);
  const metadata = lstatSync(dataDirectory);
  requireCondition(metadata.isDirectory() && !metadata.isSymbolicLink(), "private HTTPS data path must be a non-symlink directory");
  const expected = [DATA_DIRECTORY_MARKER, "caddy-config", "caddy-data"];
  requireCondition(
    JSON.stringify(readdirSync(dataDirectory).sort()) === JSON.stringify(expected),
    "private HTTPS data directory must contain only its marker, caddy-data, and caddy-config",
  );
  for (const name of ["caddy-data", "caddy-config"]) {
    const child = lstatSync(resolve(dataDirectory, name));
    requireCondition(child.isDirectory() && !child.isSymbolicLink(), `${name} must be a non-symlink directory`);
  }
  const markerPath = resolve(dataDirectory, DATA_DIRECTORY_MARKER);
  const marker = lstatSync(markerPath);
  requireCondition(marker.isFile() && !marker.isSymbolicLink(), "private HTTPS data marker must be a regular non-symlink file");
  requireCondition(readFileSync(markerPath, "utf8") === DATA_DIRECTORY_MARKER_CONTENT, "private HTTPS data marker is invalid");
}

function assertNoSymlinksInDataDirectory(dataDirectory) {
  let entries = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      requireCondition(entries <= 4_096, "private HTTPS data tree is unexpectedly large");
      const path = resolve(directory, entry.name);
      const metadata = lstatSync(path);
      requireCondition(!metadata.isSymbolicLink(), `private HTTPS data must not contain symlink: ${path}`);
      if (metadata.isDirectory()) visit(path);
    }
  };
  visit(dataDirectory);
}

function prepareDataDirectory(dataDirectory, identity) {
  assertSafeDataDirectoryScope(dataDirectory);
  if (existsSync(dataDirectory)) {
    assertDedicatedDataDirectory(dataDirectory);
  } else {
    mkdirSync(dataDirectory, { mode: 0o700, recursive: true });
    mkdirSync(resolve(dataDirectory, "caddy-data"), { mode: 0o700 });
    mkdirSync(resolve(dataDirectory, "caddy-config"), { mode: 0o700 });
    writeFileSync(resolve(dataDirectory, DATA_DIRECTORY_MARKER), DATA_DIRECTORY_MARKER_CONTENT, { mode: 0o600 });
  }
  assertNoSymlinksInDataDirectory(dataDirectory);
  for (const path of [dataDirectory, resolve(dataDirectory, "caddy-data"), resolve(dataDirectory, "caddy-config")]) {
    chmodSync(path, 0o700);
  }
  const markerPath = resolve(dataDirectory, DATA_DIRECTORY_MARKER);
  chmodSync(markerPath, 0o600);
  if (identity.currentUid === 0) {
    for (const path of [dataDirectory, resolve(dataDirectory, "caddy-data"), resolve(dataDirectory, "caddy-config"), markerPath]) {
      chownSync(path, identity.uid, identity.gid);
    }
  }
}

function parseConfig(path = DEFAULT_CONFIG_PATH) {
  requireCondition(existsSync(path), `${path} does not exist; run https:setup first`);
  const values = new Map();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    requireCondition(separator > 0, "invalid private HTTPS configuration");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    requireCondition(!values.has(key), `duplicate private HTTPS configuration: ${key}`);
    values.set(key, value);
  }
  const expected = [
    "SAGE_AGENT_HTTPS_BASE_URL",
    "SAGE_AGENT_HTTPS_DATA_DIR",
    "SAGE_AGENT_HTTPS_GID",
    "SAGE_AGENT_HTTPS_HOST",
    "SAGE_AGENT_HTTPS_PORT",
    "SAGE_AGENT_HTTPS_PROFILE",
    "SAGE_AGENT_HTTPS_SITE",
    "SAGE_AGENT_HTTPS_UID",
  ];
  requireCondition(JSON.stringify([...values.keys()].sort()) === JSON.stringify(expected), "private HTTPS configuration contains missing or unknown keys");
  const baseUrl = canonicalizeBaseUrl(values.get("SAGE_AGENT_HTTPS_BASE_URL"));
  const profile = values.get("SAGE_AGENT_HTTPS_PROFILE");
  requireCondition(profile === "node" || profile === "fastapi", "private HTTPS profile must be node or fastapi");
  const port = Number(values.get("SAGE_AGENT_HTTPS_PORT"));
  requireCondition(Number.isInteger(port) && port >= 1 && port <= 65_535, "private HTTPS port is invalid");
  const dataDirectory = pathOption(values.get("SAGE_AGENT_HTTPS_DATA_DIR"), resolve(root, "data/https"));
  assertSafeDataDirectoryScope(dataDirectory);
  const url = new URL(baseUrl);
  const siteHost = url.hostname.startsWith("[")
    ? url.hostname
    : url.hostname.includes(":")
      ? `[${url.hostname}]`
      : url.hostname;
  requireCondition(values.get("SAGE_AGENT_HTTPS_HOST") === url.hostname, "private HTTPS host does not match Base URL");
  requireCondition(values.get("SAGE_AGENT_HTTPS_SITE") === `${siteHost}:8443`, "private HTTPS internal site does not match Base URL");
  const uid = Number(values.get("SAGE_AGENT_HTTPS_UID"));
  const gid = Number(values.get("SAGE_AGENT_HTTPS_GID"));
  for (const [key, identifier] of [["SAGE_AGENT_HTTPS_UID", uid], ["SAGE_AGENT_HTTPS_GID", gid]]) {
    requireCondition(Number.isInteger(identifier) && identifier > 0 && identifier <= 2_147_483_647, `${key} must identify a non-root user/group`);
  }
  return { baseUrl, dataDirectory, gid, port, profile, uid };
}

function caPath(dataDirectory) {
  return resolve(dataDirectory, "caddy-data/caddy/pki/authorities/local/root.crt");
}

function assertPrivateMaterialPermissions(dataDirectory, expectedUid) {
  assertDedicatedDataDirectory(dataDirectory);
  const allowedOwners = new Set([
    0,
    expectedUid,
    typeof process.getuid === "function" ? process.getuid() : 0,
  ]);
  let entries = 0;
  let privateKeyCount = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      requireCondition(entries <= 4_096, "private HTTPS data tree is unexpectedly large");
      const path = resolve(directory, entry.name);
      const metadata = lstatSync(path);
      requireCondition(!metadata.isSymbolicLink(), `private HTTPS data must not contain symlink: ${path}`);
      if (metadata.isDirectory()) {
        visit(path);
        continue;
      }
      if (!metadata.isFile() || !entry.name.endsWith(".key")) continue;
      privateKeyCount += 1;
      requireCondition((metadata.mode & 0o077) === 0, `private key must not be group/world accessible: ${path}`);
      requireCondition(allowedOwners.has(metadata.uid), `private key has an unexpected owner: ${path}`);
    }
  };
  visit(dataDirectory);
  const rootKey = resolve(dataDirectory, "caddy-data/caddy/pki/authorities/local/root.key");
  requireCondition(existsSync(rootKey), "Caddy private CA key is missing");
  requireCondition(privateKeyCount >= 1, "Caddy private CA key is missing");
}

function exportTrust({ configPath = DEFAULT_CONFIG_PATH, outputPath = DEFAULT_TRUST_PATH } = {}) {
  const config = parseConfig(configPath);
  assertPrivateMaterialPermissions(config.dataDirectory, config.uid);
  const publicCaPath = caPath(config.dataDirectory);
  requireCondition(existsSync(publicCaPath), `public CA not found at ${publicCaPath}; start the HTTPS profile first`);
  const trust = buildTrustBundle(config.baseUrl, readFileSync(publicCaPath, "utf8"));
  requireCondition(
    outputPath !== config.dataDirectory &&
      !outputPath.startsWith(`${config.dataDirectory}${sep}`),
    "public trust output must stay outside the private HTTPS data directory",
  );
  assertSafeTrustOutput(outputPath, trust.base_url);
  mkdirSync(dirname(outputPath), { recursive: true });
  atomicWriteFile(outputPath, `${JSON.stringify(trust, null, 2)}\n`, 0o644);
  const { certificate } = validateTrustBundle(trust, config.baseUrl);
  process.stdout.write(`Wrote public-only SAGE trust bundle: ${outputPath}\n`);
  process.stdout.write(`CA SHA-256 fingerprint: ${certificate.fingerprint256}\n`);
  return { config, trust };
}

export async function verifyTlsEndpoint(trust, timeoutMs = 10_000, testOptions = {}) {
  const { baseUrl } = validateTrustBundle(trust);
  const target = new URL("/readyz", `${baseUrl}/`);
  const connectHost = testOptions.connectHost?.trim();
  await new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(target, {
      ca: trust.ca_pem,
      ...(connectHost ? {
        headers: { host: target.host },
        hostname: connectHost,
        servername: target.hostname,
      } : {}),
      method: "GET",
      rejectUnauthorized: true,
      timeout: timeoutMs,
    }, (response) => {
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 4_096) request.destroy(new Error("readiness response is too large"));
      });
      response.on("end", () => {
        if (response.statusCode === 204) resolvePromise();
        else rejectPromise(new Error(`HTTPS readiness returned ${response.statusCode ?? "unknown"}`));
      });
    });
    request.once("timeout", () => request.destroy(new Error("HTTPS readiness timed out")));
    request.once("error", rejectPromise);
    request.end();
  });
}

function setup(options) {
  const baseUrl = canonicalizeBaseUrl(options.get("--base-url"));
  assertPublicSetupHost(baseUrl);
  requireCondition(!options.has("--output") || options.get("--start"), "--output requires --start; use https:export for a separate export");
  if (options.get("--start")) {
    requireCondition(existsSync(resolve(root, ".env")), "create the runtime .env before using --start");
  }
  const profile = options.get("--profile");
  requireCondition(profile === "node" || profile === "fastapi", "--profile must be node or fastapi");
  const configPath = pathOption(options.get("--config"), DEFAULT_CONFIG_PATH);
  const dataDirectory = pathOption(options.get("--data-dir"), resolve(root, "data/https"));
  assertSafeFileTarget(configPath, "private HTTPS config");
  requireCondition(
    configPath !== dataDirectory && !configPath.startsWith(`${dataDirectory}${sep}`),
    "private HTTPS config must stay outside its generated data directory",
  );
  const url = new URL(baseUrl);
  const port = Number(url.port || "443");
  const normalizedSiteHost = url.hostname.startsWith("[")
    ? url.hostname
    : url.hostname.includes(":")
      ? `[${url.hostname}]`
      : url.hostname;
  const site = `${normalizedSiteHost}:8443`;
  const identity = runtimeIdentity();
  assertExistingGeneratedConfig(configPath, { baseUrl, dataDirectory, profile });
  prepareDataDirectory(dataDirectory, identity);
  const { gid, uid } = identity;
  const relativeData = dataDirectory.startsWith(`${root}/`)
    ? `./${dataDirectory.slice(root.length + 1)}`
    : dataDirectory;
  const content = [
    `SAGE_AGENT_HTTPS_BASE_URL=${baseUrl}`,
    `SAGE_AGENT_HTTPS_DATA_DIR=${relativeData}`,
    `SAGE_AGENT_HTTPS_GID=${gid}`,
    `SAGE_AGENT_HTTPS_HOST=${url.hostname}`,
    `SAGE_AGENT_HTTPS_PORT=${port}`,
    `SAGE_AGENT_HTTPS_PROFILE=${profile}`,
    `SAGE_AGENT_HTTPS_SITE=${site}`,
    `SAGE_AGENT_HTTPS_UID=${uid}`,
    "",
  ].join("\n");
  atomicWriteFile(configPath, content, 0o600);
  process.stdout.write(`Configured ${profile} private HTTPS for ${baseUrl}.\n`);
  process.stdout.write(`Private CA data stays in ${dataDirectory}.\n`);

  if (options.get("--start")) {
    withExactSourceContext(root, ({ context, revision }) => {
      const result = spawnSync("docker", [
        "compose",
        "-f",
        join(context, "compose.yaml"),
        "--project-directory",
        root,
        "--env-file",
        configPath,
        "--profile",
        `${profile}-https`,
        "up",
        "-d",
        "--build",
      ], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SAGE_AGENT_BUILD_CONTEXT: context,
          SAGE_AGENT_ENV_FILE: resolve(root, ".env"),
          SAGE_AGENT_HTTPS_DATA_DIR: dataDirectory,
          SAGE_AGENT_SOURCE_REVISION: revision,
        },
        stdio: "inherit",
      });
      requireCondition(result.status === 0, "Docker Compose private HTTPS startup failed");
    });
    const publicCaPath = caPath(dataDirectory);
    const deadline = Date.now() + 60_000;
    while (!existsSync(publicCaPath) && Date.now() < deadline) {
      spawnSync("sleep", ["1"]);
    }
    requireCondition(existsSync(publicCaPath), "Caddy did not create its public CA before the deadline");
    exportTrust({ configPath, outputPath: pathOption(options.get("--output"), DEFAULT_TRUST_PATH) });
  } else {
    process.stdout.write("Commit the intended source, then rerun this setup command with --start.\n");
    process.stdout.write("Then run npm run https:export and npm run https:doctor.\n");
  }
}

async function main() {
  const [command, ...rawOptions] = process.argv.slice(2);
  const options = parseArgs(rawOptions);
  if (command === "setup") {
    assertAllowedOptions(options, new Set(["--base-url", "--config", "--data-dir", "--output", "--profile", "--start"]));
    setup(options);
    return;
  }
  if (command === "export") {
    assertAllowedOptions(options, new Set(["--config", "--output"]));
    exportTrust({
      configPath: pathOption(options.get("--config"), DEFAULT_CONFIG_PATH),
      outputPath: pathOption(options.get("--output"), DEFAULT_TRUST_PATH),
    });
    return;
  }
  if (command === "doctor") {
    assertAllowedOptions(options, new Set(["--config", "--trust"]));
    const configPath = pathOption(options.get("--config"), DEFAULT_CONFIG_PATH);
    const trustPath = pathOption(options.get("--trust"), DEFAULT_TRUST_PATH);
    const config = parseConfig(configPath);
    assertPrivateMaterialPermissions(config.dataDirectory, config.uid);
    const trust = JSON.parse(readFileSync(trustPath, "utf8"));
    const { certificate } = validateTrustBundle(trust, config.baseUrl);
    process.stdout.write(`PASS  public trust bundle (${certificate.fingerprint256})\n`);
    await assertPublicEndpointResolution(config.baseUrl);
    process.stdout.write("PASS  Base URL DNS/literal address passes the public-routing precheck\n");
    await verifyTlsEndpoint(trust);
    process.stdout.write(`PASS  verified private-CA TLS and /readyz at ${config.baseUrl}\n`);
    process.stdout.write("NOTE  TLS trust does not grant private-network reachability in SAGE.\n");
    return;
  }
  throw new Error("usage: https-kit.mjs setup|export|doctor [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Private HTTPS error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
