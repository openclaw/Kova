import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

async function loadCommandNormalizer() {
  const configured = process.env.KOVA_OPENCLAW_CHECKOUT;
  if (!configured) return null;
  const checkout = resolve(configured);
  try { await access(checkout); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "7e80556f503d26ddde64e274bfb50cbbec7830f5");
  const packagePath = join(checkout, "package.json");
  const { createJiti } = createRequire(packagePath)("jiti");
  const jiti = createJiti(packagePath, { fsCache: false, alias: { "@openclaw/normalization-core": join(checkout, "packages/normalization-core/src") } });
  return (await jiti.import(join(checkout, "src/auto-reply/commands-registry-normalize.ts"))).normalizeCommandBody;
}

async function createProbe(t, { cfg = {}, currentConfig = () => cfg, selectedAgentId = "probe-agent", mentionRegexes = [], resolveBindingRoute, normalizeCommandBody = (body) => body } = {}) {
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
  const stateDir = join(root, "state");
  if (resolveBindingRoute) await mkdir(stateDir);
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module" })),
    writeFile(join(sdk, "package.json"), JSON.stringify({
      type: "module",
      exports: {
        "./plugin-sdk/core": "./core.js",
        "./plugin-sdk/routing": "./routing.js",
        "./plugin-sdk/thread-bindings-session-runtime": "./thread-bindings.js",
        "./plugin-sdk/conversation-binding-runtime": "./conversation-bindings.js",
        "./plugin-sdk/command-surface": "./command-surface.js",
        "./plugin-sdk/channel-message": "./channel-message.js"
      }
    })),
    writeFile(join(sdk, "core.js"), "export const definePluginEntry = (entry) => entry;\n"),
    writeFile(join(sdk, "thread-bindings.js"), "export function registerSessionBindingAdapter() {} export function unregisterSessionBindingAdapter() {}\n"),
    writeFile(join(sdk, "conversation-bindings.js"), `
      export const calls = [];
      let resolveRoute;
      export function configure(handler) { resolveRoute = handler; }
      export async function resolveRuntimeConversationBindingRouteAsync(params) {
        calls.push(params);
        return await resolveRoute(params);
      }
    `),
    writeFile(join(sdk, "command-surface.js"), "export const calls = []; let normalize; export function useNormalizer(value) { normalize = value; } export function normalizeCommandBody(body) { calls.push(body); return normalize(body); }\n"),
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
    copyFile(new URL("../support/plugins/kova-channel-probe/index.js", import.meta.url), join(root, "probe.js")),
    ...["protocol.js", "bindings.js"].map((file) => copyFile(new URL(`../support/plugins/kova-channel-probe/${file}`, import.meta.url), join(root, file)))
  ]);
  const { default: entry } = await import(pathToFileURL(join(root, "probe.js")).href);
  const { calls: threadCalls } = await import(pathToFileURL(join(sdk, "routing.js")).href);
  const { calls: commandCalls, useNormalizer } = await import(pathToFileURL(join(sdk, "command-surface.js")).href);
  const { calls: bindingCalls, configure } = await import(pathToFileURL(join(sdk, "conversation-bindings.js")).href);
  configure(resolveBindingRoute);
  useNormalizer(normalizeCommandBody);
  const methods = new Map(), scopes = new Map();
  let plugin;
  entry.register({
    runtime: { config: { current: currentConfig }, ...(resolveBindingRoute ? { state: { resolveStateDir: () => stateDir } } : {}) },
    registerChannel(value) { plugin = value; },
    registerGatewayMethod(name, handler, options) { methods.set(name, handler); scopes.set(name, options?.scope); }
  });
  const routeCalls = [], contextCalls = [], dispatchCalls = [], mentionCalls = [];
  const channelRuntime = {
    routing: {
      resolveAgentRoute(options) {
        routeCalls.push(options);
        return { agentId: selectedAgentId, sessionKey: "sdk-base-session" };
      }
    },
    session: {
      resolveStorePath: () => "unused-session-store",
      recordInboundSession: async () => {}
    },
    reply: {
      finalizeInboundContext(context) { contextCalls.push(context); return { ...context, commandText: context.CommandBody.replaceAll("\r\n", "\n").replaceAll("\r", "\n") }; },
      dispatchReplyWithBufferedBlockDispatcher: async () => {}
    },
    mentions: {
      buildMentionRegexes(config, agentId) { mentionCalls.push({ cfg: config, agentId }); return mentionRegexes; }
    },
    inbound: {
      async dispatchReply(options) {
        dispatchCalls.push(options);
        return { routeSessionKey: options.routeSessionKey, dispatched: true };
      }
    }
  };
  let startupError;
  running = plugin.gateway.startAccount({
    cfg, accountId: "default", account: {}, channelRuntime, abortSignal: controller.signal
  }).catch((error) => { startupError = error; });
  const deadline = Date.now() + 5000;
  while (true) {
    if (startupError) throw startupError;
    let status;
    methods.get("kova.channelProbe.status")({ respond(_ok, value) { status = value; } });
    if (status.ok) break;
    if (Date.now() >= deadline) throw new Error("probe startup timed out");
    await setImmediate();
  }
  return {
    plugin, routeCalls, contextCalls, dispatchCalls, threadCalls, mentionCalls, commandCalls, bindingCalls, scopes,
    async normalize(params) {
      let result;
      await methods.get("kova.channelProbe.normalizeCommand")({ params, respond(ok, value) { assert.equal(ok, true); result = value; } });
      return result;
    },
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
    { params: { targetId: "dm:kova-probe-user-case", threadId: "direct-thread" }, chatType: "direct", targetId: "dm:kova-probe-user-case" },
    { params: { targetId: "group:kova-probe-group" }, chatType: "group", targetId: "group:kova-probe-group" },
    { params: { chatType: "group", targetId: "group:kova-probe-group-room-1", wasMentioned: false }, chatType: "group", targetId: "group:kova-probe-group-room-1" },
    { params: { chatType: "group", targetId: "group:kova-probe-group-room-2", threadId: "room-thread", wasMentioned: true }, chatType: "group", targetId: "group:kova-probe-group-room-2" }
  ];
  for (const { params, chatType, targetId } of cases) {
    const threadCount = probe.threadCalls.length;
    const result = await probe.inject(params);
    assert.equal(result.ok, true);
    const peerId = targetId;
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
    assert.equal(context.GroupSubject, chatType === "group" ? "Kova notebook group" : undefined);
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
  assert.equal(messaging.normalizeTarget("kova-channel-probe:group:kova-probe-group-room-1"), "group:kova-probe-group-room-1");
  assert.equal(messaging.inferTargetChatType({ to: "group:kova-probe-group-room-1" }), "group");
  assert.deepEqual(await messaging.targetResolver.resolveTarget({ input: "group:kova-probe-group-room-1" }), {
    to: "group:kova-probe-group-room-1", kind: "group", display: "Kova Probe User", source: "normalized"
  });
  assert.equal(await messaging.targetResolver.resolveTarget({ input: "group:" }), null);
  const toolContext = plugin.threading.buildToolContext({
    context: { To: "group:kova-probe-group-room-1", MessageThreadId: "thread-1", CurrentMessageId: "message-1" },
    hasRepliedRef: { value: false }
  });
  assert.equal(toolContext.currentThreadTs, "thread-1");
  assert.equal(plugin.threading.resolveAutoThreadId({ to: "kova-channel-probe:group:kova-probe-group-room-1", toolContext }), "thread-1");
  assert.equal(plugin.threading.resolveAutoThreadId({ to: "group:kova-probe-group-room-2", toolContext }), undefined);
});

