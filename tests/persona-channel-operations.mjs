import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCatalogue } from "../src/catalogue.mjs";
import { channelContent, fillPairSession, watchPairSession, spawnThreadSubagent, fillBoundThread, spawnChild, resumeChild, readChannelReceipt, writeChannelReceipt } from "../support/persona/channel-content.mjs";
import { patchSessionOperation, sessionPatchFields } from "../support/persona/session-operation.mjs";

const parent = "agent:main:kova-channel-probe:group:persona";
const child = "agent:main:subagent:11111111-1111-4111-8111-111111111111";
const threadId = "kova-thread-11111111-1111-4111-8111-111111111111";
const toolResult = (runId, toolName, details) => ({ events: [{ event: { type: "message", message: { role: "toolResult", toolName, details, __openclaw: { runId } } } }] });
const inbound = (params, key, runId) => ({ ok: true, observation: { inboundEvent: { id: params.inboundEventId }, routeSessionKey: key, dispatched: true, runId } });

test("peer construction and explicit watch are separate product mutations", async () => {
  const target = "agent:main:kova-channel-probe:direct:peer-b";
  const mutations = [];
  const rpc = async ({ method, params }) => {
    if (method === "kova.channelProbe.status") return { ok: true, channelId: channelContent.channel, accountId: "default", dmScope: "per-channel-peer" };
    if (method === "agent.wait") return { runId: params.runId, status: "ok" };
    if (method === "sessions.describe") return { session: { key: params.key, sessionId: "saved-id", status: "done" } };
    if (method === "chat.history") return { messages: [] };
    mutations.push(method);
    if (method === "kova.channelProbe.inject") return inbound(params, target, "peer-run");
    assert.equal(method, "sessions.send");
    assert.equal(params.key, channelContent.pairA);
    const command = JSON.parse(params.message.slice("KOVA_TOOL_CALL ".length));
    assert.equal(command.name, "sessions_send");
    assert.equal(command.arguments.sessionKey, target);
    assert.equal(command.arguments.watch, true);
    return { runId: "watch-parent-run" };
  };
  assert.deepEqual(await fillPairSession({ rpc }), { key: target, peer: channelContent.pairPeer });
  assert.deepEqual(mutations, ["kova.channelProbe.inject"]);
  const watched = await watchPairSession({ rpc, state: "/unused", watcher: channelContent.pairA, target,
    readSession: async () => toolResult("watch-parent-run", "sessions_send", { watched: true, sessionKey: target, status: "accepted", runId: "watched-run" }) });
  assert.deepEqual(watched, { keyA: channelContent.pairA, keyB: target });
  assert.deepEqual(mutations, ["kova.channelProbe.inject", "sessions.send"]);
});

test("thread creation leaves the independent routed continuation to its own command", async () => {
  const binding = { targetSessionKey: child, targetKind: "subagent", status: "active", metadata: { label: channelContent.threadLabel },
    conversation: { channel: channelContent.channel, accountId: channelContent.account, parentConversationId: channelContent.groupPeer, conversationId: threadId } };
  let phase = "spawn";
  const mutations = [];
  const rpc = async ({ method, params }) => {
    if (method === "kova.channelProbe.status") return { threadBindings: true };
    if (method === "kova.channelProbe.bindings") return { bindings: [binding] };
    if (method === "sessions.describe") return { session: { key: child, sessionId: "child-id", status: "done" } };
    if (method === "agent.wait") return { runId: params.runId, status: "ok" };
    mutations.push(method);
    assert.equal(method, "kova.channelProbe.inject");
    assert.equal(params.targetId, channelContent.groupPeer);
    assert.equal(params.wasMentioned, true);
    if (phase === "spawn") {
      assert.equal(params.threadId, undefined);
      const command = JSON.parse(params.message.slice("KOVA_TOOL_CALL ".length));
      assert.equal(command.name, "sessions_spawn");
      assert.equal(command.arguments.thread, true);
      return inbound(params, parent, "parent-run");
    }
    assert.equal(params.threadId, threadId);
    assert.match(params.message, /KOVA_BOUND_THREAD/);
    return inbound(params, child, "continuation-run");
  };
  const result = await spawnThreadSubagent({ rpc, state: "/unused", parent, toolModel: "openai/mock-tools",
    readSession: async () => toolResult("parent-run", "sessions_spawn", { status: "accepted", runId: "child-run", childSessionKey: child }) });
  assert.deepEqual(result, { key: child, peer: `${channelContent.groupPeer}/thread:${threadId}` });
  const { catalogue } = await loadCatalogue("openclaw");
  const spawnEntry = catalogue.entries.find(({ id }) => id === "persona-spawn-thread-subagent");
  // Both returned identifiers are created by the spawn and must normalize across runs.
  assert.deepEqual(spawnEntry.creates.toSorted(), Object.keys(result).map((key) => `/${key}`).toSorted());
  assert.deepEqual(catalogue.entries.find(({ id }) => id === "persona-continue-thread").creates, []);
  assert.deepEqual(mutations, ["kova.channelProbe.inject"]);
  phase = "continue";
  assert.deepEqual(await fillBoundThread({ rpc, key: result.key }), result);
  assert.deepEqual(mutations, ["kova.channelProbe.inject", "kova.channelProbe.inject"]);
});

