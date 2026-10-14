import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { atomicJson, CallError, cleanupGatewayHandle, startOperation } from "../support/verify/background.mjs";
import { requestGatewayFixture, runForegroundGateway } from "../support/verify/gateway-lifecycle.mjs";
import { executePausedFixture, inspectFixtureTarget, parseFixtureArgs, stageSessionStoreFixtureMain } from "../support/verify/stage-session-store-fixture.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kova-fixture-")));
  const cleanup = [];
  t.after(async () => {
    try { for (const stop of cleanup) await stop(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const agentDir = join(root, ".openclaw/agents/main/agent");
  const configPath = join(root, ".openclaw/openclaw.json");
  await mkdir(agentDir, { recursive: true });
  await atomicJson(configPath, {});
  const db = join(agentDir, "openclaw-agent.sqlite");
  await mkdir(join(agentDir, "fixtures"));
  const staged = join(agentDir, "fixtures", "corrupt.sqlite");
  await writeFile(db, "original database");
  await writeFile(`${db}-wal`, "original wal");
  await writeFile(staged, "corrupt fixture");
  const options = parseFixtureArgs(["--env", "kova-scripts-fixture", "--agent", "main", "--fixture", staged, "--gateway-handle", join(root, "gateway.json"), "--timeout", "10000"]);
  return { root, db, staged, options, cleanup, runtime: { root, configPath, gatewayPort: 12345 } };
}

test("fixture arguments require a disposable clone, explicit owner handle, and one operation", async () => {
  for (const argv of [[], ["--env=kova-persona-retained"], ["--env=kova-scripts-copy", "--agent=../main", "--fixture=x", "--gateway-handle=x"], ["--env=kova-scripts-copy", "--agent=main", "--fixture=x", "--restore", "--gateway-handle=x"]]) assert.throws(() => parseFixtureArgs(argv), CallError);
  assert.equal((await stageSessionStoreFixtureMain(["--unknown"])).exitCode, 2);
  const restored = parseFixtureArgs(["--env=kova-run-copy", "--agent=main", "--restore", "--gateway-handle=x"]);
  assert.equal(restored.restore, true);
});

test("fixture swap retains all original SQLite files and explicit restore removes new sidecars", async (t) => {
  const { options, runtime, db, staged } = await fixture(t);
  const swapped = await executePausedFixture(options, runtime, { doctor: async () => {
    assert.equal(await readFile(db, "utf8"), "corrupt fixture");
    await assert.rejects(readFile(`${db}-wal`), { code: "ENOENT" });
    await writeFile(`${db}-shm`, "new shm");
    return { status: 0, stdout: "Doctor observations", stderr: "" };
  } });
  assert.equal(swapped.exitCode, 0);
  assert.equal(swapped.restart, true);
  assert.equal(swapped.output.started, false);
  assert.equal(await readFile(staged, "utf8"), "corrupt fixture");
  await assert.rejects(inspectFixtureTarget(options, runtime), /backup already exists/);
  const restored = await executePausedFixture({ ...options, fixture: undefined, restore: true }, runtime);
  assert.equal(restored.exitCode, 0);
  assert.equal(restored.output.staged.restored, true);
  assert.equal(await readFile(db, "utf8"), "original database");
  assert.equal(await readFile(`${db}-wal`, "utf8"), "original wal");
  await assert.rejects(readFile(`${db}-shm`), { code: "ENOENT" });
  assert.equal(restored.output.doctor, null);
  await assert.rejects(inspectFixtureTarget({ ...options, restore: true }, runtime), /missing/);
});

test("Doctor command failure and own timeout restore the original set before restart", async (t) => {
  const { options, runtime, db } = await fixture(t);
  for (const timedOut of [false, true]) {
    const result = await executePausedFixture(options, runtime, {
      expiresAt: Date.now() + (timedOut ? 2000 : 10000),
      doctor: async (_options, signal) => {
        await writeFile(db, "Doctor changed bytes");
        if (timedOut) await sleep(10000, undefined, { signal });
        return { status: 1, stdout: "observed failure", stderr: "" };
      }
    });
    assert.equal(result.exitCode, timedOut ? 3 : 1);
    assert.equal(result.restart, true);
    assert.equal(result.output.staged.restored, true);
    assert.equal(await readFile(db, "utf8"), "original database");
    assert.equal(await readFile(`${db}-wal`, "utf8"), "original wal");
  }
});

test("unsupported storage and aliased paths are refused before any swap", async (t) => {
  const { options, runtime, db, root } = await fixture(t);
  for (const store of ["relative.sqlite", join(root, "shared.sqlite"), "~/custom.sqlite"]) {
    await atomicJson(runtime.configPath, { session: { store } });
    const result = await executePausedFixture(options, runtime, { doctor() { assert.fail("Doctor must not start"); } });
    assert.equal(result.exitCode, 2);
    assert.equal(await readFile(db, "utf8"), "original database");
  }
  await atomicJson(runtime.configPath, { session: { store: join(root, ".openclaw/agents/{agentId}/sessions/sessions.json") } });
  assert.equal((await inspectFixtureTarget(options, runtime)).db, db);
  const alias = join(root, ".openclaw/agents/main/agent/alias.sqlite");
  await symlink(options.fixture, alias);
  await assert.rejects(inspectFixtureTarget({ ...options, fixture: alias }, runtime), /links/);
});

test("interruption during Doctor restores before allowing the owner to restart", async (t) => {
  const { options, runtime, db } = await fixture(t);
  const controller = new AbortController();
  const result = await executePausedFixture(options, runtime, { signal: controller.signal, doctor: async () => {
    await writeFile(db, "interrupted repair");
    controller.abort(new CallError("fixture request interrupted", 1));
    return { status: 0 };
  } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.restart, true);
  assert.equal(result.output.staged.restored, true);
  assert.equal(await readFile(db, "utf8"), "original database");
});

test("failed restore retains the backup and does not permit restarting", async (t) => {
  const { options, runtime, db } = await fixture(t);
  const swapped = await executePausedFixture(options, runtime, { doctor: async () => ({ status: 0 }) });
  await rm(db);
  await symlink(options.fixture, db);
  const restored = await executePausedFixture({ ...options, restore: true }, runtime);
  assert.equal(restored.exitCode, 2);
  assert.equal(restored.restart, false);
  // Refusal happened before the original files were touched.
  assert.equal(await readFile(join(swapped.output.staged.backup, "original"), "utf8"), "original database");
});

test("foreground owner handles repeated swaps and restores under its original handle", async (t) => {
  const { options, runtime, root } = await fixture(t);
  const handlePath = options["gateway-handle"], directory = `${handlePath}.d`;
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), env: options.env, entry: "foreground-gateway-start", method: "gateway.start", handlePath, directory, expiresAt: new Date(Date.now() + 20000).toISOString() };
  await atomicJson(join(directory, "operation.json"), operation);
  const controller = new AbortController();
  t.after(() => controller.abort(new CallError("background operation stopped", 1)));
  let initial;
  const started = new Promise((accept) => { initial = accept; });
  const pids = [];
  let childRunning = false;
  const running = runForegroundGateway({ env: options.env, timeoutMs: 3000 }, {
    operation, signal: controller.signal,
    async publish(ref) { pids.push(ref.pid); await atomicJson(handlePath, { entry: operation.entry, env: options.env, ref: { ...ref, id: operation.id, directory } }); initial(); }
  }, {
    prepare: () => runtime, requireUnusedPort: async () => {},
    invocation: () => ({ file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: process.env }),
    fetch: async () => ({ ok: true, body: { cancel: async () => {} } }),
    connect: async () => ({ client: { close() {}, async request(method, params) { schemas.check(method, params); childRunning = true; return { path: runtime.configPath }; } } }),
    fixture: async (input, selected, controls) => {
      const current = JSON.parse(await readFile(handlePath, "utf8"));
      assert.throws(() => process.kill(current.ref.pid, 0), { code: "ESRCH" });
      childRunning = false;
      return await executePausedFixture(input, selected, { ...controls, doctor: async () => { assert.equal(childRunning, false); return { status: 0 }; } });
    }
  });
  t.after(async () => { controller.abort(new CallError("background operation stopped", 1)); await running; });
  await started;
  const swap = await requestGatewayFixture(options);
  assert.equal(swap.exitCode, 0);
  assert.equal(swap.output.started, true);
  const afterSwap = JSON.parse(await readFile(handlePath, "utf8"));
  assert.equal(afterSwap.ref.id, operation.id);
  assert.notEqual(afterSwap.ref.pid, pids[0]);
  const restore = await requestGatewayFixture({ ...options, fixture: undefined, restore: true });
  assert.equal(restore.exitCode, 0);
  assert.equal(restore.output.started, true);
  const afterRestore = JSON.parse(await readFile(handlePath, "utf8"));
  assert.equal(afterRestore.ref.id, operation.id);
  assert.notEqual(afterRestore.ref.pid, afterSwap.ref.pid);
  controller.abort(new CallError("background operation stopped", 1));
  assert.equal((await running).exitCode, 0);
  assert.throws(() => process.kill(afterRestore.ref.pid, 0), { code: "ESRCH" });
});

async function waitForFile(path) {
  const deadline = Date.now() + 10000;
  while (true) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await sleep(25);
  }
}

async function faultingGateway(t, data, fault) {
  const modulePath = join(data.root, "gateway-fixture-worker.mjs");
  const background = new URL("../support/verify/background.mjs", import.meta.url).href;
  const lifecycle = new URL("../support/verify/gateway-lifecycle.mjs", import.meta.url).href;
  const fixtureModule = new URL("../support/verify/stage-session-store-fixture.mjs", import.meta.url).href;
  await writeFile(modulePath, `import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, serveOperation } from ${JSON.stringify(background)};
import { runForegroundGateway } from ${JSON.stringify(lifecycle)};
import { executePausedFixture } from ${JSON.stringify(fixtureModule)};
let launches = 0, restores = 0;
await serveOperation((options, context) => runForegroundGateway(options, context, {
  prepare: () => options.runtime,
  requireUnusedPort: async () => {},
  invocation: () => {
    launches++;
    return { file: process.execPath, args: ["-e", launches === 2 && options.fault === "restore" ? "process.exit(9)" : "setInterval(() => {}, 1000)"], env: process.env };
  },
  fetch: async () => {
    if (launches === 2) await atomicJson(join(context.operation.directory, "restart-attempted.json"), { launches });
    return { ok: launches !== 2, body: { cancel: async () => {} } };
  },
  connect: async () => ({ client: { close() {}, async request() { return { path: options.runtime.configPath }; } } }),
  fixture: async (input, runtime, controls) => {
    if (input.restore && ++restores === 1 && options.fault === "restore") {
      await rm(options.db);
      await symlink(options.staged, options.db);
    }
    return executePausedFixture(input, runtime, { ...controls, doctor: async () => ({ status: 0 }) });
  }
}));\n`);
  const handlePath = data.options["gateway-handle"];
  const handle = await startOperation(modulePath, { env: data.options.env, handle: handlePath, timeoutMs: 5000, runtime: data.runtime, db: data.db, staged: data.staged, fault }, { entry: "foreground-gateway-start", method: "gateway.start", lifetimeMs: 30000 });
  data.cleanup.push(() => cleanupGatewayHandle(handlePath, { timeoutMs: 10000 }));
  return { handle, directory: `${handlePath}.d`, handlePath };
}

for (const retry of [true, false]) test(`failed automatic restore retains the stopped owner for ${retry ? "retry" : "final stop"}`, { timeout: 20000 }, async (t) => {
  const data = await fixture(t);
  const gateway = await faultingGateway(t, data, "restore");
  const failed = await requestGatewayFixture(data.options);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.output.started, false);
  assert.match(failed.output.error, /restore failed/);
  const backup = failed.output.staged.backup;
  assert.equal(await readFile(join(backup, "original"), "utf8"), "original database");
  await assert.rejects(readFile(join(gateway.directory, "result.json")), { code: "ENOENT" });
  assert.throws(() => process.kill(gateway.handle.ref.pid, 0), { code: "ESRCH" });
  if (retry) {
    await rm(data.db);
    const restored = await stageSessionStoreFixtureMain(["--env", data.options.env, "--agent", "main", "--gateway-handle", gateway.handlePath, "--restore", "--timeout", "10000"]);
    assert.equal(restored.exitCode, 0);
    assert.equal(restored.output.staged.restored, true);
    assert.equal(restored.output.started, true);
    assert.equal(await readFile(data.db, "utf8"), "original database");
    assert.equal(await readFile(`${data.db}-wal`, "utf8"), "original wal");
  }
  const current = JSON.parse(await readFile(gateway.handlePath, "utf8"));
  assert.equal(current.ref.id, gateway.handle.ref.id);
  assert.equal((await cleanupGatewayHandle(gateway.handlePath, { timeoutMs: 10000 })).exitCode, 0);
  assert.throws(() => process.kill(current.ref.pid, 0), { code: "ESRCH" });
});

