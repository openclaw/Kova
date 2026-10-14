import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function createProbe(t) {
  const root = await mkdtemp(join(tmpdir(), "kova-probe-routing-"));
  const controller = new AbortController();
  let running;
  t.after(async () => {
    controller.abort();
    await running;
    await rm(root, { recursive: true, force: true });
  });
  const sdk = join(root, "node_modules", "openclaw");
  await mkdir(sdk, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module" })),
    writeFile(join(sdk, "package.json"), JSON.stringify({
      type: "module",
      exports: {
        "./plugin-sdk/core": "./core.js",
        "./plugin-sdk/routing": "./routing.js",
        "./plugin-sdk/channel-message": "./channel-message.js"
      }
    })),
    writeFile(join(sdk, "core.js"), "export const definePluginEntry = (entry) => entry;\n"),
    writeFile(join(sdk, "routing.js"), `
      export const calls = [];
      export function resolveThreadSessionKeys(options) {
        calls.push(options);
        return { sessionKey: "sdk-thread-session", parentSessionKey: options.parentSessionKey };
      }
    `),
    writeFile(join(sdk, "channel-message.js"), `
      export const defineChannelMessageAdapter = (adapter) => adapter;
      export function createMessageReceiveContext(options) {
        return {
          id: options.id,
          ackPolicy: options.ackPolicy ?? "after_agent_dispatch",
          ackState: "pending",
          shouldAckAfter: () => false,
          ack: async () => {}
        };
      }
    `),
    copyFile(new URL("../support/plugins/kova-channel-probe/index.js", import.meta.url), join(root, "probe.js"))
  ]);
  const { default: entry } = await import(pathToFileURL(join(root, "probe.js")).href);
  const { calls: threadCalls } = await import(pathToFileURL(join(sdk, "routing.js")).href);
  const methods = new Map();
  let plugin;
  entry.register({
    registerChannel(value) { plugin = value; },
    registerGatewayMethod(name, handler) { methods.set(name, handler); }
  });
  const routeCalls = [], contextCalls = [], dispatchCalls = [];
  const channelRuntime = {
    routing: {
      resolveAgentRoute(options) {
        routeCalls.push(options);
        return { agentId: "probe-agent", sessionKey: "sdk-base-session" };
      }
    },
    session: {
      resolveStorePath: () => "unused-session-store",
      recordInboundSession: async () => {}
    },
    reply: {
      finalizeInboundContext(context) { contextCalls.push(context); return context; },
      dispatchReplyWithBufferedBlockDispatcher: async () => {}
    },
    inbound: {
      async dispatchReply(options) {
        dispatchCalls.push(options);
        return { routeSessionKey: options.routeSessionKey, dispatched: true };
      }
    }
  };
  running = plugin.gateway.startAccount({
    cfg: {}, accountId: "default", account: {}, channelRuntime, abortSignal: controller.signal
  });
  return {
    plugin, routeCalls, contextCalls, dispatchCalls, threadCalls,
    async inject(params) {
      let result;
      await methods.get("kova.channelProbe.inject")({
        params: { message: "hello", inboundEventId: "probe-message", ...params },
        respond(ok, value) { assert.equal(ok, true); result = value; }
      });
      return result;
    }
  };
}

