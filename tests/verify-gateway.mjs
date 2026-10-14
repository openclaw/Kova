import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { atomicJson, CallError, cleanupGatewayHandle, joinOperation, startOperation } from "../support/verify/background.mjs";
import { executeGatewayCall, gatewayCallMain, parseGatewayCallArgs, resolveGatewayParams } from "../support/verify/gateway-call.mjs";
import { gatewayLifecycleMain, parseGatewayLifecycleArgs, runForegroundGateway } from "../support/verify/gateway-lifecycle.mjs";

const exec = promisify(execFile);
const backgroundUrl = new URL("../support/verify/background.mjs", import.meta.url).href;

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "kova-gateway-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("Gateway flags reject malformed calls and accept method-specific joins", async () => {
  for (const args of [[], ["--env", "x", "--method", "health", "--params", "[]"], ["--env", "x", "--method", "health", "--background"], ["--wait", "x", "--params", "{}"], ["--env", "x", "--method", "health", "--from", "x"]]) {
    assert.throws(() => parseGatewayCallArgs(args), CallError);
  }
  const options = parseGatewayCallArgs(["--env=x", "--method=health", "--timeout=50", "--wait=x"]);
  assert.equal(options.method, "health");
  assert.equal(options.timeoutMs, 50);
  assert.equal((await gatewayCallMain(["--unknown"])).exitCode, 2);
  assert.equal(parseGatewayLifecycleArgs(["start", "--env=x", "--handle=x", "--background"]).action, "start");
  assert.equal(parseGatewayLifecycleArgs(["start", "--wait=x"]).action, "start");
  for (const flag of ["--env=x", "--handle=x", "--background"]) assert.throws(() => parseGatewayLifecycleArgs(["start", "--wait=x", flag]), CallError);
  assert.throws(() => parseGatewayLifecycleArgs(["stop", "--wait=x", "--env=x"]), CallError);
});

test("foreground Gateway start joins without requesting stop", async (t) => {
  const root = await directory(t);
  const handle = join(root, "gateway.json");
  const operation = { schema: "kova.gateway.operation.v1", id: "operation", entry: "foreground-gateway-start", method: "gateway.start", handlePath: handle, directory: `${handle}.d` };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  const pending = await gatewayLifecycleMain(["start", "--wait", handle, "--timeout", "20"]);
  assert.equal(pending.exitCode, 3);
  const controller = new AbortController();
  const joining = joinOperation(handle, { timeoutMs: 10000, signal: controller.signal });
  const interrupted = assert.rejects(joining, /abort|cancel join/i);
  await sleep(20);
  controller.abort(new Error("cancel join"));
  await interrupted;
  const cancelledLifecycle = await gatewayLifecycleMain(["start", "--wait", handle, "--timeout", "10000"], { signal: controller.signal });
  assert.equal(cancelledLifecycle.exitCode, 1);
  const cancelledRpc = await gatewayCallMain(["--method", "gateway.start", "--wait", handle, "--timeout", "10000"], { signal: controller.signal });
  assert.equal(cancelledRpc.exitCode, 1);
  await assert.rejects(readFile(join(operation.directory, "stop")), (error) => error.code === "ENOENT");
  const completed = { output: { method: "gateway.stop", result: { stopped: true }, error: null, elapsedMs: 10 }, exitCode: 0, cleanupComplete: true };
  await atomicJson(join(operation.directory, "result.json"), completed);
  assert.deepEqual(await gatewayLifecycleMain(["start", "--wait", handle]), completed);
  await assert.rejects(readFile(join(operation.directory, "stop")), (error) => error.code === "ENOENT");
});

