import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { atomicJson, cleanupGatewayHandle } from "../support/verify/background.mjs";
import { definition as chat } from "../support/verify/chat-send.mjs";
import { definition as hold } from "../support/verify/session-turn-hold.mjs";
import { executeScript, parseScriptArgs, scriptMain } from "../support/verify/script.mjs";
import { loadGatewaySchemaAssertions } from "./helpers/gateway-schemas.mjs";

const schemas = await loadGatewaySchemaAssertions();
const env = "kova-turn-forms", key = "agent:main:turn-forms", sessionId = "physical-session";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-turn-forms-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function sourceAt(root, entry = "session-turn-hold") {
  const path = join(root, `${randomUUID()}.json`), now = Date.now();
  const operation = {
    schema: "kova.gateway.operation.v1", id: randomUUID(), entry, method: entry,
    env, handlePath: path, directory: `${path}.d`,
    startedAt: new Date(now - 10).toISOString(), expiresAt: new Date(now + 300000).toISOString()
  };
  const record = {
    operationId: operation.id, env, entry, sessionKey: key, runId: randomUUID(),
    ...(entry === "session-turn-hold" ? { submittedAtMs: now, holdMs: 240000, holdUntilMs: now + 240000, deadlineAtMs: now + 280000 } : {})
  };
  await atomicJson(join(operation.directory, "operation.json"), operation);
  await atomicJson(path, { entry, env, startedAt: operation.startedAt, ref: { id: operation.id, directory: operation.directory, expiresAt: operation.expiresAt } });
  await atomicJson(join(operation.directory, "submitted-turn.json"), record);
  return { path, operation, record };
}

function active(source, patch = {}) {
  return { session: { key, sessionId, status: "running", hasActiveRun: true, activeRunIds: [source.record.runId], ...patch } };
}

async function invoke(definition, flags, rpc, context = {}) {
  const calls = [];
  const result = await executeScript(definition, parseScriptArgs(definition, ["--env", env, ...flags]), {
    context,
    rpc: async (method, params, ctx) => { calls.push([method, structuredClone(params)]); return rpc(method, params, ctx); }
  });
  for (const [method, params] of calls) schemas.check(method, params);
  return result;
}

test("turn assertion flags retain ordinary waits and reject mixed forms", () => {
  const options = parseScriptArgs(hold, ["--env", env, "--session-key", key, "--from", "held.json", "--require-active", "--min-remaining-ms", "120000"]);
  assert.equal(options.from, resolve("held.json"));
  assert.equal(options.minRemainingMs, 120000);
  const queued = parseScriptArgs(chat, ["--env", env, "--session-key", key, "--message", "follow-up", "--queue-mode", "followup", "--background", "--handle", "queued.json", "--busy-from", "held.json"]);
  assert.equal(queued["busy-from"], resolve("held.json"));
  assert.equal(parseScriptArgs(chat, ["--wait", "queued.json"]).env, undefined);
  assert.equal(parseScriptArgs(hold, ["--wait", "held.json"]).from, undefined);
  for (const flags of [
    ["--from", "held.json", "--require-active"],
    ["--require-active", "--min-remaining-ms", "1", "--hold-ms", "10"],
    ["--from", "held.json", "--require-active", "--min-remaining-ms", "1", "--hold-ms", "10"]
  ]) assert.throws(() => parseScriptArgs(hold, ["--env", env, ...flags]));
  for (const flags of [
    ["--wait", "queued.json", "--session-key", key],
    ["--wait", "queued.json", "--expect-cancelled"],
    ["--wait", "queued.json", "--expect-cancelled", "--session-key", key],
    ["--env", env, "--message", "follow-up", "--expect-cancelled"],
    ["--env", env, "--message", "follow-up", "--busy-from", "held.json", "--queue-mode", "followup"]
  ]) assert.throws(() => parseScriptArgs(chat, flags));
});