for (const interrupt of ["cancel", "timeout"]) test(`${interrupt} during fixture restart restores the original files before completion`, { timeout: 20000 }, async (t) => {
  const data = await fixture(t);
  const gateway = await faultingGateway(t, data, "hold");
  const controller = new AbortController();
  const request = requestGatewayFixture({ ...data.options, timeoutMs: interrupt === "timeout" ? 2000 : 10000 }, { signal: controller.signal });
  const cancelled = interrupt === "cancel" ? assert.rejects(request, (error) => error === controller.signal.reason || error.cause === controller.signal.reason) : null;
  await waitForFile(join(gateway.directory, "restart-attempted.json"));
  const pending = await waitForFile(join(gateway.directory, "fixture-request.json"));
  let completed;
  if (interrupt === "cancel") {
    controller.abort(new CallError("caller cancelled", 1));
    await cancelled;
    completed = await waitForFile(join(gateway.directory, `fixture-result-${pending.id}.json`));
  } else completed = await request;
  assert.equal(completed.exitCode, interrupt === "timeout" ? 3 : 1);
  assert.equal(completed.output.staged.restored, true);
  assert.equal(completed.output.started, true);
  assert.equal(await readFile(data.db, "utf8"), "original database");
  assert.equal(await readFile(`${data.db}-wal`, "utf8"), "original wal");
  await assert.rejects(readFile(join(gateway.directory, "result.json")), { code: "ENOENT" });
  const current = JSON.parse(await readFile(gateway.handlePath, "utf8"));
  assert.equal(current.ref.id, gateway.handle.ref.id);
  assert.notEqual(current.ref.pid, gateway.handle.ref.pid);
  assert.equal((await cleanupGatewayHandle(gateway.handlePath, { timeoutMs: 10000 })).exitCode, 0);
  assert.throws(() => process.kill(current.ref.pid, 0), { code: "ESRCH" });
});

