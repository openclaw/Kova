import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as nodeModule from "node:module";
import { channelContent, channelRequests, channelRequestCases, checkChannelSessions, findToolReceipt, requireAcceptedSpawn, injectChannelMessage, fillMainSession, fillGroupSession, fillPairSession, waitForDmScope } from "../support/persona/channel-content.mjs";
import { openProbeBindings, probeBindingsFile } from "../support/plugins/kova-channel-probe/bindings.js";
import { probeRequestSchemas, validateProbeRequest } from "../support/plugins/kova-channel-probe/protocol.js";

test("channel input completion belongs to the admitted event and run", async () => {
  const seen = [];
  let release, started;
  const pending = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { started = resolve; });
  const rpc = async ({ method, params }) => {
    seen.push(method);
    if (method === "kova.channelProbe.inject") return { ok: true, observation: { inboundEvent: { id: params.inboundEventId }, routeSessionKey: "agent:main:main", dispatched: true, runId: "accepted-channel-run" } };
    assert.equal(method, "agent.wait");
    assert.equal(params.runId, "accepted-channel-run");
    started();
    return pending;
  };
  let finished = false;
  const run = injectChannelMessage(rpc, { peer: channelContent.mainPeer, message: "Notebook entry." }).then((key) => { finished = true; return key; });
  await waiting;
  assert.equal(finished, false);
  release({ runId: "accepted-channel-run", status: "ok" });
  assert.equal(await run, "agent:main:main");
  assert.deepEqual(seen, ["kova.channelProbe.inject", "agent.wait"]);
  await assert.rejects(injectChannelMessage(async ({ method, params }) => method === "kova.channelProbe.inject"
    ? { ok: true, observation: { inboundEvent: { id: params.inboundEventId }, routeSessionKey: "agent:main:main", dispatched: true, runId: "new-run" } }
    : { runId: "older-run", status: "ok" }, { peer: channelContent.mainPeer, message: "Notebook entry." }), /does not match/);
});

test("main and group builders use genuine inbound context and the UI request", async () => {
  const calls = [];
  let group = false;
  let statusReads = 0;
  const rpc = async (request) => {
    calls.push(request);
    if (request.method === "kova.channelProbe.status") return { ok: true, channelId: channelContent.channel, accountId: "default", dmScope: ++statusReads === 1 ? "per-channel-peer" : "main" };
    if (request.method === "kova.channelProbe.inject") {
      assert.ok(statusReads >= 2, "main input waits for the committed routing change");
      return { ok: true, observation: { inboundEvent: { id: request.params.inboundEventId }, routeSessionKey: group ? "agent:main:kova-channel-probe:group:example" : channelContent.mainKey, dispatched: true, runId: request.params.inboundEventId } };
    }
    if (request.method === "chat.send") return { runId: request.params.idempotencyKey };
    if (request.method === "agent.wait") return { runId: request.params.runId, status: "ok" };
    assert.fail(request.method);
  };
  await fillMainSession({ rpc, ingress: "direct", turns: 2 });
  assert.equal(calls.some(({ method }) => method === "chat.send"), false);
  await fillMainSession({ rpc, ingress: "ui", turns: 2 });
  assert.equal(calls.filter(({ method }) => method === "chat.send").length, 2);
  assert.equal(calls.filter(({ method }) => method === "kova.channelProbe.inject").length, 2);
  group = true;
  const builtGroup = await fillGroupSession({ rpc, turns: 2 });
  assert.equal(builtGroup.peer, channelContent.groupPeer);
  const groups = calls.filter(({ method, params }) => method === "kova.channelProbe.inject" && params.chatType === "group");
  assert.equal(groups.length, 2);
  assert.ok(groups.every(({ params }) => params.targetId === channelContent.groupPeer && params.senderId === channelContent.human && params.wasMentioned === true));
});