test("each child spawn and the yielded child's continuation have independent entries", async () => {
  const sent = [];
  const rpc = async ({ method, params }) => {
    if (method === "agent.wait") return { runId: params.runId, status: "ok" };
    assert.equal(method, "sessions.send");
    sent.push(params);
    return { runId: "parent-run" };
  };
  for (const yielded of [false, true]) {
    const label = yielded ? "kova-persona-yield-history" : "kova-persona-finished";
    const result = await spawnChild({ rpc, state: "/unused", parent, toolModel: "openai/mock-tools", yielded,
      readSession: async () => toolResult("parent-run", "sessions_spawn", { status: "accepted", runId: "child-run", childSessionKey: child }),
      readState: async () => ({ children: [{ runId: "child-run", childSessionKey: child, label, ...(yielded ? { pauseReason: "sessions_yield" } : { execution: { status: "terminal" } }) }] }) });
    assert.deepEqual(result, { key: child });
    assert.equal(sent.length, yielded ? 2 : 1);
    const command = JSON.parse(sent.at(-1).message.slice("KOVA_TOOL_CALL ".length));
    assert.equal(command.name, "sessions_spawn");
    assert.equal(command.arguments.label, label);
    assert.equal(command.arguments.task.includes("sessions_yield"), yielded);
  }
  assert.deepEqual(await resumeChild({ rpc, key: child }), { key: child });
  assert.equal(sent.length, 3);
  assert.equal(sent.at(-1).key, child);
  assert.match(sent.at(-1).message, /^KOVA_CHILD_RESUMED:/);
});

test("the shared patch entry guards exactly one mutation with the observed session identity", async () => {
  const requests = [];
  const fields = { category: "Verification notebook", color: "purple" };
  assert.deepEqual(await patchSessionOperation({ key: parent, agentId: "main", fields, rpc: async (request) => {
    requests.push(request);
    if (request.method === "sessions.describe") return { session: { key: parent, sessionId: "current-id" } };
    assert.deepEqual(request, { method: "sessions.patch", params: { key: parent, agentId: "main", expectedSessionId: "current-id", ...fields } });
    return { ok: true };
  } }), { key: parent, sessionId: "current-id" });
  assert.equal(requests.length, 2);
  await assert.rejects(patchSessionOperation({ key: parent, fields, rpc: async () => ({ session: { key: child, sessionId: "other-id" } }) }), /no saved identity/);
  const timeout = Object.assign(new Error("timed out"), { exitCode: 3 });
  await assert.rejects(patchSessionOperation({ key: parent, fields, rpc: async () => { throw timeout; } }), (error) => error === timeout);
});

test("session patch flags do not permit another operation or an identity override", () => {
  assert.deepEqual(sessionPatchFields({ fields: '{"model":"openai/mock-tools"}' }), { model: "openai/mock-tools" });
  assert.deepEqual(sessionPatchFields({ "snooze-for-ms": "60000" }, 1000), { snoozedUntil: 61000 });
  for (const args of [{}, { fields: "[]" }, { fields: "{}" }, { fields: "null" }, { fields: '{"key":"other"}' }, { fields: '{"expectedSessionId":"other"}' }, { fields: '{"pinned":"true"}' }, { fields: '{"label":"safe"}', "snooze-for-ms": "1" }, { "snooze-for-ms": "-1" }]) {
    assert.throws(() => sessionPatchFields(args), (error) => error.exitCode === 2);
  }
});

test("channel receipts retain generated keys between commands without overwriting prior output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kova-channel-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "child.json");
  assert.deepEqual(await writeChannelReceipt(path, { key: child }), { key: child });
  assert.deepEqual(await readChannelReceipt(path), { key: child });
  await assert.rejects(writeChannelReceipt(path, { key: parent }), { code: "EEXIST" });
  await writeFile(path, '{"key":"not-a-session"}');
  await assert.rejects(readChannelReceipt(path), (error) => error.exitCode === 2);
});
