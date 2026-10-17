import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { atomicJson, CallError } from "../support/verify/background.mjs";
import { definition as doctor } from "../support/verify/doctor-repair.mjs";
import { requestGatewayLifecycle } from "../support/verify/gateway-fixture-client.mjs";
import { runForegroundGateway } from "../support/verify/gateway-lifecycle.mjs";
import { definition as restart, submittedTurn } from "../support/verify/restart-during-turn.mjs";
import { parseScriptArgs, scriptMain } from "../support/verify/script.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();
const restartFields = [...Object.keys(restart.empty()), "error"].sort();

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "kova-lifecycle-"));
  const env = "kova-helpers-lifecycle";
  const controller = new AbortController();
  const handlePath = join(root, "gateway.json"), sourcePath = join(root, "turn.json");
  const descriptor = (path, entry, method) => ({ schema: "kova.gateway.operation.v1", id: randomUUID(), env, entry, method, handlePath: path, directory: `${path}.d`, expiresAt: new Date(Date.now() + 120000).toISOString() });
  const operation = descriptor(handlePath, "foreground-gateway-start", "gateway.start");
  const sourceOperation = descriptor(sourcePath, "chat-send", "chat-send");
  for (const entry of [operation, sourceOperation]) await atomicJson(join(entry.directory, "operation.json"), entry);
  await atomicJson(sourcePath, { entry: "chat-send", env, ref: { id: sourceOperation.id, directory: sourceOperation.directory } });
  const source = { operationId: sourceOperation.id, entry: "chat-send", env, sessionKey: "agent:main:main", runId: randomUUID() };
  await atomicJson(join(sourceOperation.directory, "submitted-turn.json"), source);
  const runtime = { root, configPath: join(root, ".openclaw/openclaw.json"), gatewayPort: 19997 };
  const row = { key: source.sessionKey, sessionId: randomUUID(), status: "running", hasActiveRun: true, activeRunIds: [source.runId] };
  const calls = [], events = [], connections = [], children = new Map();
  let launch = 0, signalAt;
  let started;
  const published = new Promise((accept) => { started = accept; });
  const running = runForegroundGateway({ env, timeoutMs: 300 }, {
    signal: controller.signal, operation,
    async publish(ref) {
      await atomicJson(handlePath, { entry: operation.entry, env, ref: { ...ref, id: operation.id, directory: operation.directory } });
      started();
    }
  }, {
    prepare: () => runtime,
    requireUnusedPort: async () => { events.push("port-free"); assert.equal([...children.values()].some((child) => !child.stopped), false); },
    fetch: async () => ({ ok: !(options.failRestart && launch > 1), body: { cancel: async () => {} } }),
    invocation: () => ({ file: "owned-gateway", args: [], env: {} }),
    connect: async () => {
      const ws = new EventTarget();
      connections.push(ws);
      return { client: { ws, close() {}, async request(method, params) {
        schemas.check(method, params);
        calls.push({ method, params });
        if (method === "config.get") return { path: runtime.configPath };
        if (method === "agents.list") return { agents: [{ id: "main" }] };
        if (method === "sessions.messages.subscribe") return { ok: true };
        if (method === "sessions.describe") return { session: options.row ? options.row(row) : row };
        throw new Error(`unexpected RPC ${method}`);
      } } };
    },
    doctorHelper: async (name, args) => {
      events.push("doctor");
      assert.equal(name, "run-doctor-repair");
      assert.deepEqual(args, ["--env", env]);
      assert.equal([...children.values()].some((child) => !child.stopped), false);
      if (options.doctor) return await options.doctor();
      return { status: 0, value: { status: 0, doctorFixSucceeded: true, doctorUnrepairedFindingCount: 0, stdoutSnippet: "repaired" } };
    },
    signalOwnedProcess(child, signal) {
      events.push(signal);
      signalAt = Date.now();
      children.get(child.pid).release();
    },
    spawn() {
      const pid = ++launch;
      events.push(`start-${pid}`);
      let close, release;
      const closed = new Promise((accept) => { close = accept; });
      const drain = new Promise((accept) => { release = accept; });
      const state = { stopped: false, release, stopAt: null };
      children.set(pid, state);
      const child = { pid, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null };
      return { child, closed, async stop() {
        state.stopAt = Date.now();
        events.push(`stop-${pid}`);
        if (options.completeDuringDrain && pid === 1) for (const ws of connections) ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: source.sessionKey, runId: source.runId, state: "final" } }) }));
        if (options.blockDrain && pid === 1) await drain;
        state.stopped = true;
        child.exitCode = 0;
        child.stdout.end(); child.stderr.end(); close({ status: 0 });
        if (options.failStop && pid === 1) throw new Error("owned group still running");
      } };
    }
  });
  t.after(async () => { controller.abort(new CallError("background operation stopped", 1)); for (const child of children.values()) child.release(); await running; await rm(root, { recursive: true, force: true }); });
  await published;
  const restartArgs = ["--env", env, "--gateway-handle", handlePath, "--from", sourcePath, "--drain-ms", "1000", "--out", join(root, "observation.json"), "--timeout", "60000"];
  const doctorArgs = ["--env", env, "--gateway-handle", handlePath, "--timeout", "60000"];
  return { env, root, handlePath, sourcePath, sourceOperation, source, row, events, calls, children, controller, running, restartArgs, doctorArgs, launches: () => launch, signalAt: () => signalAt };
}

test("restart requires the exact template flags and a separate output", async (t) => {
  const data = await fixture(t);
  assert.equal(parseScriptArgs(restart, data.restartArgs).drainMs, 1000);
  for (const name of ["--gateway-handle", "--from", "--drain-ms", "--out", "--timeout"]) {
    const args = [...data.restartArgs], index = args.indexOf(name);
    args.splice(index, 2);
    assert.throws(() => parseScriptArgs(restart, args), CallError);
  }
  const args = [...data.restartArgs]; args[args.indexOf("--out") + 1] = data.sourcePath;
  assert.equal((await scriptMain(restart, args)).exitCode, 2);
  assert.equal(data.launches(), 1);
});

