import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { atomicJson, CallError, cleanupGatewayHandle, startOperation } from "../support/verify/background.mjs";
import { requestGatewayFixture, runForegroundGateway } from "../support/verify/gateway-lifecycle.mjs";
import { requestRecovery } from "../support/verify/restart-for-recovery.mjs";
import { executePausedFixture, inspectFixtureTarget, parseFixtureArgs, stageSessionStoreFixtureMain } from "../support/verify/stage-session-store-fixture.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";
import { assertFixtureRecoveryComplete, validateRunDestinations } from "../src/verify/run.mjs";
import { createStateFileIdentityResolver, createStateTextPolicy, isPrivateVerificationIdentity, isPrivateVerificationPath, redactStateText, requiresStateFileFiltering, snapshotState } from "../src/verify/checkpoint.mjs";
import { quoteShell } from "../src/commands.mjs";
import { repoRoot } from "../src/paths.mjs";

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

test("fixture backups and intermediate copies stay private through capture, admission and restore", async (t) => {
  const { options, runtime, root, db, staged } = await fixture(t);
  await writeFile(`${db}-shm`, "original shm");
  await writeFile(`${db}-journal`, "original journal");
  const swapped = await executePausedFixture(options, runtime, { doctor: async () => ({ status: 0 }) });
  assert.equal(swapped.exitCode, 0);
  const backup = swapped.output.staged.backup;
  assert.equal(backup, join(dirname(db), ".kova-session-store-backup"));
  // Retain the installation owner's temporary file shapes as after an interrupted copy.
  await copyFile(staged, join(backup, "fixture"));
  await copyFile(join(backup, "original-wal"), join(backup, "fixture-wal"));
  // A blocked later stage leaves real restore copies alongside the originals.
  await mkdir(join(backup, "restore-shm"));
  const restoring = { ...options, fixture: undefined, restore: true };
  const blocked = await executePausedFixture(restoring, runtime);
  assert.equal(blocked.exitCode, 2);
  assert.equal(blocked.restart, false);
  assert.equal(await readFile(join(backup, "restore"), "utf8"), "original database");
  assert.equal(await readFile(join(backup, "restore-wal"), "utf8"), "original wal");
  await rm(join(backup, "restore-shm"), { recursive: true });
  const state = join(root, ".openclaw"), output = join(root, "captured");
  const policy = await createStateTextPolicy({ stateDirectory: state });
  const identities = createStateFileIdentityResolver(policy);
  const context = { cwd: root, run: output, ownedRoots: [root], kovaRoot: repoRoot, readFilePolicy: async () => policy };
  const readCommand = (path) => `node ${quoteShell(join(repoRoot, "support/verify/agent-tool-turn.mjs"))} --env ${options.env} --session-key agent:main:fixture --tool read --args ${quoteShell(JSON.stringify({ path }))}`;
  for (const name of ["original", "original-wal", "original-shm", "original-journal", "restore", "restore-wal", "fixture", "fixture-wal", "backup.json"]) {
    const path = join(backup, name);
    assert.equal(isPrivateVerificationPath(path), true, name);
    assert.equal(await isPrivateVerificationIdentity(path), true, name);
    assert.equal(requiresStateFileFiltering([path], policy), true, name);
    assert.throws(() => redactStateText([path], "retained bytes", policy), /private verification/);
    await assert.rejects(identities.resolve([path]), /private verification/);
    await assert.rejects(validateRunDestinations(readCommand(path), context), /private verification/);
  }
  const selectedBackup = relative(state, backup), selectedFixture = relative(state, staged);
  await snapshotState(state, [selectedBackup, selectedFixture], output, policy);
  await assert.rejects(stat(join(output, selectedBackup)), { code: "ENOENT" });
  assert.equal(await readFile(join(output, selectedFixture), "utf8"), "corrupt fixture");
  assert.equal(requiresStateFileFiltering([staged], policy), false);
  await validateRunDestinations(readCommand(staged), context);

  for (const [index, name] of [".KOVA-SESSION-STORE-BACKUP", ".Kova-session-store-backup"].entries()) {
    const alternate = join(dirname(backup), name), path = join(alternate, "original");
    const original = await stat(backup);
    const candidate = await stat(alternate).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const same = candidate?.dev === original.dev && candidate?.ino === original.ino;
    if (!same) { await mkdir(alternate); await writeFile(path, "ordinary case-sensitive directory"); }
    assert.equal(isPrivateVerificationPath(path), false);
    assert.equal(await isPrivateVerificationIdentity(path), same);
    if (same) await assert.rejects(validateRunDestinations(readCommand(path), context), /private verification/);
    else await validateRunDestinations(readCommand(path), context);
    const snapshot = join(root, `case-capture-${index}`), selected = relative(state, alternate);
    await snapshotState(state, [selected], snapshot, policy);
    if (same) assert.deepEqual(await readdir(snapshot), []);
    else assert.equal(await readFile(join(snapshot, selected, "original"), "utf8"), "ordinary case-sensitive directory");
    t.diagnostic(`${name}: ${same ? "native alias rejected" : "distinct directory preserved"}`);
  }
  const restored = await executePausedFixture(restoring, runtime);
  assert.equal(restored.exitCode, 0);
  assert.equal(restored.output.staged.restored, true);
  for (const [suffix, expected] of [["", "original database"], ["-wal", "original wal"], ["-shm", "original shm"], ["-journal", "original journal"]]) assert.equal(await readFile(`${db}${suffix}`, "utf8"), expected);
  await assert.rejects(stat(backup), { code: "ENOENT" });
  assert.equal(await readFile(staged, "utf8"), "corrupt fixture");
});

