import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { atomicJson, CallError } from "../support/verify/background.mjs";
import { definition as restart, finishRestartChildren, prepareRestartDuringTurn, restartChildren } from "../support/verify/restart-during-turn.mjs";
import { parseScriptArgs, scriptMain } from "../support/verify/script.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-restart-children-"));
  const controller = new AbortController(), env = "kova-scripts-restart-children", now = Date.now();
  const sourcePath = join(root, "parent.json");
  const operation = { schema: "kova.gateway.operation.v1", id: randomUUID(), entry: "chat-send", method: "chat-send", env, handlePath: sourcePath, directory: `${sourcePath}.d`, expiresAt: new Date(now + 60000).toISOString() };
  const source = { operationId: operation.id, env, entry: "chat-send", sessionKey: "agent:main:main", runId: randomUUID() };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  await atomicJson(sourcePath, { entry: operation.entry, env, ref: { id: operation.id, directory: operation.directory } });
  await atomicJson(join(operation.directory, "submitted-turn.json"), source);
  const spawn = (index) => {
    const sessionKey = `agent:main:subagent:${randomUUID()}`, runId = randomUUID(), id = `spawn-${index}`;
    return { callerSessionKey: "agent:main:restart-spawner", sessionKey, toolCall: { id, name: "sessions_spawn", args: { task: "held child" } }, toolResult: { toolCallId: id, details: { status: "accepted", childSessionKey: sessionKey, runId } }, createdIds: [sessionKey, runId], reply: [], elapsedMs: 1, error: null };
  };
  const records = [spawn(1), spawn(2)], paths = [join(root, "child-one.json"), join(root, "child-two.json")];
  for (let index = 0; index < 2; index++) await atomicJson(paths[index], records[index]);
  const options = { env, from: sourcePath, source, "child-from": paths[0], "second-child-from": paths[1], drainMs: 1000, overallExpiresAt: now + 60000 };
  options.children = await restartChildren(options, source, controller.signal);
  const request = { id: randomUUID(), expiresAt: now + 10000, options };
  const context = { signal: controller.signal, operation: { directory: root } };
  const rows = new Map([
    [source.sessionKey, { key: source.sessionKey, sessionId: randomUUID(), status: "running", hasActiveRun: true, activeRunIds: [source.runId] }],
    ...options.children.map((child) => [child.sessionKey, { key: child.sessionKey, sessionId: randomUUID(), spawnedBy: child.callerSessionKey, status: "running", hasActiveRun: true, activeRunIds: [child.runId] }])
  ]);
  const sockets = [], calls = [];
  let closed = 0, onRequest;
  const dependencies = { connect: async () => {
    const ws = new EventTarget(); sockets.push(ws);
    return { client: { ws, close() { closed++; }, async request(method, params) {
      schemas.check(method, params); calls.push({ method, params });
      onRequest?.(method, params, ws);
      if (method === "sessions.messages.subscribe") return { ok: true };
      if (method === "sessions.describe") return { session: rows.get(params.key) };
      if (method === "chat.history") {
        const child = options.children.find((child) => child.sessionKey === params.sessionKey);
        return { sessionKey: params.sessionKey, sessionId: rows.get(params.sessionKey)?.sessionId, inFlightRun: { runId: child?.runId ?? source.runId } };
      }
      throw new Error(method);
    } } };
  } };
  t.after(async () => { controller.abort(); await rm(root, { recursive: true, force: true }); });
  const args = ["--env", env, "--gateway-handle", join(root, "gateway.json"), "--from", sourcePath, "--drain-ms", "1000", "--out", join(root, "result.json"), "--timeout", "60000", "--child-from", paths[0], "--second-child-from", paths[1]];
  return { root, env, source, paths, records, request, context, dependencies, rows, sockets, calls, controller, args, closed: () => closed, onRequest: (callback) => { onRequest = callback; } };
}

function terminalRows(data, prepared) {
  for (const child of prepared.children) data.rows.set(child.sessionKey, {
    ...data.rows.get(child.sessionKey), hasActiveRun: false, activeRunIds: [],
    status: "interrupted", lastRunId: child.runId, endedAt: Date.now()
  });
}

test("restart child inputs require paired distinct successful spawn identities", async (t) => {
  const data = await fixture(t);
  const options = parseScriptArgs(restart, data.args);
  assert.equal(options["child-from"], resolve(data.paths[0]));
  assert.equal(options["second-child-from"], resolve(data.paths[1]));
  assert.throws(() => parseScriptArgs(restart, data.args.slice(0, -2)), /both/);
  assert.equal((await restartChildren({}, data.source)).length, 0);
  const alternateResult = { ...data.records[1].toolResult, toolCallId: undefined, tool_call_id: data.records[1].toolCall.id };
  await atomicJson(data.paths[1], { ...data.records[1], toolResult: alternateResult });
  assert.deepEqual(await restartChildren(data.request.options, data.source), data.request.options.children);
  for (const patch of [
    { error: "spawn failed" },
    { createdIds: [] },
    { sessionKey: data.source.sessionKey },
    { callerSessionKey: "agent:main:other-caller" },
    { toolCall: { id: "other-call", name: "sessions_spawn" } }
  ]) {
    await atomicJson(data.paths[1], { ...data.records[1], ...patch });
    await assert.rejects(restartChildren(data.request.options, data.source), CallError);
  }
  await atomicJson(data.paths[1], data.records[0]);
  await assert.rejects(restartChildren(data.request.options, data.source), /distinct/);
});