test("held-turn assertions bind native activity and the remaining duration", async (t) => {
  const root = await directory(t), source = await sourceAt(root);
  const flags = ["--session-key", key, "--from", source.path, "--require-active", "--min-remaining-ms", "120000", "--timeout", "1000"];
  const good = await invoke(hold, flags, async (method) => { assert.equal(method, "sessions.describe"); return active(source); });
  assert.equal(good.exitCode, 0, JSON.stringify(good.output));
  assert.equal(good.output.runId, source.record.runId);
  assert.deepEqual(good.output.createdIds, []);
  const embedded = await invoke(hold, flags, async (method) => method === "sessions.describe"
    ? active(source, { activeRunIds: undefined })
    : { sessionKey: key, sessionId, inFlightRun: { runId: source.record.runId } });
  assert.equal(embedded.exitCode, 0, JSON.stringify(embedded.output));
  const wrongSession = await invoke(hold, flags, async () => active(source, { key: "agent:main:other" }));
  assert.equal(wrongSession.exitCode, 2);
  const wrongRun = await invoke(hold, [...flags.slice(0, -2), "--timeout", "25"], async () => active(source, { activeRunIds: ["other-run"] }));
  assert.equal(wrongRun.exitCode, 3);
  await atomicJson(join(source.operation.directory, "submitted-turn.json"), { ...source.record, deadlineAtMs: Date.now() + 1000 });
  const shortDeadline = await invoke(hold, flags, () => assert.fail("short operation deadline must cap the hold budget"));
  assert.equal(shortDeadline.exitCode, 2);
  await atomicJson(join(source.operation.directory, "submitted-turn.json"), { ...source.record, holdMs: 1000, holdUntilMs: source.record.submittedAtMs + 1000 });
  const insufficient = await invoke(hold, flags, () => assert.fail("expired budget must not query the Gateway"));
  assert.equal(insufficient.exitCode, 2);
  assert.match(insufficient.output.error, /insufficient remaining/);
  await atomicJson(join(source.operation.directory, "result.json"), { exitCode: 0, output: { error: null } });
  const completed = await invoke(hold, flags, () => assert.fail("completed source must not query the Gateway"));
  assert.equal(completed.exitCode, 2);
  assert.match(completed.output.error, /completed/);
});

test("busy admission requires the exact native queued input and still-running source", async (t) => {
  const root = await directory(t);
  for (const entry of ["session-turn-hold", "chat-send"]) {
    const source = await sourceAt(root, entry);
    let runId, recorded, published = false, waits = 0;
    const flags = ["--session-key", key, "--message", "follow-up", "--queue-mode", "followup", "--background", "--handle", join(root, "unused.json"), "--busy-from", source.path, "--timeout", "1000"];
    const result = await invoke(chat, flags, async (method, params) => {
      if (method === "sessions.describe") return active(source);
      if (method === "chat.send") { runId = params.idempotencyKey; return { runId, status: "started" }; }
      if (method === "chat.history" && params.inputRunIds) return { sessionKey: key, sessionId, inputReceipts: [{ runId, state: "pending", queued: true }] };
      if (method === "agent.wait") {
        assert.equal(published, true);
        return { runId, status: ++waits === 1 ? "pending" : "ok" };
      }
      if (method === "chat.history") return { sessionId, messages: [], hasMore: false };
      assert.fail(method);
    }, { recordAdmission: async (value) => { recorded = value; }, publishBackground: async () => { assert.equal(recorded.runId, runId); published = true; } });
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    assert.equal(waits, 2);
    assert.equal(recorded.producerRunId, source.record.runId);
    assert.equal(result.output.receipt.admission.runId, runId);
    for (const failure of ["foreign-input", "consumed", "source-finished"]) {
      let sent = false;
      const failed = await invoke(chat, flags, async (method, params) => {
        if (method === "sessions.describe") return active(source, sent && failure === "source-finished" ? { hasActiveRun: false, activeRunIds: [] } : {});
        if (method === "chat.send") { sent = true; runId = params.idempotencyKey; return { runId }; }
        if (method === "chat.history") return { sessionKey: key, sessionId, inputReceipts: [failure === "foreign-input" ? { runId: "other", state: "pending", queued: true } : { runId, state: "consumed", consumedByEventId: "event" }] };
        assert.fail(method);
      }, { publishBackground: () => assert.fail("invalid admission must not publish a handle") });
      assert.equal(failed.exitCode, 2, failure);
    }
  }
});

