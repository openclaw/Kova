import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { atomicJson } from "../support/verify/background.mjs";
import { executePausedFixture, inspectFixtureTarget, parseFixtureArgs, stageSessionStoreFixtureMain } from "../support/verify/stage-session-store-fixture.mjs";

const suffixes = ["", "-wal", "-shm", "-journal"];

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kova-fixture-forms-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, ".openclaw", "agents", "main", "agent");
  await mkdir(join(agentDir, "fixtures"), { recursive: true });
  const configPath = join(root, ".openclaw", "openclaw.json"), db = join(agentDir, "openclaw-agent.sqlite"), staged = join(agentDir, "fixtures", "corrupt.sqlite");
  await atomicJson(configPath, {});
  for (const suffix of suffixes) {
    await writeFile(`${db}${suffix}`, `original${suffix}`);
    await writeFile(`${staged}${suffix}`, `fixture${suffix}`);
  }
  const handle = join(root, "gateway.json"), out = join(root, "swap.json"), env = "kova-run-fixture-receipt";
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), entry: "foreground-gateway-start", method: "gateway.start", env, handlePath: handle, directory: `${handle}.d`, expiresAt: new Date(Date.now() + 120000).toISOString() };
  const runtime = { root, configPath, gatewayPort: 18789 };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  await atomicJson(handle, { entry: operation.entry, ref: { ...runtime, id: operation.id, directory: operation.directory } });
  const args = ["--env", env, "--agent", "main", "--gateway-handle", handle, "--fixture", staged, "--out", out];
  const restoreArgs = ["--env", env, "--agent", "main", "--gateway-handle", handle, "--restore", "--from", out];
  const options = parseFixtureArgs(args);
  const doctor = async () => {
    const movedFiles = [];
    // Match the native report's arbitrary move order; output must use role order.
    for (const suffix of [...suffixes].reverse()) {
      const destination = `${db}${suffix}.corrupt-123456789.2`;
      await rename(`${db}${suffix}`, destination);
      movedFiles.push(destination);
    }
    return { status: 0, stdout: JSON.stringify({ mode: "recover", targets: [{ agentId: "main", sqlitePath: db, corruptRecovery: { movedFiles, skippedFiles: [] } }] }), stderr: "" };
  };
  const request = async (input) => {
    const result = await executePausedFixture(input, runtime, { doctor });
    if (result.exitCode === 0) result.output.started = true;
    return result;
  };
  return { root, db, staged, handle, out, runtime, operation, args, restoreArgs, options, doctor, request };
}

test("fixture parser accepts retained receipt forms and preserves unbound restoration", () => {
  const prefix = ["--env", "kova-run-fixture", "--agent", "main", "--gateway-handle", "gateway.json"];
  assert.equal(parseFixtureArgs([...prefix, "--fixture", "corrupt.sqlite", "--out", "swap.json"]).out.endsWith("swap.json"), true);
  assert.equal(parseFixtureArgs([...prefix, "--restore", "--from", "swap.json"]).from.endsWith("swap.json"), true);
  assert.equal(parseFixtureArgs([...prefix, "--restore"]).restore, true);
  for (const flags of [["--fixture", "corrupt.sqlite", "--from", "swap.json"], ["--restore", "--out", "swap.json"], ["--restore", "--from="]]) assert.throws(() => parseFixtureArgs([...prefix, ...flags]));
});

test("successful swap publishes a bound receipt and new native quarantine basenames in role order", async (t) => {
  const f = await fixture(t);
  await writeFile(`${f.db}.corrupt-1`, "preexisting quarantine");
  const swapped = await stageSessionStoreFixtureMain(f.args, { request: f.request });
  assert.equal(swapped.exitCode, 0, swapped.output.error);
  assert.deepEqual(swapped.output.createdIds, suffixes.map((suffix) => `${basename(f.db)}${suffix}.corrupt-123456789.2`));
  assert.deepEqual(JSON.parse(await readFile(f.out, "utf8")), swapped.output);
  assert.equal(swapped.output.staged.receipt.gatewayId, f.operation.id);
  assert.equal(swapped.output.staged.receipt.gatewayHandle, f.handle);
  for (const suffix of suffixes) assert.equal(await readFile(`${f.db}${suffix}.corrupt-123456789.2`, "utf8"), `fixture${suffix}`);
  const restored = await stageSessionStoreFixtureMain(f.restoreArgs, { request: f.request });
  assert.equal(restored.exitCode, 0, restored.output.error);
  assert.deepEqual(restored.output.createdIds, []);
  for (const suffix of suffixes) assert.equal(await readFile(`${f.db}${suffix}`, "utf8"), `original${suffix}`);
  assert.equal(await readFile(`${f.db}.corrupt-1`, "utf8"), "preexisting quarantine");
});

