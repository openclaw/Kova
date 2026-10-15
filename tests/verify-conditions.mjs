import "./verify-condition-browser.mjs";
import "./verify-condition-state.mjs";
import "./verify-condition-api.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { admitConditionRuntime, executeCondition, parseConditionOptions } from "../support/verify/condition.mjs";
import { runSearchCompleteness } from "../support/verify/session-search-completeness.mjs";
import { runSearchOverlap } from "../support/verify/session-search-overlap.mjs";

const context = (client, options = {}) => ({ options, signal: new AbortController().signal, remaining: () => 300000, connect: async () => client, cleanup: () => {}, observe: async (rpc, method, params, limits) => { try { return { status: "completed", result: await rpc.request(method, params, limits), elapsedMs: 1 }; } catch (error) { return { status: /timeout/.test(error.message) ? "timeout" : "error", error: error.message, elapsedMs: 1 }; } } });

test("condition admission rejects external agent roots before product calls", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "kova-condition-")));
  try {
    const root = join(parent, "kova-run-copy"); await mkdir(join(root, ".openclaw"), { recursive: true });
    const configPath = join(root, ".openclaw/openclaw.json");
    await writeFile(configPath, JSON.stringify({ agents: { list: [{ id: "main", agentDir: join(parent, "source/agent") }] } }));
    await assert.rejects(admitConditionRuntime({ root, configPath }), /external agent path/);
    await writeFile(configPath, JSON.stringify({ agents: { list: [{ id: "main", agentDir: join(root, "agent") }] } }));
    assert.equal((await admitConditionRuntime({ root, configPath })).root, root);
    const alias = join(parent, "alias"); await symlink(root, alias);
    await assert.rejects(admitConditionRuntime({ root: alias }), /invalid clone root/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("condition CLI refuses protected names and duplicate options", () => {
  const spec = { flags: [] };
  assert.throws(() => parseConditionOptions(spec, ["--env", "main-live", "--out", "proof.json"]), /disposable/);
  assert.throws(() => parseConditionOptions(spec, ["--env", "kova-run-copy", "--out", "proof.json", "--env", "kova-run-other"]), /repeated/);
});

test("condition cleanup runs before closing clients and preserves product observations", async () => {
  const events = [];
  const result = await executeCondition({ id: "test" }, { env: "kova-run-copy", timeoutMs: 1000 }, async (ctx) => {
    await ctx.connect(); ctx.cleanup(async () => { events.push("cleanup"); throw new Error("fixture removal failed"); });
    return { falseIndexing: 4 };
  }, { prepare: () => ({}), admit: async (x) => x, connect: async () => ({ client: { close: () => events.push("close") } }) });
  assert.deepEqual(events, ["cleanup", "close"]);
  assert.equal(result.output.falseIndexing, 4); assert.equal(result.exitCode, 1);
  assert.match(result.output.error, /cleanup/);
});

test("search completeness preserves stable matches with false indexing flags", async () => {
  const match = { sessionKey: "agent:main:retained", sessionId: "session", messageId: "message" };
  for (const broken of [false, true]) {
    let explicitCalls = 0, concurrent = 0, maximum = 0;
    const client = { async request(method, params) {
      assert.equal(method, "sessions.search");
      if (params.agentId) assert.deepEqual(params.sessionKeys, [match.sessionKey]);
      if (params.agentId) explicitCalls++;
      const indexing = broken && params.agentId && explicitCalls > 1;
      concurrent++; maximum = Math.max(maximum, concurrent); await sleep(1); concurrent--;
      return { results: [match], ...(indexing ? { indexing: true } : {}) };
    } };
    const result = await runSearchCompleteness(context(client, { "session-key": match.sessionKey, query: "marker", "scope-agent": "research" }));
    assert.equal(result.trials.length, 76); assert.equal(result.changedMatches, 0); assert.equal(maximum, 8);
    assert.equal(result.falseIndexing, broken ? 64 : 0); assert.equal(result.completeWithoutIndexing, !broken);
  }
});

test("overlap uses one live connection and observes writes while searches remain pending", async () => {
  const events = []; let key, runId;
  const client = { async request(method, params) {
    events.push(method);
    if (method === "sessions.create") { key = params.key; return { key, sessionId: "session" }; }
    if (method === "sessions.search") { await sleep(8); return { results: [{ sessionKey: "retained" }] }; }
    if (method === "progressCard.put") { await sleep(10); return { ok: true }; }
    if (method === "chat.send") { runId = params.idempotencyKey; return { runId }; }
    if (method === "agent.wait") return { status: "ok" };
    if (method === "chat.history") return { messages: [{ role: "assistant", __openclaw: { runId } }] };
    throw new Error(method);
  } };
  const result = await runSearchOverlap(context(client, { "session-key": "retained", query: "marker" }));
  assert.equal(result.searchesAtSave, 8); assert.ok(result.overlappingSearches >= 8);
  assert.equal(result.conditionEstablished, true); assert.equal(result.chat.status, "completed");
  assert.equal(events.filter((x) => x === "sessions.search").length, 25);
});

test("condition deadlines reserve cleanup time before accepting short budgets", async () => {
  assert.throws(() => parseConditionOptions({ flags: [], cleanupMs: 15000 }, ["--env", "kova-run-copy", "--out", "proof.json", "--timeout", "1000"]), /reserve/);
  const events = [];
  const result = await executeCondition({ id: "bounded", cleanupMs: 40 }, { env: "kova-run-copy", timeoutMs: 80 }, async (ctx) => {
    ctx.cleanup(async () => { await sleep(5); events.push("restored"); });
    await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
  }, { prepare: () => ({}), admit: async (x) => x });
  assert.equal(result.exitCode, 1); assert.match(result.output.error, /deadline/); assert.deepEqual(events, ["restored"]);
});
