// Real Kova + OCM report-path proof; the OpenClaw package and registry are fixtures.
// Run: node tests/report-identity-ocm.mjs <output-directory>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

const output = resolve(process.argv[2] ?? "artifacts/report-identity-proof");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, "fixture-"));
const version = "2026.7.1-2";
const decoyDigest = `sha512-${Buffer.alloc(64, 0x42).toString("base64")}`;
const archive = await packageFixture();
const digest = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
let published = false;
let origin;
const server = createServer((req, res) => {
  if (req.url === "/openclaw.tgz") return res.end(archive);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(published ? {
    "dist-tags": { latest: version },
    versions: { [version]: { version, dist: { tarball: `${origin}/openclaw.tgz`, integrity: digest } } },
    time: { [version]: "2026-07-01T00:00:00Z" }
  } : { "dist-tags": {}, versions: {} }));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${server.address().port}`;
const env = {
  ...process.env,
  OCM_HOME: join(root, "ocm"),
  KOVA_HOME: join(root, "kova"),
  OCM_INTERNAL_OPENCLAW_RELEASES_URL: `${origin}/openclaw`,
  // This proof stops after binding; no actual service is launched.
  OCM_INTERNAL_SERVICE_MANAGER: "unsupported",
  npm_config_cache: join(root, "npm-cache")
};
const cases = [];
try {
  await mkdir(join(env.OCM_HOME, "runtimes"), { recursive: true });
  await writeFile(join(env.OCM_HOME, "runtimes/unrelated-simulation-runtime.json"), JSON.stringify({
    kind: "runtime", name: "unrelated-simulation-runtime", binaryPath: join(root, "nonexistent-runtime/openclaw.mjs"),
    sourceKind: "installed", sourceIntegrity: decoyDigest, releaseVersion: version,
    releaseSelectorKind: "version", releaseSelectorValue: version,
    description: "synthetic fixture: never installed or executed",
    createdAt: "2026-08-28T00:00:00Z", updatedAt: "2026-08-28T00:00:00Z"
  }));
  const inventory = JSON.parse(await run("ocm", ["runtime", "list", "--json"]));
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].sourceIntegrity, decoyDigest);
  for (const matrix of [false, true]) await checkRun(matrix, false);
  published = true;
  for (const matrix of [false, true]) await checkRun(matrix, true);
  const runtimes = JSON.parse(await run("ocm", ["runtime", "list", "--json"]));
  assert.equal(runtimes.length, 2, "bound candidate and unrelated same-version runtime coexist");
  for (const runtime of runtimes) await run("ocm", ["runtime", "remove", runtime.name, "--json"]);
  assert.deepEqual(JSON.parse(await run("ocm", ["env", "list", "--json"])), []);
  assert.deepEqual(JSON.parse(await run("ocm", ["runtime", "list", "--json"])), []);
  const summary = { fixtureOnly: true, ocmVersion: (await run("ocm", ["--version"])).trim(), expectedBoundDigest: digest, decoyDigest, cases, cleanup: "env and runtime inventories empty" };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((done) => server.close(done));
  // Only this fixture owns these stores; retained reports and bundles live outside them.
  await rm(root, { recursive: true, force: true });
}

async function checkRun(matrix, bound) {
  const label = `${matrix ? "matrix" : "run"}-${bound ? "bound" : "failed"}`;
  const scenario = bound ? "fresh-install" : "release-runtime-startup";
  const command = matrix ? ["matrix", "run", "--profile", bound ? "smoke" : "release", "--include", `scenario:${scenario}`] : ["run", "--scenario", scenario];
  const stdout = await run(process.execPath, ["bin/kova.mjs", ...command, "--target", `npm:${version}`, "--auth", "skip", "--execute", "--timeout-ms", "20000", "--report-dir", output, "--json"]);
  const receipt = JSON.parse(stdout);
  await writeFile(join(output, `${label}-receipt.json`), stdout);
  const report = JSON.parse(await readFile(receipt.jsonPath, "utf8"));
  const bundle = receipt.bundlePath ? { outputPath: receipt.bundlePath } : JSON.parse(await run(process.execPath, ["bin/kova.mjs", "report", "bundle", receipt.jsonPath, "--output-dir", output, "--json"]));
  const names = execFileSync("tar", ["-tzf", bundle.outputPath], { encoding: "utf8" }).split("\n");
  const manifestName = names.find((name) => name.endsWith("/manifest.json"));
  assert.ok(manifestName);
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", bundle.outputPath, manifestName], { encoding: "utf8" }));
  assert.equal(report.records.length, 1);
  const record = report.records[0];
  const first = record.phases[0].results[0];
  assert.equal(first.status, bound ? 0 : 1, first.stderr);
  if (!bound) {
    assert.equal(report.summary.statuses.BLOCKED, 1);
    assert.match(first.stderr, /does not contain any published versions/);
  }
  for (const value of [receipt, report, manifest, record]) {
    if (bound) assert.equal(value.targetIdentity?.npmIntegrity, digest);
    else assert.equal(Object.hasOwn(value, "targetIdentity"), false);
  }
  assert.deepEqual(receipt.targetIdentity, report.targetIdentity);
  assert.deepEqual(manifest.targetIdentity, report.targetIdentity);
  assert.deepEqual(JSON.parse(await run("ocm", ["env", "list", "--json"])), []);
  cases.push({ label, status: record.status, bindingStatus: first.status, identity: receipt.targetIdentity ?? null, cleanup: record.cleanup, reportPath: receipt.jsonPath, bundlePath: bundle.outputPath, firstCommandFailure: first.stderr.trim() });
  console.log(`PASS ${label}: ${bound ? "exact bound digest survives cleanup" : "no identity claim"}`);
}

function run(program, args) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? done(stdout) : reject(new Error(`${program} ${args.join(" ")}: ${stderr || stdout}`)));
  });
}

async function packageFixture() {
  const pack = tar.pack();
  const chunks = [];
  const complete = new Promise((done, reject) => {
    pack.on("data", (chunk) => chunks.push(chunk));
    pack.once("end", done);
    pack.once("error", reject);
  });
  const script = `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`;
  pack.entry({ name: "package/openclaw.mjs", mode: 0o755, mtime: new Date(0) }, script);
  pack.entry({ name: "package/package.json", mode: 0o644, mtime: new Date(0) }, JSON.stringify({ name: "openclaw", version, bin: { openclaw: "openclaw.mjs" } }));
  pack.finalize();
  await complete;
  return gzipSync(Buffer.concat(chunks));
}