for (const variant of ["error", "not-started", "restored", "swap-id", "gateway-id", "agent", "path"]) test(`receipt restoration rejects ${variant} before modifying the original backup`, async (t) => {
  const f = await fixture(t);
  const swapped = await stageSessionStoreFixtureMain(f.args, { request: f.request });
  assert.equal(swapped.exitCode, 0);
  const source = structuredClone(swapped.output);
  if (variant === "error") source.error = "failed";
  if (variant === "not-started") source.started = false;
  if (variant === "restored") source.staged.restored = true;
  if (variant === "swap-id") source.staged.receipt.id = randomUUID();
  if (variant === "gateway-id") source.staged.receipt.gatewayId = randomUUID();
  if (variant === "agent") source.staged.receipt.agent = "other";
  if (variant === "path") source.staged.path = f.staged;
  await atomicJson(f.out, source);
  const result = await stageSessionStoreFixtureMain(f.restoreArgs, { request() { assert.fail("invalid restoration must not reach the Gateway"); } });
  assert.notEqual(result.exitCode, 0);
  assert.equal(await readFile(join(swapped.output.staged.backup, "original"), "utf8"), "original");
});

test("receipt from an earlier swap cannot restore a later backup at the same path", async (t) => {
  const f = await fixture(t);
  const first = await stageSessionStoreFixtureMain(f.args, { request: f.request });
  assert.equal(first.exitCode, 0);
  assert.equal((await stageSessionStoreFixtureMain(f.restoreArgs, { request: f.request })).exitCode, 0);
  // Keep the first receipt and produce a second swap without another collision.
  const second = await executePausedFixture(f.options, f.runtime, { doctor: async () => ({ status: 0, stdout: JSON.stringify({ mode: "recover", targets: [{ agentId: "main", sqlitePath: f.db }] }) }) });
  assert.equal(second.exitCode, 0);
  assert.notEqual(second.output.staged.receipt.id, first.output.staged.receipt.id);
  await assert.rejects(inspectFixtureTarget(parseFixtureArgs(f.restoreArgs), f.runtime), /successful swap/);
  assert.equal(await readFile(join(second.output.staged.backup, "original"), "utf8"), "original");
});

test("existing output is refused before requesting a swap", async (t) => {
  const f = await fixture(t);
  await writeFile(f.out, "occupied");
  const result = await stageSessionStoreFixtureMain(f.args, { request() { assert.fail("output must be admitted before mutation"); } });
  assert.equal(result.exitCode, 2);
  assert.equal(await readFile(f.db, "utf8"), "original");
  assert.equal(await readFile(f.out, "utf8"), "occupied");
});

test("failed Doctor recovery restores originals and withholds the output receipt", async (t) => {
  const f = await fixture(t);
  const result = await stageSessionStoreFixtureMain(f.args, { request: (input) => executePausedFixture(input, f.runtime, { doctor: async () => ({ status: 1, stdout: "", stderr: "refused" }) }) });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.output.staged.restored, true);
  await assert.rejects(readFile(f.out), { code: "ENOENT" });
  assert.equal(await readFile(f.db, "utf8"), "original");
});

for (const failRestore of [false, true]) test(`output publication race ${failRestore ? "reports retained backup" : "restores through the same Gateway"}`, async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const result = await stageSessionStoreFixtureMain(f.args, { request: async (input) => {
    requests++;
    assert.equal(input["gateway-handle"], f.handle);
    if (input.restore && failRestore) throw new Error("synthetic restoration unavailable");
    const value = await f.request(input);
    if (!input.restore) await writeFile(f.out, "occupied after swap");
    return value;
  } });
  assert.notEqual(result.exitCode, 0);
  assert.equal(requests, 2);
  assert.equal(await readFile(f.out, "utf8"), "occupied after swap");
  if (failRestore) {
    assert.match(result.output.error, /restoration incomplete/);
    assert.equal(result.output.staged.restored, false);
    assert.equal(await readFile(join(result.output.staged.backup, "original"), "utf8"), "original");
  } else {
    assert.equal(result.output.staged.restored, true);
    assert.equal(await readFile(f.db, "utf8"), "original");
  }
});