test("submitted turn binds receipt, environment, operation and unfinished lifetime", async (t) => {
  const data = await fixture(t);
  assert.deepEqual(await submittedTurn(data.sourcePath, data.env), data.source);
  for (const patch of [{ operationId: "other" }, { env: "other" }, { entry: "session-send-turn" }, { runId: "" }]) {
    await atomicJson(join(data.sourceOperation.directory, "submitted-turn.json"), { ...data.source, ...patch });
    await assert.rejects(submittedTurn(data.sourcePath, data.env), CallError);
  }
  await atomicJson(join(data.sourceOperation.directory, "submitted-turn.json"), data.source);
  await atomicJson(join(data.sourceOperation.directory, "result.json"), { output: {}, exitCode: 0 });
  await assert.rejects(submittedTurn(data.sourcePath, data.env), /completed/);
});

test("short budgets refuse without pausing or creating a request", async (t) => {
  const data = await fixture(t);
  await assert.rejects(requestGatewayLifecycle({ env: data.env, "gateway-handle": data.handlePath, operation: "doctor-repair", timeoutMs: 1000 }), (error) => error.exitCode === 3);
  await assert.rejects(readFile(`${data.handlePath}.d/fixture-request.json`), { code: "ENOENT" });
  assert.equal(data.launches(), 1);
});

for (const kind of ["different-run", "finished", "queued"]) test(`restart refuses ${kind} without stopping the Gateway`, async (t) => {
  const data = await fixture(t, { row: (row) => ({ ...row, ...(kind === "different-run" ? { activeRunIds: ["other"] } : kind === "finished" ? { hasActiveRun: false, status: "done" } : { status: "queued" }) }) });
  const result = await scriptMain(restart, data.restartArgs);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(Object.keys(result.output).sort(), restartFields);
  assert.equal(result.output.runId, null);
  assert.equal(data.launches(), 1);
  assert.equal(data.events.includes("stop-1"), false);
});

test("restart bounds drain and resumes the same handle after the exact active turn", async (t) => {
  const data = await fixture(t, { blockDrain: true });
  const before = JSON.parse(await readFile(data.handlePath, "utf8"));
  const result = await scriptMain(restart, data.restartArgs);
  assert.equal(result.exitCode, 0, result.output.error);
  assert.equal(result.output.runId, data.source.runId);
  assert.equal(result.output.sessionId, data.row.sessionId);
  assert.equal(result.output.interrupted, true);
  assert.equal(result.output.ready, true);
  assert.equal(result.output.previousPid, 1);
  assert.equal(result.output.pid, 2);
  const elapsed = data.signalAt() - data.children.get(1).stopAt;
  assert.ok(elapsed >= 950 && elapsed < 2000, `drain took ${elapsed}ms`);
  const after = JSON.parse(await readFile(data.handlePath, "utf8"));
  assert.equal(after.ref.id, before.ref.id);
  assert.equal(after.ref.pid, 2);
  assert.deepEqual(JSON.parse(await readFile(join(data.root, "observation.json"), "utf8")), result.output);
});

test("a turn completed during drain fails observation but still resumes its owner", async (t) => {
  const data = await fixture(t, { completeDuringDrain: true });
  const result = await scriptMain(restart, data.restartArgs);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.runId, null);
  assert.equal(result.output.ready, false);
  assert.equal(data.launches(), 2);
});

for (const mode of ["success", "failure", "cancelled"]) test(`offline Doctor resumes its owner after ${mode}`, async (t) => {
  const caller = new AbortController();
  const data = await fixture(t, { doctor: async () => {
    if (mode === "cancelled") caller.abort(new CallError("interrupted by SIGTERM", 3));
    return { status: mode === "failure" ? 1 : 0, value: { status: mode === "failure" ? 1 : 0, doctorFixSucceeded: mode !== "failure", doctorUnrepairedFindingCount: mode === "failure" ? 1 : 0, errors: mode === "failure" ? ["not repaired"] : [], stdoutSnippet: "inspection" } };
  } });
  const result = await scriptMain(doctor, data.doctorArgs, { signal: caller.signal });
  assert.equal(result.exitCode, mode === "success" ? 0 : mode === "cancelled" ? 3 : 1, result.output.error);
  assert.equal(data.launches(), 2);
  assert.deepEqual(Object.keys(result.output).sort(), ["error", "repairs"]);
  assert.equal(result.output.repairs.gateway.stopped, true);
  assert.equal(result.output.repairs.gateway.ready, true);
  assert.ok(data.events.indexOf("stop-1") < data.events.indexOf("doctor"));
  assert.ok(data.events.indexOf("doctor") < data.events.indexOf("start-2"));
});

test("unconfirmed stop prevents offline repair and replacement startup", async (t) => {
  const data = await fixture(t, { failStop: true });
  const result = await scriptMain(doctor, data.doctorArgs);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.repairs, null);
  assert.equal(data.events.includes("doctor"), false);
  assert.equal(data.launches(), 1);
  assert.equal((await data.running).cleanupComplete, false);
});

test("failed replacement startup cannot publish a successful restart", async (t) => {
  const data = await fixture(t, { failRestart: true });
  const result = await scriptMain(restart, data.restartArgs);
  assert.equal(result.exitCode, 3);
  assert.equal(result.output.ready, false);
  assert.equal(data.children.get(2).stopped, true);
});

test("lifecycle requests match the pinned Gateway schemas", (t) => schemas.report(t));