test("cancellation joins require an admitted input and its explicit native cancellation", async (t) => {
  const root = await directory(t), source = await sourceAt(root, "chat-send");
  const admission = {
    ...source.record, sessionId, producerOperationId: randomUUID(), producerRunId: randomUUID(),
    input: { runId: source.record.runId, state: "pending", queued: true }, observedAtMs: Date.now()
  };
  await atomicJson(join(source.operation.directory, "queue-admission.json"), admission);
  const completed = { exitCode: 0, cleanupComplete: true, output: { receipt: { runId: source.record.runId, completion: { runId: source.record.runId, status: "error" } }, reply: [], createdIds: [source.record.runId], error: null, elapsedMs: 1 } };
  await atomicJson(join(source.operation.directory, "result.json"), completed);
  const flags = ["--env", env, "--session-key", key, "--wait", source.path, "--expect-cancelled", "--timeout", "1000"];
  const call = async (input, responseSessionId = sessionId) => scriptMain(chat, flags, { rpc: async (method, params) => {
    schemas.check(method, params);
    assert.equal(method, "chat.history");
    assert.deepEqual(params.inputRunIds, [source.record.runId]);
    assert.equal(params.sessionId, sessionId);
    return { sessionKey: key, sessionId: responseSessionId, inputReceipts: input ? [input] : [] };
  } });
  const cancelled = { runId: source.record.runId, state: "pending", cancelled: true };
  const good = await call(cancelled);
  assert.equal(good.exitCode, 0, JSON.stringify(good.output));
  assert.deepEqual(good.output.receipt.cancellation, cancelled);
  assert.deepEqual(good.output.createdIds, []);
  for (const input of [null, { ...cancelled, runId: "foreign" }, { runId: source.record.runId, state: "consumed", consumedByEventId: "event" }]) assert.equal((await call(input)).exitCode, 2);
  assert.equal((await call(cancelled, "replaced-session")).exitCode, 2);
  await rm(join(source.operation.directory, "queue-admission.json"));
  assert.equal((await call(cancelled)).exitCode, 2);
});

test("waiting for a live turn receipt observes cancellation", async (t) => {
  const root = await directory(t), source = await sourceAt(root);
  await rm(join(source.operation.directory, "submitted-turn.json"));
  const controller = new AbortController();
  const pending = scriptMain(hold, ["--env", env, "--session-key", key, "--from", source.path, "--require-active", "--min-remaining-ms", "1", "--timeout", "10000"], { signal: controller.signal, rpc: () => assert.fail("no native run was recorded") });
  controller.abort(new Error("cancel turn assertion"));
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /cancel turn assertion/);
});

async function untilFile(path) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error(`file was not published: ${path}`);
    await sleep(10);
  }
}

