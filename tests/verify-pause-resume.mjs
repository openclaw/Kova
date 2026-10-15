import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { atomicJson, CallError } from "../support/verify/background.mjs";
import { gatewayLifecycleMain, isLegacyStoreMigrationDiagnostic, parseGatewayLifecycleArgs, runForegroundGateway } from "../support/verify/gateway-lifecycle.mjs";
import { definition as doctor } from "../support/verify/doctor-repair.mjs";
import { scriptMain } from "../support/verify/script.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();

for (const [name, paths, root, outside] of [
  ["POSIX", posix, "/lab/clone", "/different/clone/sessions.json"],
  ["Win32", win32, "C:\\lab\\clone", "D:\\lab\\clone\\sessions.json"]
]) test(`legacy migration diagnostic uses native ${name} containment`, () => {
  const diagnostic = (file) => `Legacy session store requires migration: ${file}. Run "openclaw doctor --fix" against the same state/config before starting OpenClaw.\n`;
  const store = paths.join(root, ".openclaw", "agents", "main", "sessions", "sessions.json");
  assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic(store), root, paths), true);
  assert.equal(isLegacyStoreMigrationDiagnostic(`Gateway failed to start: ${diagnostic(store).replace("openclaw doctor", "openclaw --profile lab doctor").replace("\n", "\r\n")}`, root, paths), true);
  for (const file of [
    root,
    `${root}-sibling${paths.sep}sessions.json`,
    `${root}${paths.sep}..${paths.sep}other${paths.sep}sessions.json`,
    `${root}${paths.sep}.openclaw${paths.sep}..${paths.sep}..${paths.sep}other${paths.sep}sessions.json`,
    outside,
    paths.join("relative", "sessions.json")
  ]) assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic(file), root, paths), false, file);
  assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic(store).replace("requires migration:", "failed:"), root, paths), false);
  assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic(store).replace(" doctor --fix", " doctor"), root, paths), false);
});

test("Win32 migration containment retains drive and UNC ownership", () => {
  const diagnostic = (file) => `Legacy session store requires migration: ${file}. Run "openclaw doctor --fix" against the same state/config before starting OpenClaw.`;
  assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic("c:\\LAB\\clone\\sessions.json"), "C:\\lab\\clone", win32), true);
  assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic("C:lab\\clone\\sessions.json"), "C:\\lab\\clone", win32), false);
  const root = "\\\\server\\share\\clone";
  assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic(`${root}\\sessions.json`), root, win32), true);
  assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic("\\\\other\\share\\clone\\sessions.json"), root, win32), false);
  assert.equal(isLegacyStoreMigrationDiagnostic(diagnostic("\\\\server\\other-share\\clone\\sessions.json"), root, win32), false);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-pause-"));
  const env = "kova-scripts-pause-test", handlePath = join(root, "gateway.json");
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), entry: "foreground-gateway-start", method: "gateway.start", env, directory: `${handlePath}.d`, handlePath, expiresAt: new Date(Date.now() + 180000).toISOString() };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  const runtime = { root, configPath: join(root, ".openclaw/openclaw.json"), gatewayPort: 19313 };
  const controller = new AbortController();
  const children = [], events = [];
  let mode = "ready", published;
  let refusePort = false;
  const started = new Promise((resolve) => { published = resolve; });
  const running = runForegroundGateway({ env, timeoutMs: 300 }, {
    operation, signal: controller.signal,
    async publish(ref) {
      await atomicJson(handlePath, { entry: operation.entry, env, ref: { id: operation.id, directory: operation.directory, ...ref } });
      published();
    }
  }, {
    prepare: () => runtime,
    requireUnusedPort: async () => { assert.ok(children.every((x) => x.stopped)); if (refusePort) throw new CallError("port occupied", 1); },
    invocation: () => ({ file: "gateway", args: [], env: {} }),
    fetch: async () => ({ ok: mode === "ready", body: { cancel: async () => {} } }),
    connect: async () => ({ client: { close() {}, async request(method, params) {
      schemas.check(method, params);
      assert.equal(method, "config.get");
      return { path: runtime.configPath };
    } } }),
    doctorHelper: async () => {
      assert.ok(children.every((x) => x.stopped));
      events.push("doctor");
      mode = "ready";
      return { status: 0, value: { status: 0, doctorFixSucceeded: true, doctorUnrepairedFindingCount: 0, stdoutSnippet: "repaired" } };
    },
    spawn() {
      const child = { pid: 1000 + children.length, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null };
      const record = { child, stopped: false };
      children.push(record);
      let finish;
      const closed = new Promise((resolve) => { finish = resolve; });
      setImmediate(() => {
        if (mode.startsWith("legacy")) child.stderr.write(`Legacy session store requires migration: ${root}/.openclaw/agents/main/sessions/sessions.json. Run "openclaw doctor --fix" against the same state/config before starting OpenClaw.\n`);
        if (mode === "legacy") { child.exitCode = 78; child.stderr.end(); finish({ status: 78, signal: null }); }
        if (mode === "unrelated" || mode === "legacy-unrelated") { child.exitCode = 1; finish({ status: 1 }); }
      });
      return { child, closed, async stop() {
        if (record.stopped) return;
        record.stopped = true;
        child.exitCode ??= 0;
        child.stdout.end(); child.stderr.end(); finish({ status: child.exitCode });
      } };
    }
  });
  t.after(async () => { controller.abort(new CallError("background operation stopped", 1)); await running; await rm(root, { recursive: true, force: true }); });
  await started;
  const call = (action, extra = []) => gatewayLifecycleMain([action, "--env", env, "--gateway-handle", handlePath, "--timeout", "60000", ...extra]);
  return { root, env, handlePath, operation, children, events, call, setMode(value) { mode = value; }, setPortOccupied(value) { refusePort = value; } };
}