test("output aliases cannot replace saved evidence or background records", async (t) => {
  const root = await directory(t);
  const handle = join(root, "call.json");
  const operation = { schema: "kova.gateway.operation.v1", id: "operation", entry: "gateway-health", method: "health", handlePath: handle, directory: `${handle}.d` };
  const completed = { output: { method: "health", result: { ok: false }, error: null, elapsedMs: 1 }, exitCode: 0, cleanupComplete: true };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  await atomicJson(join(operation.directory, "result.json"), completed);
  await atomicJson(handle, { entry: operation.entry, ref: { id: operation.id, directory: operation.directory } });
  const evidence = join(root, "earlier.json");
  await atomicJson(evidence, { retained: true });
  await link(evidence, join(root, "hard-alias.json"));
  await symlink(evidence, join(root, "file-alias.json"));
  await symlink(root, join(root, "directory-alias"), "dir");
  const original = new Map(await Promise.all([handle, evidence, join(operation.directory, "operation.json"), join(operation.directory, "result.json")].map(async (path) => [path, await readFile(path, "utf8")])));
  const joinArgs = ["--method", "health", "--wait", handle, "--timeout", "100"];
  for (const out of [handle, join(operation.directory, "operation.json"), join(operation.directory, "result.json"), join(operation.directory, "stop"), evidence, join(root, "hard-alias.json"), join(root, "file-alias.json"), join(root, "directory-alias", "call.json"), join(root, "directory-alias", "call.json.d", "stop")]) {
    const result = await gatewayCallMain([...joinArgs, "--out", out]);
    assert.equal(result.exitCode, 2, out);
  }
  const active = join(root, "active.json.d");
  await atomicJson(join(active, "operation.json"), { ...operation, directory: active, handlePath: join(root, "active.json") });
  assert.equal((await gatewayCallMain([...joinArgs, "--out", join(active, "result.json")])).exitCode, 2);
  const nestedHandle = await gatewayLifecycleMain(["start", "--env", "unused", "--handle", join(active, "result.json"), "--timeout", "100"]);
  assert.equal(nestedHandle.exitCode, 2);
  await assert.rejects(readFile(join(active, "result.json")), { code: "ENOENT" });
  for (const [path, bytes] of original) assert.equal(await readFile(path, "utf8"), bytes);
  await assert.rejects(readFile(join(operation.directory, "stop")), { code: "ENOENT" });
  const fresh = join(root, "fresh.json");
  const aliasedFresh = join(root, "directory-alias", "fresh.json");
  const conflictingStart = await gatewayCallMain(["--env", "unused", "--method", "health", "--background", "--handle", fresh, "--out", aliasedFresh]);
  assert.equal(conflictingStart.exitCode, 2);
  await assert.rejects(readFile(join(`${fresh}.d`, "operation.json")), { code: "ENOENT" });
  const output = join(root, "new-results", "joined.json");
  const concurrent = await Promise.all([gatewayCallMain([...joinArgs, "--out", output]), gatewayCallMain([...joinArgs, "--out", output])]);
  assert.deepEqual(concurrent.map((result) => result.exitCode).sort(), [0, 2]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), completed.output);
});

test("result files preserve selectors and reject stale or ambiguous identities", async (t) => {
  const root = await directory(t);
  const session = join(root, "session.json");
  const described = join(root, "described.json");
  const processes = join(root, "processes.json");
  const merge = join(root, "merge.json");
  await atomicJson(session, { method: "sessions.create", result: { key: "session-a" }, error: null });
  await atomicJson(described, { method: "sessions.describe", result: { session: { key: "session-a", sessionId: "id-a" } }, error: null });
  await atomicJson(merge, { limit: 3, custom: "value" });
  assert.deepEqual(await resolveGatewayParams({ method: "sessions.branches.list", params: {}, "session-from": session }), { sessionKey: "session-a" });
  for (const method of ["session.members.add", "session.members.remove"]) {
    assert.deepEqual(await resolveGatewayParams({ method, params: { identityId: "member-a" }, "session-from": session }), { sessionKey: "session-a", identityId: "member-a" });
  }
  await assert.rejects(resolveGatewayParams({ method: "session.member.add", params: {}, "session-from": session }), /no single-session selector/);
  assert.deepEqual(await resolveGatewayParams({ method: "chat.history", params: { limit: 4 }, "session-from": session, "merge-from": merge }), { sessionKey: "session-a", limit: 4, custom: "value" });
  assert.deepEqual(await resolveGatewayParams({ method: "sessions.setInvolvement", params: { key: "session-a", hidden: true }, from: described }), { key: "session-a", hidden: true, expectedSessionId: "id-a" });
  await assert.rejects(resolveGatewayParams({ method: "sessions.setInvolvement", params: { key: "session-b" }, from: described }), /does not describe/);
  await assert.rejects(resolveGatewayParams({ method: "sessions.list", params: {}, "session-from": session }), /no single-session selector/);
  const row = { processId: "p-a", instanceId: "instance-a" };
  const record = { method: "sessions.processes.list", result: { sessionId: "id-a", processes: [row] }, error: null };
  await atomicJson(processes, record);
  const options = { method: "sessions.processes.stop", params: { key: "session-a", sessionId: "id-a", processId: "p-a" }, from: processes };
  assert.equal((await resolveGatewayParams(options)).instanceId, "instance-a");
  await assert.rejects(resolveGatewayParams({ ...options, params: { ...options.params, sessionId: "id-b" } }), /does not identify/);
  await atomicJson(processes, { ...record, result: { ...record.result, processes: [row, row] } });
  await assert.rejects(resolveGatewayParams(options), /exactly one process/);
});