for (const variant of ["missing-report", "foreign-target", "unreported-file", "invented-file"]) test(`quarantine identities reject ${variant}`, async (t) => {
  const f = await fixture(t);
  const result = await executePausedFixture(f.options, f.runtime, { doctor: async () => {
    const result = await f.doctor();
    if (variant === "missing-report") return { ...result, stdout: "not JSON" };
    const report = JSON.parse(result.stdout);
    if (variant === "foreign-target") report.targets[0].agentId = "other";
    if (variant === "unreported-file") report.targets[0].corruptRecovery.movedFiles.pop();
    if (variant === "invented-file") report.targets[0].corruptRecovery.movedFiles.push(`${f.db}.corrupt-absent`);
    return { ...result, stdout: JSON.stringify(report) };
  } });
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(result.output.createdIds, []);
  assert.equal(result.output.staged.restored, true);
  assert.equal(await readFile(f.db, "utf8"), "original");
});

test("reused quarantine files are preserved without generated identities", async (t) => {
  const f = await fixture(t), retained = `${f.db}.corrupt-1`;
  await writeFile(retained, "retained bytes");
  const result = await executePausedFixture(f.options, f.runtime, { doctor: async () => ({ status: 0, stdout: JSON.stringify({ mode: "recover", targets: [{ agentId: "main", sqlitePath: f.db, corruptRecovery: { movedFiles: [retained], skippedFiles: [] } }] }) }) });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.createdIds, []);
  assert.equal(await readFile(retained, "utf8"), "retained bytes");
});

for (const mode of ["out", "from"]) for (const [signal, equals] of [["SIGINT", false], ["SIGTERM", true]]) test(`fixture --${mode} CLI joins restoration and exits 3 on ${signal}`, { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  let savedReceipt;
  if (mode === "from") {
    const swapped = await stageSessionStoreFixtureMain(f.args, { request: f.request });
    assert.equal(swapped.exitCode, 0);
    savedReceipt = await readFile(f.out);
  }
  const args = [...(mode === "out" ? f.args : f.restoreArgs)];
  if (equals) {
    const index = args.indexOf(`--${mode}`);
    args.splice(index, 2, `--${mode}=${args[index + 1]}`);
  }
  const environment = { ...process.env };
  for (const name of ["NODE_OPTIONS", "KOVA_OCM_TRANSPORT_JSON", "KOVA_NETWORK_FRONTAGE_ENABLED"]) delete environment[name];
  const child = spawn(process.execPath, [fileURLToPath(new URL("../support/verify/stage-session-store-fixture.mjs", import.meta.url)), ...args], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => { child.once("error", (error) => resolve({ error })); child.once("close", (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  const waitForRecord = async (path) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.equal(child.exitCode, null, `CLI exited before its mailbox record: ${stderr}`);
      assert.equal(child.signalCode, null);
      assert.ok(Date.now() < deadline, "CLI did not publish its mailbox record");
      await sleep(20);
    }
  };
  const pending = await waitForRecord(join(f.operation.directory, "fixture-request.json"));
  assert.equal(pending.options["gateway-handle"], f.handle);
  if (mode === "out") {
    const swapped = await executePausedFixture(pending.options, f.runtime, { doctor: f.doctor });
    assert.equal(swapped.exitCode, 0);
  }
  assert.equal(child.kill(signal), true);
  await waitForRecord(join(f.operation.directory, `fixture-cancel-${pending.id}.json`));
  await sleep(100);
  assert.equal(child.exitCode, null, "CLI must join restoration before exiting");
  assert.equal(child.signalCode, null);
  const restored = await executePausedFixture({ ...pending.options, fixture: undefined, out: undefined, restore: true }, f.runtime);
  assert.equal(restored.exitCode, 0);
  restored.output.started = true;
  restored.output.error = "fixture request interrupted";
  restored.exitCode = 3;
  await rm(join(f.operation.directory, "fixture-request.json"));
  await atomicJson(join(f.operation.directory, `fixture-result-${pending.id}.json`), { output: restored.output, exitCode: restored.exitCode });
  const ended = await closed;
  assert.equal(ended.error, undefined);
  assert.equal(ended.signal, null);
  assert.equal(ended.code, 3, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.staged.restored, true);
  assert.equal(output.started, true);
  assert.match(output.error, new RegExp(signal));
  for (const suffix of suffixes) assert.equal(await readFile(`${f.db}${suffix}`, "utf8"), `original${suffix}`);
  if (mode === "out") await assert.rejects(readFile(f.out), { code: "ENOENT" });
  else assert.deepEqual(await readFile(f.out), savedReceipt);
  assert.equal(JSON.parse(await readFile(join(f.operation.directory, "operation.json"), "utf8")).id, f.operation.id);
  await assert.rejects(readFile(join(f.operation.directory, "result.json")), { code: "ENOENT" });
});