test("pair input waits for isolated routing and scope waits fail with a bounded timeout", async () => {
  let statusReads = 0, injected = false;
  const reached = new Error("injection reached");
  await assert.rejects(fillPairSession({ rpc: async ({ method }) => {
    if (method === "kova.channelProbe.status") return { ok: true, channelId: channelContent.channel, accountId: "default", dmScope: ++statusReads === 1 ? "main" : "per-channel-peer" };
    assert.equal(method, "kova.channelProbe.inject");
    assert.equal(statusReads, 2);
    injected = true;
    throw reached;
  } }), (error) => error === reached);
  assert.equal(injected, true);
  let reads = 0;
  await assert.rejects(waitForDmScope(async ({ method }) => {
    assert.equal(method, "kova.channelProbe.status");
    reads++;
    return { ok: true, channelId: channelContent.channel, accountId: "default", dmScope: "main" };
  }, "isolated", { timeoutMs: 0 }), (error) => error.exitCode === 3 && /isolated direct-message routing/.test(error.message));
  assert.equal(reads, 1);
});

async function loadProbePlugin(t, { asyncRouting = true } = {}) {
  const modules = new Map([
    ["openclaw/plugin-sdk/core", "export const definePluginEntry = (value) => value;"],
    ["openclaw/plugin-sdk/routing", "export const resolveThreadSessionKeys = ({baseSessionKey, threadId}) => ({sessionKey: baseSessionKey + ':thread:' + threadId});"],
    ["openclaw/plugin-sdk/channel-outbound", "export const defineChannelMessageAdapter = (value) => value; export const createMessageReceiveContext = ({id}) => ({id, ackPolicy:'after_agent_dispatch', ackState:'pending', shouldAckAfter:()=>false});"],
    ["openclaw/plugin-sdk/thread-bindings-session-runtime", "let adapter; export const registerSessionBindingAdapter = (value) => { adapter = value; }; export const unregisterSessionBindingAdapter = ({adapter: value}) => { if (adapter === value) adapter = undefined; }; export const readAdapter = () => adapter;"],
    ["openclaw/plugin-sdk/conversation-binding-runtime", asyncRouting
      ? `import { readAdapter } from "openclaw/plugin-sdk/thread-bindings-session-runtime";
        export const routeCalls = [];
        export const resolveRuntimeConversationBindingRouteAsync = async ({ route, ...ref }) => {
          routeCalls.push(ref);
          const binding = readAdapter()?.resolveByConversation(ref);
          return { route: binding ? { ...route, sessionKey: binding.targetSessionKey } : route };
        };`
      : "export const resolveRuntimeConversationBindingRoute = () => { throw new Error('the synchronous binding resolver must not be called'); };"]
  ]);
  const hook = nodeModule.registerHooks({ resolve(specifier, context, nextResolve) {
    const source = modules.get(specifier);
    return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : nextResolve(specifier, context);
  } });
  t.after(() => hook.deregister());
  return (await import("../support/plugins/kova-channel-probe/index.js")).default;
}