test("RPC records product results without deciding their correctness and closes clients", async () => {
  const options = parseGatewayCallArgs(["--env", "test", "--method", "health", "--timeout", "100"]);
  let closed = 0;
  let received;
  const dependencies = {
    prepare: () => ({}),
    connect: async () => ({ client: { close() { closed += 1; }, async request(method, params) { received = { method, params }; return { ok: false }; } } })
  };
  const result = await executeGatewayCall(options, dependencies);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output.result, { ok: false });
  assert.deepEqual(received, { method: "health", params: {} });
  assert.equal(closed, 1);
  const rejected = await executeGatewayCall(options, { ...dependencies, connect: async () => ({ client: { close() {}, request: async () => { throw new Error("product refused"); } } }) });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.output.error, /product refused/);
  const productTimeout = await executeGatewayCall(options, { ...dependencies, connect: async () => ({ client: { close() {}, request: async () => { throw new Error("health TIMEOUT: product timed out"); } } }) });
  assert.equal(productTimeout.exitCode, 1);
  const timedOut = await executeGatewayCall({ ...options, timeoutMs: 20 }, { ...dependencies, connect: async () => ({ client: { close() {}, request: async () => sleep(60) } }) });
  assert.equal(timedOut.exitCode, 3);
  const delayed = await executeGatewayCall({ ...options, afterMs: 30, timeoutMs: 20 }, dependencies);
  assert.equal(delayed.exitCode, 0);
  assert.ok(delayed.output.elapsedMs >= 25);
});

test("elapsed deadlines classify synchronous environment lookup failures as timeouts", async () => {
  const options = { env: "test", method: "health", params: {}, timeoutMs: 20, afterMs: 0 };
  const prepare = () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    throw Object.assign(new Error("environment lookup failed"), { code: "ETIMEDOUT" });
  };
  const rpc = await executeGatewayCall(options, { prepare, connect: () => assert.fail("expired lookup must not connect") });
  assert.equal(rpc.exitCode, 3);
  const foreground = await runForegroundGateway(options, { signal: new AbortController().signal }, { prepare });
  assert.equal(foreground.exitCode, 3);
  const immediate = await executeGatewayCall({ ...options, timeoutMs: 1000 }, { prepare: () => { throw new Error("environment lookup failed"); } });
  assert.equal(immediate.exitCode, 1);
});

test("parameter file reads accept cancellation and malformed input remains distinct", async (t) => {
  const root = await directory(t);
  const path = join(root, "params.json");
  await atomicJson(path, {});
  const signal = AbortSignal.abort(new Error("cancel parameter reads"));
  for (const flag of ["merge-from", "session-from", "from"]) {
    await assert.rejects(resolveGatewayParams({ method: "sessions.processes.stop", params: {}, [flag]: path }, { signal }), (error) => error.name === "AbortError");
  }
  await writeFile(path, "{");
  const malformed = await executeGatewayCall({ env: "test", method: "health", params: {}, timeoutMs: 1000, "merge-from": path }, { prepare: () => assert.fail("invalid input must not prepare an environment") });
  assert.equal(malformed.exitCode, 2);
});

async function fixture(t) {
  const root = await directory(t);
  const path = join(root, "operation.mjs");
  await writeFile(path, `
import { serveOperation } from ${JSON.stringify(backgroundUrl)};
import { setTimeout as sleep } from "node:timers/promises";
await serveOperation(async (options, context) => {
  if (options.before) await sleep(options.before, undefined, { signal: context.signal });
  await context.publish({ pid: process.pid });
  await sleep(options.delay ?? 50, undefined, { signal: context.signal });
  if (options.fail) throw new Error("fixture product error");
  return { output: { method: "health", result: { ok: false }, error: null, elapsedMs: 50 }, exitCode: 0 };
});
`);
  return { root, path };
}