test("channel probe passes direct, group and thread routing through the SDK", async (t) => {
  const probe = await createProbe(t);
  const cases = [
    { params: {}, chatType: "direct", targetId: "dm:kova-probe-user" },
    { params: { targetId: "legacy-peer" }, chatType: "direct", targetId: "legacy-peer" },
    { params: { targetId: "dm:kova-probe-user-case", threadId: "direct-thread" }, chatType: "direct", targetId: "dm:kova-probe-user-case" },
    { params: { chatType: "group" }, chatType: "group", targetId: "group:kova-probe-group" },
    { params: { chatType: "group", targetId: "group:room-1", wasMentioned: false }, chatType: "group", targetId: "group:room-1" },
    { params: { chatType: "group", targetId: "kova-channel-probe:group:room-2", threadId: "room-thread", wasMentioned: true }, chatType: "group", targetId: "group:room-2" }
  ];
  for (const { params, chatType, targetId } of cases) {
    const threadCount = probe.threadCalls.length;
    const result = await probe.inject(params);
    assert.equal(result.ok, true);
    const peerId = chatType === "group" ? targetId.slice("group:".length) : targetId;
    assert.deepEqual(probe.routeCalls.at(-1).peer, { kind: chatType, id: peerId });
    const context = probe.contextCalls.at(-1);
    assert.equal(context.ChatType, chatType);
    assert.equal(context.From, targetId);
    assert.equal(context.To, targetId);
    assert.equal(context.OriginatingTo, targetId);
    assert.equal(context.SenderId, "kova-probe-user");
    assert.equal(context.WasMentioned, params.wasMentioned);
    assert.equal(context.ChatId, chatType === "group" ? peerId : undefined);
    assert.equal(context.ConversationRoutePeerId, chatType === "group" ? peerId : undefined);
    assert.equal(context.NativeChannelId, chatType === "group" ? peerId : undefined);
    assert.equal(context.GroupSubject, chatType === "group" ? peerId : undefined);
    const parentSessionKey = params.threadId && chatType === "group" ? "sdk-base-session" : undefined;
    const sessionKey = params.threadId ? "sdk-thread-session" : "sdk-base-session";
    assert.equal(context.SessionKey, sessionKey);
    assert.equal(context.ParentSessionKey, parentSessionKey);
    assert.equal(context.MessageThreadId, params.threadId ?? null);
    assert.equal(probe.dispatchCalls.at(-1).routeSessionKey, sessionKey);
    assert.equal(probe.dispatchCalls.at(-1).delivery.durable.threadId, params.threadId ?? null);
    assert.equal(result.observation.routeSessionKey, sessionKey);
    assert.equal(result.observation.inboundEvent.chatType, chatType);
    assert.equal(result.observation.inboundEvent.targetId, targetId);
    assert.equal(probe.threadCalls.length, threadCount + (params.threadId ? 1 : 0));
    if (params.threadId) {
      assert.deepEqual(probe.threadCalls.at(-1), {
        baseSessionKey: "sdk-base-session", threadId: params.threadId,
        ...(parentSessionKey ? { parentSessionKey } : {})
      });
    }
  }
});

test("channel probe resolves group delivery targets and preserves thread destinations", async (t) => {
  const { plugin } = await createProbe(t);
  const messaging = plugin.messaging;
  assert.equal(messaging.normalizeTarget("kova-probe-user"), "dm:kova-probe-user");
  assert.equal(messaging.inferTargetChatType({ to: "dm:kova-probe-user-case" }), "direct");
  assert.equal(messaging.normalizeTarget("kova-channel-probe:group:room-1"), "group:room-1");
  assert.equal(messaging.inferTargetChatType({ to: "group:room-1" }), "group");
  assert.deepEqual(await messaging.targetResolver.resolveTarget({ input: "group:room-1" }), {
    to: "group:room-1", kind: "group", display: "room-1", source: "normalized"
  });
  assert.equal(await messaging.targetResolver.resolveTarget({ input: "group:" }), null);
  const toolContext = plugin.threading.buildToolContext({
    context: { To: "group:room-1", MessageThreadId: "thread-1", CurrentMessageId: "message-1" },
    hasRepliedRef: { value: false }
  });
  assert.equal(toolContext.currentThreadTs, "thread-1");
  assert.equal(plugin.threading.resolveAutoThreadId({ to: "kova-channel-probe:group:room-1", toolContext }), "thread-1");
  assert.equal(plugin.threading.resolveAutoThreadId({ to: "group:room-2", toolContext }), undefined);
});

test("channel probe rejects ambiguous new forms before routing", async (t) => {
  const probe = await createProbe(t);
  for (const params of [
    { chatType: "thread" }, { chatType: "channel" }, { chatType: null },
    { chatType: "group", targetId: "dm:kova-probe-user" },
    { chatType: "group", targetId: "room-1" },
    { chatType: "group", targetId: "group:" },
    { chatType: "group", wasMentioned: "true" }
  ]) {
    assert.equal((await probe.inject(params)).ok, false);
  }
  assert.equal(probe.routeCalls.length, 0);
  assert.equal(probe.dispatchCalls.length, 0);
});