test("channel probe rejects ambiguous new forms before routing", async (t) => {
  const probe = await createProbe(t);
  for (const params of [
    { chatType: "thread" }, { chatType: "channel" }, { chatType: null },
    { targetId: "legacy-peer" }, { chatType: "group" },
    { chatType: "group", targetId: "group:room-1" },
    { chatType: "group", targetId: "kova-channel-probe:group:kova-probe-group-room-2" },
    { chatType: "direct", targetId: "group:kova-probe-group" },
    { threadId: 17 }, { wasMentioned: "true" },
    { chatType: "group", targetId: "dm:kova-probe-user" },
    { chatType: "group", targetId: "room-1" },
    { chatType: "group", targetId: "group:" },
    { chatType: "group", wasMentioned: "true" }
  ]) {
    assert.equal((await probe.inject(params)).ok, false);
    assert.equal((await probe.normalize({ message: "hello", ...params })).ok, false);
  }
  assert.equal(probe.routeCalls.length, 0);
  assert.equal(probe.dispatchCalls.length, 0);
});

for (const sample of [
  { name: "global patterns", cfg: { messages: { groupChat: { mentionPatterns: ["@bot"] } } }, regexes: [/@bot/i], text: "@bot /config set logging.file=/outside", expected: "/config set logging.file=/outside" },
  { name: "selected agent override", cfg: { agents: { list: [{ id: "selected", groupChat: { mentionPatterns: ["@selected"] } }, { id: "other", groupChat: { mentionPatterns: ["@other"] } }] }, messages: { groupChat: { mentionPatterns: ["@global"] } } }, regexes: [/@selected/i], text: "@selected /config set logging.file=/outside", expected: "/config set logging.file=/outside" },
  { name: "empty selected override", cfg: { agents: { list: [{ id: "selected", groupChat: { mentionPatterns: [] } }] }, messages: { groupChat: { mentionPatterns: ["@global"] } } }, regexes: [], text: "@global /config set logging.file=/outside", expected: "@global /config set logging.file=/outside" },
  { name: "derived identity", cfg: { agents: { list: [{ id: "selected", identity: { name: "Lobster" } }] } }, regexes: [/@?Lobster/iu], text: "@Lobster /config set logging.file=/outside", expected: "/config set logging.file=/outside" },
  { name: "two anchored passes", cfg: {}, regexes: [/^@bot\s*/i], text: "@bot @bot /config set logging.file=/outside", expected: "/config set logging.file=/outside", commandText: "@bot /config set logging.file=/outside" },
  { name: "no third stripping pass", cfg: {}, regexes: [/^@bot\s*/i], text: "@bot @bot @bot /config set logging.file=/outside", expected: "@bot /config set logging.file=/outside", commandText: "@bot @bot /config set logging.file=/outside" },
  { name: "numeric mentions", cfg: {}, regexes: [], text: "@123456 /config\nset logging.file=/outside", expected: "/config set logging.file=/outside" },
  { name: "known sender and envelope", cfg: {}, regexes: [/@bot/i], text: "[timestamp] Kova Probe User: @bot /config set logging.file=/outside", expected: "/config set logging.file=/outside" },
  { name: "unrelated sender prefix", cfg: {}, regexes: [/@bot/i], text: "Someone Else: @bot /config set logging.file=/outside", expected: "Someone Else: /config set logging.file=/outside", commandText: "/config set logging.file=/outside" },
  { name: "history marker", cfg: {}, regexes: [], text: "[Recent chat messages - for context] /config set logging.file=/outside", expected: "[Recent chat messages - for context] /config set logging.file=/outside" }
]) test(`probe command normalization uses the selected SDK patterns: ${sample.name}`, async (t) => {
  const cfg = { ...sample.cfg, bindings: [{ agentId: "selected", match: { channel: "kova-channel-probe", accountId: "default", peer: { kind: "group", id: "group:kova-probe-group-room-1" } } }] };
  const before = JSON.stringify(cfg);
  const probe = await createProbe(t, { cfg, selectedAgentId: "selected", mentionRegexes: sample.regexes });
  const result = await probe.normalize({ chatType: "group", targetId: "group:kova-probe-group-room-1", threadId: "thread-1", message: sample.text });
  assert.deepEqual(result, { ok: true, agentId: "selected", sessionKey: "sdk-thread-session", commandText: sample.commandText ?? sample.expected, commandBody: sample.expected });
  assert.deepEqual(probe.routeCalls, [{ cfg, channel: "kova-channel-probe", accountId: "default", peer: { kind: "group", id: "group:kova-probe-group-room-1" } }]);
  assert.deepEqual(probe.mentionCalls, [{ cfg, agentId: "selected" }, { cfg, agentId: "selected" }, { cfg, agentId: "selected" }]);
  assert.deepEqual(probe.commandCalls, [sample.expected]);
  assert.equal(probe.scopes.get("kova.channelProbe.normalizeCommand"), "operator.read");
  assert.equal(probe.dispatchCalls.length, 0);
  assert.equal(JSON.stringify(cfg), before);
});