test("background process detaches output, refuses reuse and keeps repeatable joins", async (t) => {
  const { root, path } = await fixture(t);
  const handle = join(root, "nested", "operation.json");
  const starter = join(root, "start.mjs");
  await writeFile(starter, `
import { startOperation } from ${JSON.stringify(backgroundUrl)};
const result = await startOperation(${JSON.stringify(path)}, { env: "test", handle: ${JSON.stringify(handle)}, delay: 3000 }, { entry: "gateway-health", method: "health", lifetimeMs: 10000 });
process.stdout.write(JSON.stringify(result));
`);
  const started = JSON.parse((await exec(process.execPath, [starter], { timeout: 2000 })).stdout);
  assert.equal(started.entry, "gateway-health");
  t.after(() => cleanupGatewayHandle(handle, { timeoutMs: 2000 }));
  await assert.rejects(startOperation(path, { env: "test", handle }, { entry: "gateway-health", method: "health", lifetimeMs: 1000 }), /EEXIST/);
  await assert.rejects(joinOperation(handle, { timeoutMs: 100, method: "status" }), /does not match/);
  await assert.rejects(joinOperation(handle, { timeoutMs: 20 }), (error) => error.exitCode === 3);
  const stopped = await cleanupGatewayHandle(handle, { timeoutMs: 2000 });
  assert.equal(stopped.exitCode, 1);
  assert.deepEqual(await joinOperation(handle), stopped);
  assert.deepEqual(await cleanupGatewayHandle(handle), stopped);
  assert.equal(JSON.parse(await readFile(handle, "utf8")).ref.pid, started.ref.pid);
});

test("background errors and cancellation before handle publication remain observable", async (t) => {
  const { root, path } = await fixture(t);
  const handle = join(root, "failure.json");
  await startOperation(path, { env: "test", handle, fail: true }, { entry: "gateway-health", method: "health", lifetimeMs: 1000 });
  assert.match((await joinOperation(handle, { timeoutMs: 2000 })).output.error, /fixture product error/);
  const partial = join(root, "partial.json");
  const pending = startOperation(path, { env: "test", handle: partial, before: 5000 }, { entry: "gateway-health", method: "health", lifetimeMs: 10000 });
  const rejected = assert.rejects(pending, /abort|stopped|disconnected/i);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await readFile(join(`${partial}.d`, "operation.json")); break; } catch { await sleep(10); }
  }
  const result = await cleanupGatewayHandle(partial, { timeoutMs: 2000 });
  assert.equal(result.exitCode, 1);
  await rejected;
  assert.equal(await cleanupGatewayHandle(join(root, "absent.json")), null);
});

test("cleanup refuses to report success when owned shutdown is unresolved", async (t) => {
  const root = await directory(t);
  const handle = join(root, "failed-stop.json");
  await atomicJson(join(`${handle}.d`, "operation.json"), { schema: "kova.gateway.operation.v1", id: "operation", entry: "gateway-start", handlePath: handle, directory: `${handle}.d` });
  await atomicJson(join(`${handle}.d`, "result.json"), { output: { error: "stop failed" }, exitCode: 1, cleanupComplete: false, cleanupError: "child remains" });
  await assert.rejects(cleanupGatewayHandle(handle), /cleanup unresolved: child remains/);
});

test("foreground Gateway checks config identity, preserves logs and stops its owned process", async (t) => {
  const root = await directory(t);
  const expectedPath = join(root, "openclaw.json");
  const controller = new AbortController();
  const methods = [];
  let published;
  const options = { env: "test", timeoutMs: 2000 };
  const context = { signal: controller.signal, operation: { directory: root }, async publish(handle) { published = handle; await sleep(100); controller.abort(new CallError("background operation stopped", 1)); } };
  const dependencies = {
    prepare: () => ({ root, configPath: expectedPath, gatewayPort: 12345 }),
    requireUnusedPort: async () => {},
    invocation: (args) => {
      assert.deepEqual(args, ["@test", "--", "gateway", "run", "--port", "12345"]);
      return { file: process.execPath, args: ["-e", "console.log('gateway output'); console.error('gateway error'); setInterval(() => {}, 1000)"], env: process.env };
    },
    fetch: async () => ({ ok: true, body: { cancel: async () => {} } }),
    connect: async () => ({ client: { close() {}, async request(method) { methods.push(method); return { path: expectedPath }; } } })
  };
  const stopped = await runForegroundGateway(options, context, dependencies);
  assert.equal(stopped.exitCode, 0);
  assert.deepEqual(methods, ["config.get"]);
  assert.ok(published.pid > 0);
  assert.match(await readFile(published.stdoutPath, "utf8"), /gateway output/);
  assert.match(await readFile(published.stderrPath, "utf8"), /gateway error/);
  assert.throws(() => process.kill(published.pid, 0), (error) => error.code === "ESRCH");
  const wrongRoot = join(root, "wrong");
  await mkdir(wrongRoot);
  const mismatch = await runForegroundGateway(options, { signal: new AbortController().signal, operation: { directory: wrongRoot }, publish() { assert.fail("must not publish a mismatched Gateway"); } }, { ...dependencies, connect: async () => ({ client: { close() {}, request: async () => ({ path: join(root, "other.json") }) } }) });
  assert.equal(mismatch.exitCode, 1);
  assert.match(mismatch.output.error, /config path does not match/);
});