test("pause and resume retain the original owner and operation", async (t) => {
  const f = await fixture(t);
  const paused = await f.call("pause");
  assert.equal(paused.exitCode, 0, JSON.stringify(paused));
  assert.equal(paused.output.result.paused, true);
  assert.ok(f.children.every((x) => x.stopped));
  const again = await f.call("pause");
  assert.equal(again.exitCode, 0);
  assert.equal(f.children.length, 1);
  const resumed = await f.call("resume");
  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.output.result.ready, true);
  assert.notEqual(resumed.output.result.pid, paused.output.result.previousPid);
  const handle = JSON.parse(await readFile(f.handlePath, "utf8"));
  assert.equal(handle.ref.id, f.operation.id);
  assert.equal(handle.ref.ownerPid, process.pid);
  assert.equal(handle.ref.lifecycleState, "running");
  assert.equal((await f.call("resume")).exitCode, 2);
});

test("legacy refusal retains the paused owner for Doctor and healthy restart", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("pause")).exitCode, 0);
  f.setMode("legacy");
  const refused = await f.call("resume", ["--expect-refusal"]);
  assert.equal(refused.exitCode, 0, JSON.stringify(refused));
  assert.equal(refused.output.result.refused, true);
  assert.equal(refused.output.result.paused, true);
  assert.ok(f.children.every((x) => x.stopped));
  const repaired = await scriptMain(doctor, ["--env", f.env, "--gateway-handle", f.handlePath, "--timeout", "60000"]);
  assert.equal(repaired.exitCode, 0, JSON.stringify(repaired));
  assert.equal(repaired.output.repairs.gateway.ready, true);
  assert.deepEqual(f.events, ["doctor"]);
  assert.equal(JSON.parse(await readFile(f.handlePath, "utf8")).ref.id, f.operation.id);
});