test("probe loads the channel-outbound SDK and preserves normalization, status and injection", { skip: typeof nodeModule.registerHooks !== "function" }, async (t) => {
  const entry = await loadProbePlugin(t);
  const old = { session: { dmScope: "per-channel-peer", store: "old-store" } };
  const updated = { session: { dmScope: "main", store: "new-store" } };
  let committed = old, reads = 0;
  for (const modern of [true, false]) {
    let channel, routedConfig, dispatchedConfig, store, mentioned;
    const methods = new Map();
    entry.register({
      runtime: { state: {}, config: modern ? { current() { reads++; return committed; } } : {} },
      registerChannel: (value) => { channel = value; },
      registerGatewayMethod: (name, handler) => methods.set(name, handler)
    });
    assert.equal(typeof methods.get("kova.channelProbe.normalizeCommand"), "function");
    const call = async (method, params = {}) => {
      let response;
      await methods.get(method)({ params, respond: (ok, result) => { assert.equal(ok, true); response = result; } });
      return response;
    };
    const controller = new AbortController();
    const running = channel.gateway.startAccount({ cfg: old, accountId: "default", abortSignal: controller.signal, channelRuntime: {
      routing: { resolveAgentRoute: ({ cfg }) => { routedConfig = cfg; committed = old; return { sessionKey: "agent:main:main", agentId: "main" }; } },
      session: { resolveStorePath: (value) => { store = value; return "unused-store"; }, recordInboundSession() {} },
      reply: { finalizeInboundContext: (value) => value, dispatchReplyWithBufferedBlockDispatcher() {} },
      inbound: { dispatchReply: async (params) => { dispatchedConfig = params.cfg; mentioned = params.ctxPayload.WasMentioned; params.replyOptions.onAgentRunStart("channel-run"); return { dispatched: true, routeSessionKey: params.routeSessionKey, admission: { kind: "dispatch" } }; } }
    } });
    try {
      await Promise.resolve();
      const initial = await call("kova.channelProbe.status");
      assert.equal(initial.ok, true);
      assert.equal(initial.dmScope, "per-channel-peer");
      committed = updated;
      const next = await call("kova.channelProbe.status");
      assert.equal(next.dmScope, modern ? "main" : "per-channel-peer");
      const before = reads;
      const result = await call("kova.channelProbe.inject", { message: "Notebook entry." });
      assert.equal(result.ok, true);
      assert.equal(reads - before, modern ? 1 : 0, "one current-config capture per injection");
      assert.equal(routedConfig, modern ? updated : old);
      assert.equal(dispatchedConfig, routedConfig);
      assert.equal(store, routedConfig.session.store);
      for (const wasMentioned of [false, true]) {
        const group = await call("kova.channelProbe.inject", { message: "Group entry.", targetId: channelContent.groupPeer, chatType: "group", wasMentioned });
        assert.equal(group.ok, true);
        assert.equal(mentioned, wasMentioned);
        assert.equal(group.observation.inboundEvent.wasMentioned, wasMentioned);
      }
    } finally { controller.abort(); await running; }
  }
});