test("fixture module imports while the Gateway worker entrypoint is awaiting IPC", { timeout: 10000 }, async (t) => {
  const { root } = await fixture(t);
  const path = join(root, "entrypoint-import-probe.mjs");
  const lifecycle = new URL("../support/verify/gateway-lifecycle.mjs", import.meta.url);
  const stage = new URL("../support/verify/stage-session-store-fixture.mjs", import.meta.url).href;
  await writeFile(path, `import { fileURLToPath } from "node:url";
process.argv[1] = fileURLToPath(${JSON.stringify(lifecycle.href)});
process.argv[2] = "--worker";
void import(${JSON.stringify(lifecycle.href)});
setImmediate(async () => {
  await import(${JSON.stringify(stage)});
  process.send({ imported: true }, () => process.exit(0));
});\n`);
  const child = fork(path, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const imported = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture import waited for the Gateway worker lifetime")), 5000);
    child.once("message", (message) => { clearTimeout(timer); accept(message); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`import probe exited ${code}`)); });
  });
  assert.deepEqual(imported, { imported: true });
});

test("a cancelled fixture client waits for the owner result before rejecting", { timeout: 10000 }, async (t) => {
  const { options } = await fixture(t);
  const handlePath = options["gateway-handle"], directory = `${handlePath}.d`;
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), env: options.env, entry: "foreground-gateway-start", method: "gateway.start", handlePath, directory, expiresAt: new Date(Date.now() + 10000).toISOString() };
  await atomicJson(join(directory, "operation.json"), operation);
  await atomicJson(handlePath, { entry: operation.entry, env: options.env, ref: { id: operation.id, directory } });
  const controller = new AbortController();
  let settled = false;
  const request = requestGatewayFixture(options, { signal: controller.signal }).finally(() => { settled = true; });
  const rejected = assert.rejects(request, (error) => error === controller.signal.reason);
  const pending = await waitForFile(join(directory, "fixture-request.json"));
  controller.abort(new CallError("caller cancelled", 1));
  try {
    await waitForFile(join(directory, `fixture-cancel-${pending.id}.json`));
    await sleep(100);
    assert.equal(settled, false, "cancellation must not release the client while cleanup is pending");
  } finally {
    await rm(join(directory, "fixture-request.json"));
    await atomicJson(join(directory, `fixture-result-${pending.id}.json`), { output: { staged: { restored: true }, doctor: null, started: true, error: "fixture request interrupted" }, exitCode: 1 });
    await rejected;
  }
  assert.equal(settled, true);
});

test("fixture lifecycle requests match pinned Gateway schemas", (t) => schemas.report(t));