test("probe normalization leaves direct mentions literal and rejects unsupported parameters", async (t) => {
  const probe = await createProbe(t, { mentionRegexes: [/@bot/i] });
  assert.equal((await probe.normalize({ chatType: "direct", message: "@bot /config set logging.file=/outside" })).commandBody, "@bot /config set logging.file=/outside");
  assert.equal(probe.mentionCalls.length, 0);
  for (const params of [{ message: "hello", chatType: "group", targetId: "dm:example" }, { message: "hello", senderName: "Different" }, { message: "hello", chatType: "thread" }]) assert.equal((await probe.normalize(params)).ok, false);
  assert.equal(probe.dispatchCalls.length, 0);
});

test("probe normalization and injection use the current config and await the bound route", async (t) => {
  const startupCfg = { session: { dmScope: "main" } };
  let currentCfg = startupCfg;
  const boundRoute = { agentId: "bound-agent", sessionKey: "agent:bound-agent:subagent:bound-thread", parentSessionKey: "sdk-base-session" };
  const probe = await createProbe(t, {
    cfg: startupCfg,
    currentConfig: () => currentCfg,
    mentionRegexes: [/@bound/i],
    resolveBindingRoute: async () => { await setImmediate(); return { route: boundRoute }; }
  });
  currentCfg = { session: { dmScope: "per-peer" }, messages: { groupChat: { mentionPatterns: ["@bound"] } } };
  const params = { message: "@bound /status", targetId: "group:kova-probe-group-bound", threadId: "bound-thread" };
  const normalized = await probe.normalize(params);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.agentId, boundRoute.agentId);
  assert.equal(normalized.sessionKey, boundRoute.sessionKey);
  assert.equal(normalized.commandBody, "/status");
  assert.equal(normalized.commandText, "/status");
  assert.ok(probe.mentionCalls.length > 0);
  assert.ok(probe.mentionCalls.every((call) => call.cfg === currentCfg && call.agentId === boundRoute.agentId));
  assert.equal(probe.dispatchCalls.length, 0);
  const injected = await probe.inject(params);
  assert.equal(injected.ok, true);
  assert.equal(injected.observation.routeSessionKey, boundRoute.sessionKey);
  assert.equal(probe.routeCalls.length, 2);
  assert.ok(probe.routeCalls.every((call) => call.cfg === currentCfg));
  assert.deepEqual(probe.bindingCalls, Array.from({ length: 2 }, () => ({
    route: { agentId: "probe-agent", sessionKey: "sdk-thread-session", parentSessionKey: "sdk-base-session" },
    channel: "kova-channel-probe", accountId: "default", conversationId: "bound-thread", parentConversationId: params.targetId
  })));
  assert.equal(probe.dispatchCalls[0].cfg, currentCfg);
  assert.equal(probe.dispatchCalls[0].agentId, boundRoute.agentId);
  assert.equal(probe.contextCalls.at(-1).ParentSessionKey, boundRoute.parentSessionKey);
  assert.equal(probe.scopes.get("kova.channelProbe.inject"), "operator.write");
  assert.equal(probe.scopes.get("kova.channelProbe.normalizeCommand"), "operator.read");
});