test("background handles publish held identities live and queued admission before joins", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-turn-background-"));
  const holdPath = join(root, "held.json"), queuedPath = join(root, "queued.json");
  const holdFinish = join(root, "hold-finish.json"), queueRelease = join(root, "queue-release.json"), queueFinish = join(root, "queue-finish.json"), observed = join(root, "queue-observed.json");
  t.after(async () => {
    for (const path of [holdFinish, queueRelease, queueFinish]) await writeFile(path, "true");
    try {
      for (const path of [queuedPath, holdPath]) await cleanupGatewayHandle(path, { timeoutMs: 3000 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const makeWorker = async (definition, file) => {
    const path = join(root, file);
    await writeFile(path, `
import { readFile, writeFile } from "node:fs/promises";
import { definition } from ${JSON.stringify(definition.url)};
import { entrypoint } from ${JSON.stringify(new URL("../support/verify/script.mjs", import.meta.url).href)};
let runId, waits = 0;
const holdRecordPath = ${JSON.stringify(join(`${holdPath}.d`, "submitted-turn.json"))};
async function gate(path, ctx) {
  for (;;) {
    try { await readFile(path); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await ctx.pause(10);
  }
}
await entrypoint({ ...definition, url: import.meta.url }, { rpc: async (method, params, ctx) => {
  if (method === "sessions.send" || method === "chat.send") { runId = params.idempotencyKey; return { runId, status: "started" }; }
  if (method === "sessions.describe") {
    const held = JSON.parse(await readFile(holdRecordPath, "utf8"));
    return { session: { key: ${JSON.stringify(key)}, sessionId: ${JSON.stringify(sessionId)}, status: "running", hasActiveRun: true, activeRunIds: [held.runId] } };
  }
  if (method === "chat.history" && params.inputRunIds) {
    await writeFile(${JSON.stringify(observed)}, "true");
    await gate(${JSON.stringify(queueRelease)}, ctx);
    return { sessionKey: ${JSON.stringify(key)}, sessionId: ${JSON.stringify(sessionId)}, inputReceipts: [{ runId, state: "pending", queued: true }] };
  }
  if (method === "agent.wait") {
    if (definition.id === "session-turn-hold") { await gate(${JSON.stringify(holdFinish)}, ctx); return { runId, status: "ok" }; }
    if (++waits === 1) return { runId, status: "pending", timeoutPhase: "queue", providerStarted: false };
    await gate(${JSON.stringify(queueFinish)}, ctx);
    return { runId, status: "error", error: "aborted" };
  }
  if (method === "chat.history") return { sessionId: ${JSON.stringify(sessionId)}, messages: [], hasMore: false };
  throw new Error(method);
} });
`);
    return { ...definition, url: pathToFileURL(path).href };
  };
  const held = await scriptMain(await makeWorker(hold, "hold-worker.mjs"), ["--env", env, "--session-key", key, "--hold-ms", "30000", "--timeout", "10000", "--background", "--handle", holdPath]);
  assert.equal(held.exitCode, 0, JSON.stringify(held.output));
  const submitted = await untilFile(join(`${holdPath}.d`, "submitted-turn.json"));
  assert.equal(submitted.operationId, held.output.ref.id);
  assert.equal(submitted.holdUntilMs, submitted.submittedAtMs + 30000);
  const starting = scriptMain(await makeWorker(chat, "chat-worker.mjs"), ["--env", env, "--session-key", key, "--message", "queued input", "--queue-mode", "followup", "--busy-from", holdPath, "--background", "--handle", queuedPath, "--timeout", "10000"]);
  await untilFile(observed);
  await assert.rejects(readFile(queuedPath), { code: "ENOENT" });
  await writeFile(queueRelease, "true");
  const queued = await starting;
  assert.equal(queued.exitCode, 0, JSON.stringify(queued.output));
  const admitted = await untilFile(join(`${queuedPath}.d`, "queue-admission.json"));
  assert.equal(admitted.producerRunId, submitted.runId);
  assert.equal(admitted.operationId, queued.output.ref.id);
  await assert.rejects(readFile(join(`${queuedPath}.d`, "result.json")), { code: "ENOENT" });
  await writeFile(queueFinish, "true");
  const joined = await scriptMain(chat, ["--wait", queuedPath, "--timeout", "3000"]);
  assert.equal(joined.exitCode, 0, JSON.stringify(joined.output));
  assert.equal(joined.output.receipt.runId, admitted.runId);
  assert.equal(joined.output.receipt.completion.status, "error");
});

test("turn forms resolve requests against pinned Gateway schemas", (t) => schemas.report(t));