test("restore rejects an incomplete backup manifest and preserves retry inputs", async (t) => {
  for (const files of [[], ["-wal"], [""]]) {
    const { options, runtime, db } = await fixture(t);
    const swapped = await executePausedFixture(options, runtime, { doctor: async () => ({ status: 0 }) });
    assert.equal(swapped.exitCode, 0);
    const backup = swapped.output.staged.backup, manifest = join(backup, "backup.json");
    const original = JSON.parse(await readFile(manifest, "utf8"));
    const malformed = JSON.stringify({ ...original, files });
    await writeFile(manifest, malformed);
    const current = [["", "corrupt fixture"], ["-wal", "current wal"], ["-shm", "current shm"], ["-journal", "current journal"]];
    for (const [suffix, bytes] of current) await writeFile(`${db}${suffix}`, bytes);
    const restoring = { ...options, fixture: undefined, restore: true };
    const refused = await executePausedFixture(restoring, runtime);
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.restart, false);
    assert.equal(refused.output.staged, null);
    assert.match(refused.output.error, files.includes("") ? /retained original files/ : /primary database/);
    for (const [suffix, bytes] of current) assert.equal(await readFile(`${db}${suffix}`, "utf8"), bytes);
    assert.equal(await readFile(join(backup, "original"), "utf8"), "original database");
    assert.equal(await readFile(join(backup, "original-wal"), "utf8"), "original wal");
    assert.equal(await readFile(manifest, "utf8"), malformed);
    await atomicJson(manifest, original);
    const retried = await executePausedFixture(restoring, runtime);
    assert.equal(retried.exitCode, 0);
    assert.equal(retried.output.staged.restored, true);
    assert.equal(await readFile(db, "utf8"), "original database");
    assert.equal(await readFile(`${db}-wal`, "utf8"), "original wal");
    await assert.rejects(readFile(`${db}-shm`), { code: "ENOENT" });
    await assert.rejects(readFile(`${db}-journal`), { code: "ENOENT" });
    await assert.rejects(readFile(manifest), { code: "ENOENT" });
  }
});