test("probe normalization and injection stop when the binding owner is unavailable", async (t) => {
  const probe = await createProbe(t, {
    resolveBindingRoute: async ({ route }) => { await setImmediate(); return { route, bindingOwnerAvailable: false }; }
  });
  const params = { message: "/status", targetId: "group:kova-probe-group-bound", threadId: "bound-thread" };
  const normalized = await probe.normalize(params);
  assert.equal(normalized.ok, false);
  assert.match(normalized.error, /binding owner is unavailable/);
  const injected = await probe.inject(params);
  assert.equal(injected.ok, false);
  assert.match(injected.observation.error, /binding owner is unavailable/);
  assert.equal(probe.bindingCalls.length, 2);
  assert.equal(probe.contextCalls.length, 0);
  assert.equal(probe.commandCalls.length, 0);
  assert.equal(probe.dispatchCalls.length, 0);
});

test("direct probe commands remove their known sender prefix before SDK normalization", async (t) => {
  const probe = await createProbe(t, { mentionRegexes: [/@bot/i] });
  for (const [message, commandBody] of [
    ["Kova Probe User: /config set logging.file=/outside", "/config set logging.file=/outside"],
    ["[timestamp] kOvA pRoBe UsEr: /debug set logging.file=/outside", "/debug set logging.file=/outside"],
    ["Kova Probe User: @bot /config set logging.file=/outside", "@bot /config set logging.file=/outside"],
    ["Kova Probe User: @123456 /config set logging.file=/outside", "@123456 /config set logging.file=/outside"]
  ]) {
    const result = await probe.normalize({ chatType: "direct", targetId: "dm:kova-probe-user", message });
    assert.deepEqual(result, { ok: true, agentId: "probe-agent", sessionKey: "sdk-base-session", commandText: commandBody, commandBody });
    assert.equal(probe.commandCalls.at(-1), commandBody);
    assert.deepEqual(probe.routeCalls.at(-1).peer, { kind: "direct", id: "dm:kova-probe-user" });
  }
  assert.equal(probe.mentionCalls.length, 0);
  assert.equal(probe.dispatchCalls.length, 0);
});

