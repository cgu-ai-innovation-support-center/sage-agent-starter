import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTrustBundle,
  canonicalizeBaseUrl,
  validateTrustBundle,
  verifyTlsEndpoint,
} from "../../scripts/https-kit.mjs";

function createCertificateFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sage-private-ca-")));
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const serverKey = join(directory, "server.key");
  const serverCsr = join(directory, "server.csr");
  const serverCert = join(directory, "server.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKey, "-out", caCert, "-days", "2",
    "-subj", "/CN=SAGE Starter Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", serverKey, "-out", serverCsr,
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "x509", "-req", "-in", serverCsr,
    "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
    "-out", serverCert, "-days", "1", "-sha256", "-copy_extensions", "copyall",
  ], { stdio: "ignore" });
  return {
    caCert: readFileSync(caCert, "utf8"),
    caKey: readFileSync(caKey, "utf8"),
    directory,
    serverCert: readFileSync(serverCert, "utf8"),
    serverKey: readFileSync(serverKey, "utf8"),
  };
}

test("trust bundle has the exact public-only schema and canonical Base URL", () => {
  const fixture = createCertificateFixture();
  try {
    const trust = buildTrustBundle("https://agent.example.edu:8443/", fixture.caCert);
    assert.deepEqual(Object.keys(trust), ["schema", "base_url", "ca_pem"]);
    assert.equal(trust.base_url, "https://agent.example.edu:8443");
    assert.equal(JSON.stringify(trust).includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(trust).includes(fixture.caKey.trim()), false);
    validateTrustBundle(trust, "https://agent.example.edu:8443");
    assert.throws(() => validateTrustBundle({ ...trust, fingerprint: "extra" }), /contain exactly/);
    assert.throws(
      () => validateTrustBundle({ ...trust, base_url: "https://other.example.edu" }, trust.base_url),
      /does not match/,
    );
    assert.throws(() => buildTrustBundle(trust.base_url, `${fixture.caCert}\n${fixture.caKey}`), /private key/);
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});

test("Base URL rejects plaintext, credentials, query, fragment, and path drift", () => {
  assert.throws(() => canonicalizeBaseUrl("http://agent.example.edu"), /HTTPS/);
  assert.throws(() => canonicalizeBaseUrl("https://user:pass@agent.example.edu"), /credentials/);
  assert.throws(() => canonicalizeBaseUrl("https://agent.example.edu?token=x"), /query/);
  assert.throws(() => canonicalizeBaseUrl("https://agent.example.edu#fragment"), /fragment/);
  assert.throws(() => canonicalizeBaseUrl("https://agent.example.edu/course"), /must not contain a path/);
  assert.equal(canonicalizeBaseUrl("https://[2001:db8::1]:8443/"), "https://[2001:db8::1]:8443");
});

test("teacher setup rejects protected literals and renders public IPv6 without double brackets", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sage-https-setup-")));
  const script = fileURLToPath(new URL("../../scripts/https-kit.mjs", import.meta.url));
  try {
    const rejected = spawnSync(process.execPath, [
      script,
      "setup",
      "--base-url", "https://localhost:8443",
      "--profile", "node",
      "--config", join(directory, "localhost.env"),
      "--data-dir", join(directory, "localhost-data"),
    ], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /public SAGE-reachable hostname/);

    const internalName = spawnSync(process.execPath, [
      script,
      "setup",
      "--base-url", "https://agent.internal:8443",
      "--profile", "node",
      "--config", join(directory, "internal.env"),
      "--data-dir", join(directory, "internal-data"),
    ], { encoding: "utf8" });
    assert.notEqual(internalName.status, 0);
    assert.match(internalName.stderr, /local, internal, or metadata name/);

    for (const [name, baseUrl] of [
      ["private-v4", `https://${[192, 168, 1, 20].join(".")}:8443`],
      ["reserved-v4", "https://192.0.2.20:8443"],
      ["multicast-v6", "https://[ff02::1]:8443"],
      ["documentation-v6", "https://[2001:db8::1]:8443"],
    ]) {
      const literal = spawnSync(process.execPath, [
        script,
        "setup",
        "--base-url", baseUrl,
        "--profile", "node",
        "--config", join(directory, `${name}.env`),
        "--data-dir", join(directory, `${name}-data`),
      ], { encoding: "utf8" });
      assert.notEqual(literal.status, 0, `${baseUrl} must be rejected`);
      assert.match(literal.stderr, /rejects loopback, private, link-local, unspecified, and reserved/);
    }

    execFileSync(process.execPath, [
      script,
      "setup",
      "--base-url", "https://[2606:4700:4700::1111]:8443",
      "--profile", "node",
      "--config", join(directory, "ipv6.env"),
      "--data-dir", join(directory, "ipv6-data"),
    ], { stdio: "ignore" });
    const config = readFileSync(join(directory, "ipv6.env"), "utf8");
    assert.match(config, /^SAGE_AGENT_HTTPS_SITE=\[2606:4700:4700::1111\]:8443$/m);
    assert.doesNotMatch(config, /\[\[/);
    assert.doesNotMatch(config, /^SAGE_AGENT_HTTPS_(?:UID|GID)=0$/m);
    assert.equal(
      readFileSync(join(directory, "ipv6-data/.sage-agent-private-https-v1"), "utf8"),
      "sage-agent-private-https-v1\n",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("teacher setup refuses broad and pre-existing non-dedicated data directories", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sage-https-scope-")));
  const workingDirectory = join(directory, "working-directory");
  const occupied = join(directory, "occupied");
  const script = fileURLToPath(new URL("../../scripts/https-kit.mjs", import.meta.url));
  try {
    mkdirSync(workingDirectory);
    const broad = spawnSync(process.execPath, [
      script,
      "setup",
      "--base-url", "https://agent.example.edu:8443",
      "--profile", "node",
      "--config", join(directory, "broad.env"),
      "--data-dir", ".",
    ], { cwd: workingDirectory, encoding: "utf8" });
    assert.notEqual(broad.status, 0);
    assert.match(broad.stderr, /dedicated child path/);

    mkdirSync(occupied);
    writeFileSync(join(occupied, "teacher-notes.txt"), "must remain untouched\n");
    const existingMode = lstatSync(occupied).mode & 0o777;
    const preExisting = spawnSync(process.execPath, [
      script,
      "setup",
      "--base-url", "https://agent.example.edu:8443",
      "--profile", "node",
      "--config", join(directory, "occupied.env"),
      "--data-dir", occupied,
    ], { encoding: "utf8" });
    assert.notEqual(preExisting.status, 0);
    assert.match(preExisting.stderr, /must contain only its marker/);
    assert.equal(readFileSync(join(occupied, "teacher-notes.txt"), "utf8"), "must remain untouched\n");
    assert.equal(lstatSync(occupied).mode & 0o777, existingMode);

    const teacherConfig = join(directory, "teacher-notes.env");
    writeFileSync(teacherConfig, "grading notes that must remain untouched\n");
    const configOverwrite = spawnSync(process.execPath, [
      script,
      "setup",
      "--base-url", "https://agent.example.edu:8443",
      "--profile", "node",
      "--config", teacherConfig,
      "--data-dir", join(directory, "config-overwrite-data"),
    ], { encoding: "utf8" });
    assert.notEqual(configOverwrite.status, 0);
    assert.equal(
      readFileSync(teacherConfig, "utf8"),
      "grading notes that must remain untouched\n",
    );

    const ancestorTarget = join(directory, "ancestor-target");
    const ancestorLink = join(directory, "ancestor-link");
    mkdirSync(ancestorTarget);
    symlinkSync(ancestorTarget, ancestorLink);
    const ancestorSymlink = spawnSync(process.execPath, [
      script,
      "setup",
      "--base-url", "https://agent.example.edu:8443",
      "--profile", "node",
      "--config", join(directory, "ancestor.env"),
      "--data-dir", join(ancestorLink, "generated-data"),
    ], { encoding: "utf8" });
    assert.notEqual(ancestorSymlink.status, 0);
    assert.match(ancestorSymlink.stderr, /must not traverse a symlinked path/);
    assert.equal(existsSync(join(ancestorTarget, "generated-data")), false);

    const target = join(directory, "symlink-target");
    const linked = join(directory, "symlink-data");
    mkdirSync(target);
    symlinkSync(target, linked);
    const symlinked = spawnSync(process.execPath, [
      script,
      "setup",
      "--base-url", "https://agent.example.edu:8443",
      "--profile", "node",
      "--config", join(directory, "symlink.env"),
      "--data-dir", linked,
    ], { encoding: "utf8" });
    assert.notEqual(symlinked.status, 0);
    assert.match(
      symlinked.stderr,
      /non-symlink directory|must not traverse a symlinked path/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("export refuses world-readable private key data and emits no private key", () => {
  const fixture = createCertificateFixture();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sage-https-export-")));
  const data = join(directory, "data");
  const authority = join(data, "caddy-data/caddy/pki/authorities/local");
  const configPath = join(directory, "https.env");
  const outputPath = join(directory, "trust.json");
  const script = fileURLToPath(new URL("../../scripts/https-kit.mjs", import.meta.url));
  try {
    mkdirSync(authority, { mode: 0o700, recursive: true });
    mkdirSync(join(data, "caddy-config"), { mode: 0o700 });
    writeFileSync(join(data, ".sage-agent-private-https-v1"), "sage-agent-private-https-v1\n", { mode: 0o600 });
    writeFileSync(join(authority, "root.crt"), fixture.caCert, { mode: 0o644 });
    writeFileSync(join(authority, "root.key"), fixture.caKey, { mode: 0o644 });
    writeFileSync(configPath, [
      "SAGE_AGENT_HTTPS_BASE_URL=https://agent.example.edu:8443",
      `SAGE_AGENT_HTTPS_DATA_DIR=${data}`,
      `SAGE_AGENT_HTTPS_GID=${typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000}`,
      "SAGE_AGENT_HTTPS_HOST=agent.example.edu",
      "SAGE_AGENT_HTTPS_PORT=8443",
      "SAGE_AGENT_HTTPS_PROFILE=node",
      "SAGE_AGENT_HTTPS_SITE=agent.example.edu:8443",
      `SAGE_AGENT_HTTPS_UID=${typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000}`,
      "",
    ].join("\n"));
    const rejected = spawnSync(process.execPath, [
      script, "export", "--config", configPath, "--output", outputPath,
    ], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /group\/world accessible/);

    chmodSync(join(authority, "root.key"), 0o600);
    execFileSync(process.execPath, [
      script, "export", "--config", configPath, "--output", outputPath,
    ], { stdio: "ignore" });
    const trust = readFileSync(outputPath, "utf8");
    assert.equal(trust.includes("PRIVATE KEY"), false);
    assert.deepEqual(Object.keys(JSON.parse(trust)), ["schema", "base_url", "ca_pem"]);

    writeFileSync(outputPath, "teacher notes that must remain untouched\n");
    const outputOverwrite = spawnSync(process.execPath, [
      script, "export", "--config", configPath, "--output", outputPath,
    ], { encoding: "utf8" });
    assert.notEqual(outputOverwrite.status, 0);
    assert.match(outputOverwrite.stderr, /not a generated trust bundle/);
    assert.equal(
      readFileSync(outputPath, "utf8"),
      "teacher notes that must remain untouched\n",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});

test("doctor TLS handshake verifies the exact CA and IP SAN", async () => {
  const fixture = createCertificateFixture();
  const server = createServer({ cert: fixture.serverCert, key: fixture.serverKey }, (request, response) => {
    if (request.url === "/readyz") response.writeHead(204, { "cache-control": "no-store" }).end();
    else response.writeHead(404).end();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const trust = buildTrustBundle(`https://127.0.0.1:${address.port}`, fixture.caCert);
    await verifyTlsEndpoint(trust);
    const wrong = createCertificateFixture();
    try {
      await assert.rejects(
        () => verifyTlsEndpoint(buildTrustBundle(trust.base_url, wrong.caCert)),
        /certificate|issuer|signature|verify/i,
      );
    } finally {
      rmSync(wrong.directory, { force: true, recursive: true });
    }
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});