test("restart child arguments retain exact identities through the lifecycle response", async (t) => {
  const data = await fixture(t);
  const observed = data.request.options.children.map((child) => ({ ...child, sessionId: data.rows.get(child.sessionKey).sessionId, lastRunId: child.runId, status: "interrupted", endedAt: Date.now() }));
  const result = await scriptMain(restart, data.args, { context: { requestLifecycle: async (options) => {
    assert.deepEqual(options.children, data.request.options.children);
    assert.equal(options["child-from"], data.paths[0]);
    assert.equal(options["second-child-from"], data.paths[1]);
    return { exitCode: 0, output: { ...restart.empty(), sessionKey: data.source.sessionKey, sessionId: data.rows.get(data.source.sessionKey).sessionId, runId: data.source.runId, previousPid: 11, pid: 12, drainMs: 1000, interrupted: true, ready: true, children: observed, error: null } };
  } } });
  assert.equal(result.exitCode, 0, JSON.stringify(result.output));
  assert.deepEqual(result.output.children, observed);
});

test("both children must be simultaneously active before interruption", async (t) => {
  const data = await fixture(t), first = data.request.options.children[0];
  for (const patch of [
    { status: "queued" },
    { activeRunIds: ["different-run"] },
    { hasActiveRun: false, activeRunIds: [] },
    { spawnedBy: "agent:main:other-caller" }
  ]) {
    const original = data.rows.get(first.sessionKey);
    data.rows.set(first.sessionKey, { ...original, ...patch });
    await assert.rejects(prepareRestartDuringTurn(data.request, {}, data.context, data.dependencies), /exact active run/);
    data.rows.set(first.sessionKey, original);
  }
  data.onRequest((method, params, ws) => {
    if (method === "sessions.describe" && params.key === data.request.options.children[1].sessionKey) ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: first.sessionKey, runId: first.runId, state: "final" } }) }));
  });
  await assert.rejects(prepareRestartDuringTurn(data.request, {}, data.context, data.dependencies), /completed/);
});

test("restart observes exact physical child terminal outcomes and closes both connections", async (t) => {
  const data = await fixture(t);
  for (const row of data.rows.values()) delete row.activeRunIds;
  const prepared = await prepareRestartDuringTurn(data.request, {}, data.context, data.dependencies);
  assert.equal(prepared.children.length, 2);
  assert.deepEqual(data.calls.filter((call) => call.method === "sessions.messages.subscribe").map((call) => call.params.key), [data.source.sessionKey, ...data.request.options.children.map((child) => child.sessionKey)]);
  prepared.beginInterruption();
  terminalRows(data, prepared);
  prepared.close();
  const outcomes = await finishRestartChildren(data.request, prepared, {}, data.context, data.dependencies);
  assert.equal(outcomes.length, 2);
  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(outcome.runId, prepared.children[index].runId);
    assert.equal(outcome.sessionId, prepared.children[index].sessionId);
    assert.equal(outcome.lastRunId, outcome.runId);
    assert.equal(outcome.status, "interrupted");
  }
  assert.equal(data.closed(), 2);
  assert.deepEqual(await finishRestartChildren(data.request, { children: [] }, {}, data.context, { connect: () => assert.fail("parent-only restart must not add requests") }), []);
});

test("restart refuses replacement sessions, unrelated terminal runs and missing outcomes", async (t) => {
  const data = await fixture(t);
  const prepared = await prepareRestartDuringTurn(data.request, {}, data.context, data.dependencies);
  prepared.beginInterruption(); prepared.close();
  terminalRows(data, prepared);
  const first = prepared.children[0], original = data.rows.get(first.sessionKey);
  for (const patch of [{ sessionId: "replacement" }, { lastRunId: "different-run" }]) {
    data.rows.set(first.sessionKey, { ...original, ...patch });
    await assert.rejects(finishRestartChildren(data.request, prepared, {}, data.context, data.dependencies), /identity changed|another run/);
  }
  data.rows.set(first.sessionKey, { ...original, lastRunId: undefined });
  const expiring = { ...data.request, expiresAt: Date.now() + 20 };
  await assert.rejects(finishRestartChildren(expiring, prepared, {}, data.context, data.dependencies), (error) => error.exitCode === 3);
  data.controller.abort(new Error("cancel child observation"));
  await assert.rejects(finishRestartChildren(data.request, prepared, {}, data.context, data.dependencies), /cancel child observation/);
});

test("restart children requests match the pinned Gateway schemas", (t) => schemas.report(t));