test("direct newlines reach the command SDK while group newlines and mentions are stripped first", async (t) => {
  const probe = await createProbe(t, { mentionRegexes: [/@bot/i] });
  const direct = await probe.normalize({ chatType: "direct", message: "Kova Probe User: /config\r\nset logging.file=/outside" });
  assert.equal(direct.commandText, "/config\nset logging.file=/outside");
  assert.equal(probe.commandCalls.at(-1), "/config\nset logging.file=/outside");
  assert.equal(probe.mentionCalls.length, 0);
  await probe.normalize({ chatType: "direct", message: "Kova Probe User: @bot /config\nset logging.file=/outside" });
  assert.equal(probe.commandCalls.at(-1), "@bot /config\nset logging.file=/outside");
  assert.equal(probe.mentionCalls.length, 0);
  await probe.normalize({ chatType: "group", targetId: "group:kova-probe-group", message: "Kova Probe User: @bot /config\nset logging.file=/outside" });
  assert.equal(probe.commandCalls.at(-1), "/config set logging.file=/outside");
  assert.equal(probe.mentionCalls.length, 3);
  assert.equal(probe.dispatchCalls.length, 0);
});

test("probe preserves the complete bash input when the pinned SDK truncates its canonical command", async (t) => {
  const normalizeCommandBody = await loadCommandNormalizer();
  if (!normalizeCommandBody) return t.skip("Set KOVA_OPENCLAW_CHECKOUT to exercise pinned command normalization");
  const probe = await createProbe(t, { mentionRegexes: [/@bot/i], normalizeCommandBody });
  for (const message of ["/bash\nprintf KOVA_ADMISSION_PROBE", "Kova Probe User: /bash\nprintf KOVA_ADMISSION_PROBE", "[timestamp] Kova Probe User: /bash\r\nprintf KOVA_ADMISSION_PROBE"]) {
    const result = await probe.normalize({ chatType: "direct", message });
    assert.equal(result.commandBody, "/bash");
    assert.equal(result.commandText, "/bash\nprintf KOVA_ADMISSION_PROBE");
  }
  const group = await probe.normalize({ chatType: "group", targetId: "group:kova-probe-group", message: "Kova Probe User: @bot /bash\nprintf KOVA_ADMISSION_PROBE" });
  assert.equal(group.commandText, "/bash printf KOVA_ADMISSION_PROBE");
  assert.equal(group.commandBody, "/bash printf KOVA_ADMISSION_PROBE");
  for (const threadId of [undefined, "thread-1"]) {
    for (const prefix of ["Kova Probe User: ", "[timestamp] Kova Probe User: @bot ", "Kova Probe User: @123456 "]) {
      const result = await probe.normalize({ chatType: "group", targetId: "group:kova-probe-group", ...(threadId === undefined ? {} : { threadId }), message: `${prefix}/bash\nhelp : printf KOVA_ADMISSION_PROBE` });
      assert.equal(result.commandBody, "/bash help : printf KOVA_ADMISSION_PROBE");
      assert.equal(result.commandText, "/bash printf KOVA_ADMISSION_PROBE");
    }
  }
  const bare = await probe.normalize({ chatType: "direct", message: "Kova Probe User: /bash\n" });
  assert.equal(bare.commandText, "/bash");
  assert.equal(bare.commandBody, "/bash");
  assert.equal(probe.dispatchCalls.length, 0);
});

test("probe shell input removes multiline prefixes before group whitespace", async (t) => {
  const probe = await createProbe(t);
  for (const threadId of [undefined, "thread-1"]) {
    const result = await probe.normalize({ chatType: "group", targetId: "group:kova-probe-group", ...(threadId === undefined ? {} : { threadId }), message: "Kova Probe User: /bash\nhelp : printf KOVA_ADMISSION_PROBE" });
    assert.equal(result.commandBody, "/bash help : printf KOVA_ADMISSION_PROBE");
    assert.equal(result.commandText, "/bash printf KOVA_ADMISSION_PROBE");
  }
  assert.equal(probe.dispatchCalls.length, 0);
});