test("partial routing SDK preserves ordinary inputs without opening binding storage", { skip: typeof nodeModule.registerHooks !== "function" }, async (t) => {
  for (const asyncRouting of [false, true]) await t.test(asyncRouting ? "complete routing SDK" : "synchronous-only routing SDK", async (t) => {
    const entry = await loadProbePlugin(t, { asyncRouting });
    const { readAdapter } = await import("openclaw/plugin-sdk/thread-bindings-session-runtime");
    const routing = await import("openclaw/plugin-sdk/conversation-binding-runtime");
    const routeCallsBefore = routing.routeCalls?.length ?? 0;
    const stateDir = await mkdtemp(join(tmpdir(), "kova-routing-capability-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    let channel, stateReads = 0;
    const dispatched = [];
    const methods = new Map();
    const cfg = { session: { dmScope: "main" } };
    entry.register({
      runtime: { state: { resolveStateDir: () => {
        assert.equal(asyncRouting, true, "partial routing support must not open storage");
        stateReads++;
        return stateDir;
      } }, config: { current: () => cfg } },
      registerChannel: (value) => { channel = value; },
      registerGatewayMethod: (name, handler) => methods.set(name, handler),
    });
    const call = async (method, params = {}) => {
      let response;
      await methods.get(method)({ params, respond: (ok, result) => { assert.equal(ok, true); response = result; } });
      return response;
    };
    const controller = new AbortController();
    let startupError;
    const running = channel.gateway.startAccount({ cfg, accountId: "default", abortSignal: controller.signal, channelRuntime: {
      routing: { resolveAgentRoute: () => ({ sessionKey: channelContent.mainKey, agentId: "main" }) },
      session: { resolveStorePath: () => "unused-store", recordInboundSession() {} },
      reply: { finalizeInboundContext: (value) => value, dispatchReplyWithBufferedBlockDispatcher() {} },
      inbound: { dispatchReply: async (params) => {
        dispatched.push(params.routeSessionKey);
        params.replyOptions.onAgentRunStart(`channel-run-${dispatched.length}`);
        return { dispatched: true, routeSessionKey: params.routeSessionKey, admission: { kind: "dispatch" } };
      } },
    } }).catch((error) => { startupError = error; });
    try {
      await waitForDmScope(async ({ method, params }) => {
        if (startupError) throw startupError;
        return call(method, params);
      }, "main");
      assert.equal((await call("kova.channelProbe.status")).threadBindings, asyncRouting);
      assert.equal(stateReads, asyncRouting ? 1 : 0);
      assert.equal(Boolean(readAdapter()), asyncRouting);
      const ordinary = await call("kova.channelProbe.inject", { message: "Ordinary notebook input.", targetId: channelContent.mainPeer });
      assert.equal(ordinary.observation.routeSessionKey, channelContent.mainKey);
      assert.deepEqual(dispatched, [channelContent.mainKey]);
      if (asyncRouting) {
        const childKey = "agent:main:subagent:11111111-1111-4111-8111-111111111111";
        const record = await readAdapter().bind(bindingInput(childKey));
        const threaded = await call("kova.channelProbe.inject", { message: "Bound notebook input.", targetId: channelContent.groupPeer, chatType: "group", wasMentioned: true, threadId: record.conversation.conversationId });
        assert.equal(threaded.observation.routeSessionKey, childKey);
        assert.deepEqual(dispatched, [channelContent.mainKey, childKey]);
        assert.deepEqual(routing.routeCalls.slice(routeCallsBefore), [
          { channel: channelContent.channel, accountId: "default", conversationId: channelContent.mainPeer },
          { channel: channelContent.channel, accountId: "default", conversationId: record.conversation.conversationId, parentConversationId: channelContent.groupPeer },
        ]);
        assert.equal(JSON.parse(await readFile(probeBindingsFile(stateDir), "utf8")).bindings[0].targetSessionKey, childKey);
      } else {
        assert.deepEqual(await readdir(stateDir), []);
      }
    } finally { controller.abort(); await running; }
    assert.equal(readAdapter(), undefined);
  });
});

test("committed and restarted thread bindings project to an admitted parent and the exact thread", { skip: typeof nodeModule.registerHooks !== "function" }, async (t) => {
  const f = await bindingFixture(t);
  const entry = await loadProbePlugin(t);
  const { readAdapter } = await import("openclaw/plugin-sdk/thread-bindings-session-runtime");
  let record;
  const clone = join(f.root, "clone");
  for (const stateDir of [f.source, clone]) {
    if (stateDir === clone) await cp(f.source, clone, { recursive: true });
    let channel;
    const methods = new Map();
    const cfg = { session: { dmScope: "main" } };
    entry.register({
      runtime: { state: { resolveStateDir: () => stateDir }, config: { current: () => cfg } },
      registerChannel: (value) => { channel = value; },
      registerGatewayMethod: (name, handler) => methods.set(name, handler)
    });
    const controller = new AbortController();
    let startupError;
    const running = channel.gateway.startAccount({ cfg, accountId: "default", abortSignal: controller.signal, channelRuntime: {} }).catch((error) => { startupError = error; });
    try {
      await waitForDmScope(async ({ method, params }) => {
        if (startupError) throw startupError;
        let response;
        await methods.get(method)({ params, respond: (ok, result) => { assert.equal(ok, true); response = result; } });
        return response;
      }, "main");
      if (!record) record = await readAdapter().bind(bindingInput("agent:main:subagent:11111111-1111-4111-8111-111111111111"));
      const projected = channel.messaging.resolveDeliveryTarget(record.conversation);
      assert.deepEqual(projected, { to: channelContent.groupPeer, threadId: record.conversation.conversationId });
      const normalized = channel.messaging.normalizeTarget(projected.to);
      assert.equal(normalized, channelContent.groupPeer);
      const admitted = await channel.messaging.targetResolver.resolveTarget({ input: projected.to, normalized });
      assert.equal(admitted.to, channelContent.groupPeer);
      assert.equal(admitted.kind, "group");
      assert.equal(channel.messaging.resolveDeliveryTarget({ ...record.conversation, parentConversationId: "group:kova-probe-group-other" }), null);
      const unknown = "kova-thread-ffffffff-ffff-4fff-8fff-ffffffffffff";
      assert.equal(channel.messaging.resolveDeliveryTarget({ conversationId: unknown, parentConversationId: channelContent.groupPeer }), null);
      assert.equal(channel.messaging.normalizeTarget(`channel:${unknown}`), undefined);
      assert.equal(await channel.messaging.targetResolver.resolveTarget({ input: `channel:${unknown}`, normalized: `channel:${unknown}` }), null);
      assert.deepEqual(channel.messaging.resolveDeliveryTarget({ conversationId: channelContent.mainPeer }), { to: channelContent.mainPeer });
    } finally { controller.abort(); await running; }
    assert.equal(readAdapter(), undefined);
  }
});

test("custom channel request cases cover their exact schemas and reject unknown or mistyped fields", () => {
  assert.deepEqual(Object.keys(channelRequests).sort(), Object.keys(channelRequestCases).sort());
  for (const [name, variants] of Object.entries(channelRequestCases)) for (const args of variants) {
    const request = channelRequests[name](...args);
    if (probeRequestSchemas[request.method]) assert.equal(validateProbeRequest(request.method, request.params), request.params);
  }
  for (const params of [{}, { message: "entry", sessionKey: "agent:main:fake" }, { message: "entry", chatType: "thread" }, { message: "entry", threadId: 17 }, { message: "entry", manualAck: "true" }, { message: "entry", wasMentioned: "true" }]) assert.throws(() => validateProbeRequest("kova.channelProbe.inject", params), /required|unknown|invalid/);
});

test("spawn rejection retains bounded product diagnostics while removing credentials", () => {
  const accepted = { status: "accepted", childSessionKey: "agent:main:subagent:child", runId: "child-run" };
  assert.equal(requireAcceptedSpawn(accepted, "thread spawn"), accepted);
  assert.throws(() => requireAcceptedSpawn({ ...accepted, runId: undefined }, "thread spawn"), /status=accepted.*missing an accepted child/);
  for (const status of ["error", "forbidden"]) {
    assert.throws(() => requireAcceptedSpawn({ status, error: "Thread bind failed: binding owner is unavailable.\nAuthorization: Bearer never-log-this\napiKey=also-private", token: "unrelated-private" }, "thread spawn"), (error) => {
      assert.match(error.message, new RegExp(`sessions_spawn status=${status}; Thread bind failed: binding owner is unavailable`));
      assert.ok(!/never-log-this|also-private|unrelated-private/.test(error.message));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.throws(() => requireAcceptedSpawn({ status: "private-status" }, "thread spawn"), (error) => !error.message.includes("private-status"));
  assert.throws(() => requireAcceptedSpawn({ status: "error", error: "bounded diagnostic ".repeat(10000) }, "thread spawn"), (error) => error.message.length < 600);
});

test("tool receipts are selected by the accepted run and include catalog-wrapped calls", () => {
  const receipt = { status: "accepted", runId: "child-run", childSessionKey: "agent:main:subagent:child" };
  const entry = (runId, name, details) => ({ event: { type: "message", message: { role: "toolResult", toolName: name, details, __openclaw: { runId } } } });
  const stored = { events: [entry("old-run", "sessions_spawn", receipt)] };
  assert.throws(() => findToolReceipt(stored, "sessions_spawn", "current-run"), /no unique/);
  stored.events.push(entry("current-run", "tool_call", { tool: { name: "sessions_spawn" }, result: { details: receipt } }));
  assert.equal(findToolReceipt(stored, "sessions_spawn", "current-run"), receipt);
  stored.events.push(entry("current-run", "sessions_spawn", receipt));
  assert.throws(() => findToolReceipt(stored, "sessions_spawn", "current-run"), /no unique/);
});

test("explicit watch checks require persisted provenance and preserve the actual peer identity", async () => {
  const keyB = "agent:main:kova-channel-probe:direct:peer-b";
  const watch = { watcher_session_key: channelContent.pairA, target_session_key: keyB, provenance: "explicit" };
  const saved = { sessionId: "saved-b", entry: { delivery: { kind: "external", origin: { provider: channelContent.channel, chatType: "direct", to: channelContent.pairPeer } } }, events: [] };
  const rpc = async ({ method, params }) => method === "sessions.resolve" ? { key: keyB } : method === "sessions.describe" ? { session: { key: params.key, sessionId: "saved-b", status: "done" } } : { messages: [] };
  const options = { rpc, state: "/unused", kind: "session-pair-watched", readSession: async () => saved, readState: async () => ({ watches: [watch] }) };
  assert.deepEqual(await checkChannelSessions(options), { keyA: channelContent.pairA, keyB, peerB: channelContent.pairPeer, sessionIdB: "saved-b" });
  watch.provenance = "ambient-group";
  await assert.rejects(checkChannelSessions(options), /explicit session watch is absent/);
  watch.provenance = "explicit";
  saved.entry.delivery.origin.to = "dm:another-peer";
  await assert.rejects(checkChannelSessions(options), /no saved direct-channel peer/);
});

test("group peer is the saved destination accepted by the inbound command", async () => {
  const key = "agent:main:kova-channel-probe:group:persona";
  const saved = {
    sessionId: "saved-group", entry: { delivery: { kind: "external", origin: { provider: channelContent.channel, chatType: "group", to: channelContent.groupPeer } } },
    events: Array.from({ length: 40 }, (_, index) => [
      { event: { type: "message", message: { role: "user", content: `KOVA_GROUP_NOTE_${index + 1}` } } },
      { event: { type: "message", message: { role: "assistant", content: "KOVA_AGENT_OK" } } }
    ]).flat()
  };
  const rpc = async ({ method, params }) => method === "sessions.describe" ? { session: { key: params.key, sessionId: saved.sessionId, status: "done" } } : { messages: [] };
  const result = await checkChannelSessions({ rpc, state: "/unused", kind: "session-group-watched", key, readSession: async () => saved,
    readState: async () => ({ watches: [{ watcher_session_key: channelContent.mainKey, target_session_key: key, provenance: "ambient-group" }] }) });
  assert.deepEqual(result, { key, peer: "group:kova-probe-group-persona" });
  const input = { message: "Unmentioned group chatter.", targetId: result.peer, chatType: "group", wasMentioned: false };
  assert.equal(validateProbeRequest("kova.channelProbe.inject", input), input);
});

test("thread verification survives runtime run pruning and requires durable lineage and spawn evidence", async () => {
  const parent = "agent:main:kova-channel-probe:group:persona";
  const child = "agent:main:subagent:11111111-1111-4111-8111-111111111111";
  const threadId = "kova-thread-11111111-1111-4111-8111-111111111111";
  const receipt = { status: "accepted", childSessionKey: child, runId: "old-child-run", mode: "session" };
  const parentStored = { sessionId: "saved-parent", entry: {}, events: [{ event: { type: "message", message: { role: "toolResult", toolName: "sessions_spawn", details: receipt, __openclaw: { runId: "parent-spawn-run" } } } }] };
  const childStored = { sessionId: "saved-child", entry: { spawnedBy: parent, parentSessionKey: parent }, events: [{ event: { type: "message", message: { role: "user", content: "KOVA_BOUND_THREAD" } } }] };
  const bindings = [{ targetSessionKey: child, targetKind: "subagent", status: "active", conversation: { channel: channelContent.channel, accountId: "default", parentConversationId: channelContent.groupPeer, conversationId: threadId } }];
  let registryReads = 0;
  const options = { kind: "session-thread-bound", key: child, state: "/unused", rpc: async ({ method }) => {
    if (method === "sessions.resolve") return { key: parent };
    if (method === "sessions.describe") return { session: { key: child, sessionId: childStored.sessionId, status: "done" } };
    if (method === "chat.history") return { messages: [] };
    assert.equal(method, "kova.channelProbe.bindings");
    return { bindings };
  }, readSession: async (_state, key, selection) => {
    if (key === parent) { assert.equal(selection.allWindows, true); return parentStored; }
    assert.equal(key, child); return childStored;
  }, readState: async () => { registryReads++; return { children: [] }; } };
  const result = await checkChannelSessions(options);
  assert.equal(result.peer, `group:kova-probe-group-persona/thread:${threadId}`);
  assert.equal(registryReads, 0, "durable checks must not depend on pruned runtime records");
  const matched = /^group:([^/]+)\/thread:(.+)$/.exec(result.peer);
  assert.ok(matched);
  assert.equal(`group:${matched[1]}`, channelContent.groupPeer);
  assert.equal(matched[2], threadId);
  childStored.entry.parentSessionKey = "agent:main:unrelated";
  await assert.rejects(checkChannelSessions(options), /saved parent relationship/);
  childStored.entry.parentSessionKey = parent;
  receipt.mode = "run";
  await assert.rejects(checkChannelSessions(options), /saved session-mode spawn receipt/);
  receipt.mode = "session";
  parentStored.events = [];
  await assert.rejects(checkChannelSessions(options), /saved session-mode spawn receipt/);
});

async function bindingFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-binding-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  let adapter;
  const bindingApi = { registerSessionBindingAdapter: (value) => { adapter = value; }, unregisterSessionBindingAdapter: ({ adapter: value }) => { assert.equal(value, adapter); adapter = undefined; } };
  const openAt = async (stateDir) => openProbeBindings({ state: {
    resolveStateDir: () => stateDir,
    openKeyedStore: () => assert.fail("local fixture must not open trusted plugin state")
  } }, new AbortController().signal, bindingApi, {
    resolveRuntimeConversationBindingRouteAsync: async ({ route }) => ({ route }),
    getSessionBindingService: () => ({ inspectByConversationAsync: async (ref) => ({ status: "available", binding: adapter.inspectByConversation(ref) }) }),
    inspectRuntimeConversationBindingRoute: ({ route, inspection }) => ({ route: inspection.binding ? { ...route, sessionKey: inspection.binding.targetSessionKey } : route })
  });
  return { root, source, openAt, bindingApi, adapter: () => adapter };
}

function bindingInput(childKey) {
  return { placement: "child", targetKind: "subagent", targetSessionKey: childKey, conversation: { channel: channelContent.channel, accountId: "default", conversationId: channelContent.groupPeer }, metadata: { label: "notebook", boundBy: "system" } };
}

test("child-thread files reopen under a cloned state root and failed commits never enter the live route", async (t) => {
  const f = await bindingFixture(t);
  const first = await f.openAt(f.source);
  const childKey = "agent:main:subagent:11111111-1111-4111-8111-111111111111";
  const input = bindingInput(childKey);
  input.metadata.introText = `Notebook workspace: ${f.source}/workspace`;
  const record = await f.adapter().bind(input);
  assert.notEqual(record.conversation.conversationId, channelContent.groupPeer);
  assert.equal(f.adapter().resolveByConversation(record.conversation).targetSessionKey, childKey);
  assert.equal(f.adapter().resolveByConversation({ ...record.conversation, accountId: "other" }), null);
  assert.deepEqual(first.deliveryTarget(record.conversation), { to: channelContent.groupPeer, threadId: record.conversation.conversationId });
  const original = await readFile(probeBindingsFile(f.source), "utf8");
  const inspected = await first.inspectRoute({ route: { sessionKey: "unbound" }, ...record.conversation });
  assert.equal(inspected.route.sessionKey, childKey);
  assert.deepEqual(f.adapter().inspectByConversation(record.conversation), record);
  assert.equal(await readFile(probeBindingsFile(f.source), "utf8"), original);
  assert.ok(!original.includes(f.source), "stored bindings contain no source-root references");
  assert.equal(record.metadata.introText, undefined);
  if (process.platform !== "win32") assert.equal((await lstat(probeBindingsFile(f.source))).mode & 0o777, 0o600);
  await first.stop();
  assert.equal(f.adapter(), undefined);
  assert.equal(first.deliveryTarget(record.conversation), null);
  const clone = join(f.root, "clone");
  await cp(f.source, clone, { recursive: true });
  const second = await f.openAt(clone);
  assert.equal(f.adapter().resolveByConversation(record.conversation).targetSessionKey, childKey);
  assert.deepEqual(second.deliveryTarget(record.conversation), { to: channelContent.groupPeer, threadId: record.conversation.conversationId });
  let assertions = 0;
  await assert.rejects(f.adapter().bind({ ...input, targetSessionKey: `${childKey}-second`, assertCurrent: () => {
    if (++assertions === 2) throw new Error("commit rejected");
  } }), /commit rejected/);
  assert.equal(f.adapter().listBySession(`${childKey}-second`).length, 0);
  assert.equal(await readFile(probeBindingsFile(clone), "utf8"), original);
  assert.deepEqual(await readdir(dirname(probeBindingsFile(clone))), ["thread-bindings-default.json"]);
  assert.equal((await second.read()).length, 1);
  await f.adapter().unbind({ targetSessionKey: childKey, reason: "session-deleted" });
  assert.deepEqual(await second.read(), []);
  assert.equal(second.deliveryTarget(record.conversation), null);
  assert.equal(await readFile(probeBindingsFile(f.source), "utf8"), original, "clone mutations leave the source unchanged");
  await second.stop();
});

test("stopping joins the accepted file write and prevents its late commit", async (t) => {
  const f = await bindingFixture(t);
  const state = await f.openAt(f.source);
  const adapter = f.adapter();
  const child = "agent:main:subagent:11111111-1111-4111-8111-111111111111";
  await adapter.bind(bindingInput(child));
  const original = await readFile(probeBindingsFile(f.source), "utf8");
  let stopped, assertions = 0;
  await assert.rejects(adapter.bind({ ...bindingInput(`${child}-second`), assertCurrent: () => {
    if (++assertions === 2) stopped = state.stop();
  } }), /stopped/);
  await stopped;
  assert.equal(f.adapter(), undefined);
  assert.equal(await readFile(probeBindingsFile(f.source), "utf8"), original);
  assert.deepEqual(await readdir(dirname(probeBindingsFile(f.source))), ["thread-bindings-default.json"]);
  await assert.rejects(adapter.bind({}), /stopped/);
});

test("unsupported binding capabilities preserve ordinary probe startup without opening files", async () => {
  const signal = new AbortController().signal;
  assert.equal(await openProbeBindings({}, signal, {}), null);
  assert.equal(await openProbeBindings({ state: { resolveStateDir: () => assert.fail("unsupported host must not resolve storage") } }, signal, {}), null);
  const bindingApi = { registerSessionBindingAdapter: () => assert.fail("partial host must not register an adapter"), unregisterSessionBindingAdapter() {} };
  assert.equal(await openProbeBindings({ state: { resolveStateDir: () => assert.fail("partial host must not resolve storage") } }, signal, bindingApi, { resolveRuntimeConversationBindingRoute() {} }), null);
});

test("binding startup rejects linked, oversized and corrupt saved files", async (t) => {
  const f = await bindingFixture(t);
  const path = probeBindingsFile(f.source);
  await mkdir(dirname(path));
  await writeFile(path, "x".repeat(128 * 1024 + 1));
  await assert.rejects(f.openAt(f.source), /read limit/);
  await writeFile(path, '{"version":1,"accountId":"default","bindings":[{}]}');
  await assert.rejects(f.openAt(f.source), /invalid saved/);
  assert.equal(f.adapter(), undefined);
  if (process.platform !== "win32") {
    await rm(path);
    const outside = join(f.root, "outside.json");
    await writeFile(outside, '{"version":1,"accountId":"default","bindings":[]}');
    await symlink(outside, path);
    await assert.rejects(f.openAt(f.source), /regular private file/);
    assert.equal(await readFile(outside, "utf8"), '{"version":1,"accountId":"default","bindings":[]}');
  }
});

test("a full binding file refuses new threads without evicting durable routes", async (t) => {
  const f = await bindingFixture(t);
  const path = probeBindingsFile(f.source);
  await mkdir(dirname(path));
  const bindings = Array.from({ length: 64 }, (_, index) => {
    const id = `kova-thread-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    return {
      bindingId: `default:${id}`, targetSessionKey: `agent:main:subagent:child-${index}`,
      targetKind: "subagent", status: "active", boundAt: 1,
      conversation: { channel: channelContent.channel, accountId: "default", conversationId: id, parentConversationId: channelContent.groupPeer },
      metadata: { lastActivityAt: 1, idleTimeoutMs: 0, maxAgeMs: 0 }
    };
  });
  const original = JSON.stringify({ version: 1, accountId: "default", bindings });
  await writeFile(path, original);
  const state = await f.openAt(f.source);
  await assert.rejects(f.adapter().bind(bindingInput("agent:main:subagent:new-child")), /binding count/);
  assert.equal((await state.read()).length, 64);
  assert.equal(await readFile(path, "utf8"), original);
  await state.stop();
});