for (const [mode, code] of [["ready", 1], ["unrelated", 1], ["timeout", 3], ["legacy-unrelated", 1], ["legacy-alive", 3]]) {
  test(`expected refusal rejects ${mode} and preserves a stopped owner`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.call("pause")).exitCode, 0);
    f.setMode(mode);
    const result = await f.call("resume", ["--expect-refusal"]);
    assert.equal(result.exitCode, code, JSON.stringify(result));
    assert.equal(result.output.result.refused, false);
    assert.equal(result.output.result.paused, true);
    assert.ok(f.children.every((x) => x.stopped));
    f.setMode("ready");
    assert.equal((await f.call("resume")).exitCode, 0);
  });
}

test("refusal evidence cannot carry over from a previous resume", async (t) => {
  const f = await fixture(t);
  await f.call("pause");
  f.setMode("legacy");
  assert.equal((await f.call("resume", ["--expect-refusal"])).exitCode, 0);
  f.setMode("unrelated");
  assert.equal((await f.call("resume", ["--expect-refusal"])).exitCode, 1);
});

test("pause and resume parse only their declared forms", () => {
  const common = ["--env", "kova-scripts-pause-test", "--gateway-handle", "gateway.json", "--timeout", "30000"];
  assert.equal(parseGatewayLifecycleArgs(["pause", ...common]).action, "pause");
  assert.equal(parseGatewayLifecycleArgs(["resume", ...common, "--expect-refusal"])["expect-refusal"], true);
  assert.throws(() => parseGatewayLifecycleArgs(["pause", ...common, "--expect-refusal"]), /unknown flag/);
  assert.throws(() => parseGatewayLifecycleArgs(["resume", "--env", "kova-scripts-pause-test"]), /gateway-handle/);
});

test("pause/resume Gateway requests match pinned schemas", (t) => schemas.report(t));

test("resume preflight failure keeps the paused owner available", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("pause")).exitCode, 0);
  f.setPortOccupied(true);
  const refused = await f.call("resume");
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.output.result.paused, true);
  assert.equal(f.children.length, 1);
  f.setPortOccupied(false);
  assert.equal((await f.call("resume")).exitCode, 0);
  assert.equal(JSON.parse(await readFile(f.handlePath, "utf8")).ref.id, f.operation.id);
});

test("pause CLI cancellation uses the shared exit protocol", async (t) => {
  const { spawn } = await import("node:child_process");
  const { setTimeout: sleep } = await import("node:timers/promises");
  const { access } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "kova-pause-signal-"));
  const handlePath = join(root, "gateway.json"), directory = `${handlePath}.d`, env = "kova-scripts-pause-signal";
  const id = randomUUID();
  await atomicJson(join(directory, "operation.json"), { schema: "kova.gateway.operation.v1", id, entry: "foreground-gateway-start", method: "gateway.start", env, handlePath, directory, expiresAt: new Date(Date.now() + 60000).toISOString() });
  await atomicJson(handlePath, { entry: "foreground-gateway-start", env, ref: { id, directory } });
  const child = spawn(process.execPath, [new URL("../support/verify/gateway-lifecycle.mjs", import.meta.url).pathname, "pause", "--env", env, "--gateway-handle", handlePath, "--timeout", "30000"], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await closed; await rm(root, { recursive: true, force: true }); });
  const waitFile = async (path) => {
    const deadline = Date.now() + 5000;
    for (;;) { try { await access(path); return; } catch (error) { if (error.code !== "ENOENT") throw error; } if (Date.now() >= deadline) throw new Error("request did not reach the mailbox"); await sleep(10); }
  };
  await waitFile(join(directory, "fixture-request.json"));
  const request = JSON.parse(await readFile(join(directory, "fixture-request.json"), "utf8"));
  child.kill("SIGTERM");
  await waitFile(join(directory, `fixture-cancel-${request.id}.json`));
  await atomicJson(join(directory, `fixture-result-${request.id}.json`), { output: { method: "gateway.pause", result: { paused: true }, error: null, elapsedMs: 0 }, exitCode: 0 });
  assert.deepEqual(await closed, { code: 3, signal: null });
});