test("restore accepts a complete database-only backup and removes new sidecars", async (t) => {
  const { options, runtime, db } = await fixture(t);
  await rm(`${db}-wal`);
  const swapped = await executePausedFixture(options, runtime, { doctor: async () => ({ status: 0 }) });
  assert.equal(swapped.exitCode, 0);
  const manifest = join(swapped.output.staged.backup, "backup.json");
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")).files, [""]);
  for (const suffix of ["-wal", "-shm", "-journal"]) await writeFile(`${db}${suffix}`, "new sidecar");
  const restored = await executePausedFixture({ ...options, fixture: undefined, restore: true }, runtime);
  assert.equal(restored.exitCode, 0);
  assert.equal(restored.output.staged.restored, true);
  assert.equal(await readFile(db, "utf8"), "original database");
  for (const suffix of ["-wal", "-shm", "-journal"]) await assert.rejects(readFile(`${db}${suffix}`), { code: "ENOENT" });
  await assert.rejects(readFile(manifest), { code: "ENOENT" });
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
    connect: async () => ({ client: { close() {}, async request(method, params) { schemas.check(method, params); childRunning = true; return method === "agents.list" ? { agents: [{ id: "main" }] } : { path: runtime.configPath }; } } }),
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

async function faultingGateway(t, data, fault, { lifetimeMs = 30000 } = {}) {
  const modulePath = join(data.root, "gateway-fixture-worker.mjs");
  const background = new URL("../support/verify/background.mjs", import.meta.url).href;
  const lifecycle = new URL("../support/verify/gateway-lifecycle.mjs", import.meta.url).href;
  const fixtureModule = new URL("../support/verify/stage-session-store-fixture.mjs", import.meta.url).href;
  const recoveryModule = new URL("../support/verify/restart-for-recovery.mjs", import.meta.url).href;
  await writeFile(modulePath, `import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicJson, serveOperation } from ${JSON.stringify(background)};
import { runForegroundGateway } from ${JSON.stringify(lifecycle)};
import { executePausedFixture } from ${JSON.stringify(fixtureModule)};
import { recoveryFailure } from ${JSON.stringify(recoveryModule)};
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
    return { ok: launches !== 2 || options.fault === "expire-before-swap", body: { cancel: async () => {} } };
  },
  connect: async () => ({ client: { close() {}, async request(method) { return method === "agents.list" ? { agents: [{ id: "main" }] } : { path: options.runtime.configPath }; } } }),
  recovery: {
    recoveryFailure,
    async prepareRecoveryRequest() {
      await atomicJson(join(context.operation.directory, "recovery-prepared.json"), { called: true });
      throw new Error("recovery preparation must not run while restoration is pending");
    }
  },
  fixture: async (input, runtime, controls) => {
    if (options.fault === "expire-before-swap") await sleep(Math.max(1, controls.expiresAt - Date.now() + 1));
    if (input.restore && ++restores === 1 && options.fault === "restore") {
      await rm(options.db);
      await symlink(options.staged, options.db);
    }
    return executePausedFixture(input, runtime, { ...controls, doctor: async () => ({ status: 0 }) });
  }
}));\n`);
  const handlePath = data.options["gateway-handle"];
  const handle = await startOperation(modulePath, { env: data.options.env, handle: handlePath, timeoutMs: 5000, runtime: data.runtime, db: data.db, staged: data.staged, fault }, { entry: "foreground-gateway-start", method: "gateway.start", lifetimeMs });
  data.cleanup.push(() => cleanupGatewayHandle(handlePath, { timeoutMs: 10000 }));
  return { handle, directory: `${handlePath}.d`, handlePath };
}

test("expiry before fixture mutation restarts the unchanged database under the same owner", { timeout: 20000 }, async (t) => {
  const data = await fixture(t);
  const gateway = await faultingGateway(t, data, "expire-before-swap");
  const result = await requestGatewayFixture({ ...data.options, timeoutMs: 25 });
  assert.equal(result.exitCode, 3);
  assert.equal(result.output.staged, null);
  assert.equal(result.output.doctor, null);
  assert.equal(result.output.started, true);
  assert.equal(await readFile(data.db, "utf8"), "original database");
  assert.equal(await readFile(`${data.db}-wal`, "utf8"), "original wal");
  await inspectFixtureTarget(data.options, data.runtime);
  await assert.rejects(readFile(join(gateway.directory, "result.json")), { code: "ENOENT" });
  const current = JSON.parse(await readFile(gateway.handlePath, "utf8"));
  assert.equal(current.ref.id, gateway.handle.ref.id);
  assert.notEqual(current.ref.pid, gateway.handle.ref.pid);
  assert.doesNotThrow(() => process.kill(current.ref.pid, 0));
  assert.equal((await cleanupGatewayHandle(gateway.handlePath, { timeoutMs: 10000 })).exitCode, 0);
  assert.throws(() => process.kill(current.ref.pid, 0), { code: "ESRCH" });
});

for (const retry of [true, false, "invalid"]) test(`failed automatic restore retains the stopped owner for ${retry === "invalid" ? "invalid request refusal" : retry ? "retry" : "final stop"}`, { timeout: 20000 }, async (t) => {
  const data = await fixture(t);
  data.options.env = "kova-run-fixture-recovery";
  const gateway = await faultingGateway(t, data, "restore", { lifetimeMs: 60000 });
  const failed = await requestGatewayFixture(data.options);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.output.started, false);
  assert.match(failed.output.error, /restore failed/);
  const backup = failed.output.staged.backup;
  assert.equal(await readFile(join(backup, "original"), "utf8"), "original database");
  await assert.rejects(readFile(join(gateway.directory, "fixture-request.json")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(gateway.handlePath, "utf8")).ref.fixtureRecoveryComplete, false);
  await assert.rejects(assertFixtureRecoveryComplete(gateway.handlePath), /fixture recovery unresolved/);
  await assert.rejects(readFile(join(gateway.directory, "result.json")), { code: "ENOENT" });
  assert.throws(() => process.kill(gateway.handle.ref.pid, 0), { code: "ESRCH" });
  const refuseRecovery = async () => {
    const refused = await requestRecovery({
      env: data.options.env, "gateway-handle": gateway.handlePath, operation: "restart-for-recovery", timeoutMs: 40000,
      source: { key: `agent:main:dashboard:${randomUUID()}`, sessionId: randomUUID(), agentId: "main" }
    });
    assert.equal(refused.exitCode, 2);
    assert.match(refused.output.error, /complete fixture restoration first/);
    assert.equal(refused.output.sessionKey, null);
    assert.equal(refused.output.sessionId, null);
    assert.deepEqual(refused.output.createdIds, []);
    assert.equal(await readFile(join(backup, "original"), "utf8"), "original database");
    assert.equal(await readFile(join(backup, "original-wal"), "utf8"), "original wal");
    assert.equal(JSON.parse(await readFile(gateway.handlePath, "utf8")).ref.fixtureRecoveryComplete, false);
    await assert.rejects(readFile(join(gateway.directory, "recovery-prepared.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(gateway.directory, "result.json")), { code: "ENOENT" });
  };
  await refuseRecovery();
  if (retry === "invalid") {
    await atomicJson(join(gateway.directory, "fixture-request.json"), { id: randomUUID(), options: data.options, expiresAt: "invalid" });
    const result = await waitForFile(join(gateway.directory, "result.json"));
    assert.equal(result.exitCode, 2);
    assert.match(result.output.error, /invalid fixture request/);
    assert.equal(await readFile(join(backup, "original"), "utf8"), "original database");
  } else if (retry) {

    const manualFailure = await requestGatewayFixture({ ...data.options, fixture: undefined, restore: true });
    assert.equal(manualFailure.exitCode, 2);
    assert.equal(manualFailure.output.started, false);
    await refuseRecovery();
    await rm(data.db);
    const restored = await stageSessionStoreFixtureMain(["--env", data.options.env, "--agent", "main", "--gateway-handle", gateway.handlePath, "--restore", "--timeout", "10000"]);
    assert.equal(restored.exitCode, 0);
    assert.equal(restored.output.staged.restored, true);
    assert.equal(restored.output.started, true);
    assert.equal(await readFile(data.db, "utf8"), "original database");
    assert.equal(await readFile(`${data.db}-wal`, "utf8"), "original wal");
    assert.equal(JSON.parse(await readFile(gateway.handlePath, "utf8")).ref.fixtureRecoveryComplete, true);
    await assertFixtureRecoveryComplete(gateway.handlePath);
  }
  const current = JSON.parse(await readFile(gateway.handlePath, "utf8"));
  assert.equal(current.ref.id, gateway.handle.ref.id);
  if (retry === true) assert.doesNotThrow(() => process.kill(current.ref.pid, 0));
  assert.equal((await cleanupGatewayHandle(gateway.handlePath, { timeoutMs: 10000 })).exitCode, retry === "invalid" ? 2 : 0);
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

test("fixture client rejects malformed owner expiry before publishing and bounds cleanup", { timeout: 10000 }, async (t) => {
  const { options } = await fixture(t);
  const handlePath = options["gateway-handle"], directory = `${handlePath}.d`;
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), env: options.env, entry: "foreground-gateway-start", method: "gateway.start", handlePath, directory };
  await atomicJson(handlePath, { entry: operation.entry, env: options.env, ref: { id: operation.id, directory } });
  for (const expiresAt of [undefined, null, 123, "invalid"]) {
    await atomicJson(join(directory, "operation.json"), { ...operation, expiresAt });
    await assert.rejects(requestGatewayFixture(options), (error) => error.exitCode === 2 && /expiry/.test(error.message));
    assert.deepEqual(await readdir(directory), ["operation.json"]);
  }
  await atomicJson(join(directory, "operation.json"), { ...operation, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(requestGatewayFixture(options), (error) => error.exitCode === 3 && /expired/.test(error.message));
  assert.deepEqual(await readdir(directory), ["operation.json"]);
  await atomicJson(join(directory, "operation.json"), { ...operation, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  await assert.rejects(requestGatewayFixture({ ...options, timeoutMs: NaN }), /timeout/);
  const ordinary = requestGatewayFixture(options);
  const first = await waitForFile(join(directory, "fixture-request.json"));
  const result = { output: { staged: { restored: true }, doctor: null, started: true, error: null }, exitCode: 0 };
  await rm(join(directory, "fixture-request.json"));
  await atomicJson(join(directory, `fixture-result-${first.id}.json`), result);
  assert.deepEqual(await ordinary, result);
  const controller = new AbortController();
  const pending = requestGatewayFixture(options, { signal: controller.signal });
  const rejected = assert.rejects(pending, (error) => error.exitCode === 3 && /cleanup timeout/.test(error.message));
  const second = await waitForFile(join(directory, "fixture-request.json"));
  controller.abort(new CallError("cancelled", 1));
  await waitForFile(join(directory, `fixture-cancel-${second.id}.json`));
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 150001);
  await rejected;
});
