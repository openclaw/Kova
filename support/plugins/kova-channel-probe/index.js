import { existsSync } from "node:fs";
import { isKovaTarget, validateProbeRequest } from "./protocol.js";
import { openProbeBindings } from "./bindings.js";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  createMessageReceiveContext,
  defineChannelMessageAdapter
} from "openclaw/plugin-sdk/channel-outbound";

const CHANNEL_ID = "kova-channel-probe";
const ACCOUNT_ID = "default";
const TARGET_ID = "dm:kova-probe-user";
const TARGET_USER_ID = "kova-probe-user";
const TARGET_DISPLAY = "Kova Probe User";

let activeRuntime = null;
let outboundRecords = [];
let deliveryRecords = [];
let ackRecords = [];
let modelTurnRecords = [];
let probeObservations = [];
let bindingState = null;
let pluginRuntime = null;

function currentProbeConfig() {
  return typeof pluginRuntime?.config?.current === "function"
    ? pluginRuntime.config.current()
    : activeRuntime?.cfg;
}

function currentDmScope(cfg) {
  const value = cfg?.session?.dmScope ?? "main";
  return ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"].includes(value) ? value : null;
}

const messageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      payload: true,
      silent: true,
      replyTo: true,
      thread: true,
      nativeQuote: true,
      messageSendingHooks: true,
      batch: true,
      afterSendSuccess: true,
      afterCommit: true
    }
  },
  receive: {
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: [
      "after_receive_record",
      "after_agent_dispatch",
      "after_durable_send",
      "manual"
    ]
  },
  send: {
    text: async (ctx) => recordOutbound("text", ctx),
    media: async (ctx) => recordOutbound("media", ctx),
    payload: async (ctx) => recordOutbound("payload", ctx),
    lifecycle: {
      afterSendSuccess: async ({ result, to }) => {
        outboundRecords.push({
          kind: "after-send-success",
          messageId: result?.receipt?.primaryPlatformMessageId ?? null,
          to: to ?? null
        });
      },
      afterCommit: async ({ receipt, to }) => {
        outboundRecords.push({
          kind: "after-commit",
          messageId: receipt?.primaryPlatformMessageId ?? null,
          to: to ?? null
        });
      }
    }
  }
});

const plugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Kova Channel Probe",
    description: "Deterministic Kova channel used to prove OpenClaw channel capability behavior."
  },
  capabilities: {
    chatTypes: ["direct", "group"]
  },
  config: {
    listAccountIds: () => [ACCOUNT_ID],
    defaultAccountId: () => ACCOUNT_ID,
    resolveAccount: () => ({
      accountId: ACCOUNT_ID,
      enabled: true,
      configured: true
    }),
    isConfigured: () => true,
    isEnabled: () => true,
    resolveDefaultTo: () => TARGET_ID
  },
  messaging: {
    normalizeTarget: normalizeKovaTarget,
    inferTargetChatType: ({ to }) => {
      const target = normalizeKovaTarget(to);
      return isKovaTarget(target) ? (target.startsWith("group:") ? "group" : "direct") : undefined;
    },
    resolveInboundConversation: ({ to, conversationId, threadId, threadParentId }) => {
      const parent = normalizeKovaTarget(to) ?? normalizeKovaTarget(threadParentId);
      const thread = normalizeKovaThreadId(threadId);
      return thread ? { conversationId: thread, ...(parent ? { parentConversationId: parent } : {}) }
        : { conversationId: normalizeKovaTarget(conversationId) ?? parent ?? conversationId };
    },
    resolveDeliveryTarget: (conversation) => {
      const bound = bindingState?.deliveryTarget(conversation);
      if (bound) return bound;
      return isKovaTarget(conversation.conversationId) && conversation.parentConversationId === undefined
        ? { to: conversation.conversationId }
        : null;
    },
    targetResolver: {
      looksLikeId: (raw, normalized) =>
        isKovaTarget(normalizeKovaTarget(normalized ?? raw)),
      hint: "dm:kova-probe-user",
      resolveTarget: async ({ input, normalized }) => {
        const target = normalizeKovaTarget(normalized) ?? normalizeKovaTarget(input);
        return isKovaTarget(target)
          ? {
              to: target,
              kind: target.startsWith("group:") ? "group" : "user",
              display: TARGET_DISPLAY,
              source: "normalized"
            }
          : null;
      }
    }
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => {
      const currentChannelId = normalizeKovaTarget(context.To) ?? normalizeKovaTarget(context.From) ?? context.To;
      const currentThreadTs = normalizeKovaThreadId(context.MessageThreadId ?? context.TransportThreadId);
      return {
        currentChannelId,
        currentThreadTs,
        currentMessageId: context.CurrentMessageId,
        replyToMode: currentThreadTs ? "all" : "first",
        hasRepliedRef
      };
    },
    resolveAutoThreadId: ({ to, toolContext }) => {
      const threadId = normalizeKovaThreadId(toolContext?.currentThreadTs);
      if (!threadId) {
        return undefined;
      }
      const target = normalizeKovaTarget(to) ?? to;
      const current = normalizeKovaTarget(toolContext?.currentChannelId) ?? toolContext?.currentChannelId;
      return target && current && target === current ? threadId : undefined;
    },
    resolveCurrentChannelId: ({ to }) => normalizeKovaTarget(to) ?? to
  },
  conversationBindings: { defaultTopLevelPlacement: "child", bindingStore: "adapter" },
  gateway: {
    startAccount: async (ctx) => {
      bindingState = await openProbeBindings(pluginRuntime, ctx.abortSignal);
      activeRuntime = {
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        account: ctx.account,
        channelRuntime: ctx.channelRuntime,
        abortSignal: ctx.abortSignal,
        startedAt: new Date().toISOString()
      };
      try {
        await new Promise((resolve) => {
          if (ctx.abortSignal.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal.addEventListener("abort", resolve, { once: true });
        });
      } finally {
        activeRuntime = null;
        await bindingState?.stop();
        bindingState = null;
      }
    }
  },
  message: messageAdapter
};

function normalizeKovaTarget(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return undefined;
  }
  if (isKovaTarget(value)) {
    return value;
  }
  if (value === TARGET_USER_ID) {
    return TARGET_ID;
  }
  const prefixed = value.startsWith(`${CHANNEL_ID}:`) ? value.slice(CHANNEL_ID.length + 1) : "";
  if (isKovaTarget(prefixed)) {
    return prefixed;
  }
  return prefixed === TARGET_USER_ID ? TARGET_ID : undefined;
}

function normalizeKovaThreadId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export default definePluginEntry({
  id: "kova-channel-probe",
  name: "Kova Channel Probe",
  description: "OpenClaw channel probe fixture used by Kova.",
  register(api) {
    pluginRuntime = api.runtime;
    api.registerChannel(plugin);
    api.registerGatewayMethod(
      "kova.channelProbe.status",
      ({ respond }) => {
        const cfg = currentProbeConfig();
        respond(true, {
          ok: Boolean(activeRuntime?.channelRuntime),
          schemaVersion: "kova.channelProbe.status.v1",
          channelId: CHANNEL_ID,
          accountId: activeRuntime?.accountId ?? null,
          startedAt: activeRuntime?.startedAt ?? null,
          threadBindings: bindingState !== null,
          dmScope: currentDmScope(cfg)
        });
      },
      { scope: "operator.read" }
    );
    api.registerGatewayMethod(
      "kova.channelProbe.normalizeCommand",
      async ({ params, respond }) => {
        try { respond(true, { ok: true, ...await normalizeProbeCommand(params) }); }
        catch (error) { respond(true, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
      },
      { scope: "operator.read" }
    );
    api.registerGatewayMethod(
      "kova.channelProbe.reset",
      ({ respond }) => {
        resetProbeState();
        respond(true, {
          ok: true,
          schemaVersion: "kova.channelProbe.reset.v1",
          channelId: CHANNEL_ID,
          accountId: activeRuntime?.accountId ?? null
        });
      },
      { scope: "operator.write" }
    );
    api.registerGatewayMethod(
      "kova.channelProbe.inject",
      async ({ params, respond }) => {
        try {
          const result = await injectProbeInbound(params);
          respond(true, result);
        } catch (error) {
          respond(true, {
            ok: false,
            schemaVersion: "kova.channelProbe.injectResult.v1",
            channelId: CHANNEL_ID,
            accountId: activeRuntime?.accountId ?? null,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      },
      { scope: "operator.write" }
    );
    api.registerGatewayMethod(
      "kova.channelProbe.bindings",
      async ({ params, respond }) => {
        try {
          validateProbeRequest("kova.channelProbe.bindings", params ?? {});
          if (!bindingState) throw new Error("channel binding storage is not started");
          const records = await bindingState.read();
          respond(true, { bindings: records.filter((record) => !params?.targetSessionKey || record.targetSessionKey === params.targetSessionKey) });
        } catch {
          respond(false, undefined, { code: "UNAVAILABLE", message: "Channel binding storage is unavailable" });
        }
      },
      { scope: "operator.read" }
    );
    api.registerGatewayMethod(
      "kova.channelProbe.observations",
      ({ respond }) => {
        respond(true, {
          ok: true,
          schemaVersion: "kova.channelProbe.observations.v1",
          channelId: CHANNEL_ID,
          accountId: activeRuntime?.accountId ?? null,
          observations: snapshotProbeObservations()
        });
      },
      { scope: "operator.read" }
    );
  }
});

function resetProbeState() {
  outboundRecords = [];
  deliveryRecords = [];
  ackRecords = [];
  modelTurnRecords = [];
  probeObservations = [];
}

function probeRouteParams(params) {
  const targetId = optionalProbeString(params.targetId) ?? TARGET_ID;
  const chatType = params.chatType ?? (targetId.startsWith("group:") ? "group" : "direct");
  const wasMentioned = params.wasMentioned;
  if (!isKovaTarget(targetId) || (chatType === "group") !== targetId.startsWith("group:")) throw new Error("channel probe target and chat type differ");
  return { chatType, targetId, wasMentioned, threadId: optionalProbeString(params.threadId) };
}

async function injectProbeInbound(params = {}) {
  validateProbeRequest("kova.channelProbe.inject", params);
  if (!activeRuntime?.channelRuntime) {
    throw new Error("kova channel probe runtime is not started");
  }
  const cfg = currentProbeConfig();
  const message = requiredProbeString(params.message, "message");
  const inboundEventId = optionalProbeString(params.inboundEventId) ??
    `kova-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { chatType, targetId, threadId, wasMentioned } = probeRouteParams(params);
  const replyToId = params.replyToId === null ? null : optionalProbeString(params.replyToId);
  const silent = params.silent === true;
  const sourceReplyDeliveryMode = optionalProbeString(params.sourceReplyDeliveryMode);
  const requiredCapabilities = objectOrNull(params.requiredCapabilities);
  const senderId = optionalProbeString(params.senderId) ?? TARGET_USER_ID;
  const senderName = optionalProbeString(params.senderName) ?? TARGET_DISPLAY;
  const from = optionalProbeString(params.from) ?? targetId;
  const botLoopProtection = objectOrNull(params.botLoopProtection);
  const beforeOutbound = outboundRecords.length;
  const beforeDelivery = deliveryRecords.length;
  const beforeAck = ackRecords.length;
  const beforeRecords = modelTurnRecords.length;
  const startedAtEpochMs = Date.now();
  let turn = null;
  let error = null;
  const receiveContext = createProbeReceiveContext({
    id: inboundEventId,
    message,
    ackPolicy: optionalProbeString(params.ackPolicy)
  });

  await maybeAckProbeReceiveContext(receiveContext, "receive_record");
  try {
    turn = await runOpenClawModelTurn({
      cfg,
      message,
      inboundEventId,
      targetId,
      chatType,
      wasMentioned,
      replyToId,
      threadId,
      silent,
      sourceReplyDeliveryMode,
      from,
      senderId,
      senderName,
      botLoopProtection,
      requiredCapabilities
    });
    await maybeAckProbeReceiveContext(receiveContext, "agent_dispatch");
    await maybeAckProbeReceiveContext(receiveContext, "durable_send");
    if (params.manualAck === true) {
      await ackProbeReceiveContext(receiveContext, "manual");
    }
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }

  const finishedAtEpochMs = Date.now();
  const terminalError = error?.message ?? null;
  const observation = {
    schemaVersion: "kova.channelProbe.observation.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
    recordOffsets: {
      outbound: beforeOutbound,
      delivery: beforeDelivery,
      ack: beforeAck,
      modelTurn: beforeRecords
    },
    inboundEvent: {
      id: inboundEventId,
      message,
      targetId,
      chatType,
      wasMentioned,
      replyToId,
      threadId,
      silent,
      senderId,
      senderName,
      from
    },
    routeSessionKey: turn?.routeSessionKey ?? null,
    runId: turn?.runId ?? null,
    dispatched: turn?.dispatched === true,
    admission: turn?.admission ?? null,
    error: terminalError,
    initialError: terminalError,
    startedAtEpochMs,
    finishedAtEpochMs,
    durationMs: Math.max(0, finishedAtEpochMs - startedAtEpochMs),
    outboundRecords: outboundRecords.slice(beforeOutbound),
    deliveryRecords: deliveryRecords.slice(beforeDelivery),
    ackRecords: ackRecords.slice(beforeAck),
    modelTurnRecords: modelTurnRecords.slice(beforeRecords)
  };
  probeObservations.push(observation);
  return {
    ok: terminalError === null,
    schemaVersion: "kova.channelProbe.injectResult.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
    observation: snapshotProbeObservation(observation)
  };
}

function snapshotProbeObservations() {
  return probeObservations.map((observation) => snapshotProbeObservation(observation));
}

function snapshotProbeObservation(observation) {
  const offsets = observation?.recordOffsets ?? {};
  const outboundStart = Number.isInteger(offsets.outbound) ? offsets.outbound : 0;
  const deliveryStart = Number.isInteger(offsets.delivery) ? offsets.delivery : 0;
  const ackStart = Number.isInteger(offsets.ack) ? offsets.ack : 0;
  const modelTurnStart = Number.isInteger(offsets.modelTurn) ? offsets.modelTurn : 0;
  const inboundEventId = observation?.inboundEvent?.id;
  const targetId = observation?.inboundEvent?.targetId;
  const observedAtEpochMs = Date.now();
  return {
    ...observation,
    observedAtEpochMs,
    durationMs: Math.max(0, observedAtEpochMs - observation.startedAtEpochMs),
    outboundRecords: outboundRecords
      .slice(outboundStart)
      .filter((record) => record?.to === targetId),
    deliveryRecords: deliveryRecords
      .slice(deliveryStart)
      .filter((record) => record?.targetId === targetId),
    ackRecords: ackRecords
      .slice(ackStart)
      .filter((record) => record?.inboundEventId === inboundEventId),
    modelTurnRecords: modelTurnRecords
      .slice(modelTurnStart)
      .filter((record) => record?.messageId === inboundEventId)
  };
}

function createProbeReceiveContext({ id, message, ackPolicy }) {
  const ctx = createMessageReceiveContext({
    id,
    channel: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    message: { text: message },
    ...(ackPolicy ? { ackPolicy } : {}),
    onAck: () => {
      ackRecords.push({
        kind: "ack-hook",
        inboundEventId: id,
        policy: ctx.ackPolicy,
        state: ctx.ackState,
        atEpochMs: Date.now()
      });
    },
    onNack: (error) => {
      ackRecords.push({
        kind: "nack-hook",
        inboundEventId: id,
        policy: ctx.ackPolicy,
        state: ctx.ackState,
        error: error instanceof Error ? error.message : String(error),
        atEpochMs: Date.now()
      });
    }
  });
  ackRecords.push({
    kind: "receive-context",
    inboundEventId: id,
    policy: ctx.ackPolicy,
    state: ctx.ackState,
    atEpochMs: Date.now()
  });
  return ctx;
}

async function maybeAckProbeReceiveContext(ctx, stage) {
  if (!ctx.shouldAckAfter(stage)) {
    ackRecords.push({
      kind: "ack-stage-skip",
      inboundEventId: ctx.id,
      policy: ctx.ackPolicy,
      stage,
      state: ctx.ackState,
      atEpochMs: Date.now()
    });
    return;
  }
  await ackProbeReceiveContext(ctx, stage);
}

async function ackProbeReceiveContext(ctx, stage) {
  await ctx.ack();
  ackRecords.push({
    kind: "ack-stage",
    inboundEventId: ctx.id,
    policy: ctx.ackPolicy,
    stage,
    state: ctx.ackState,
    ackedAt: ctx.ackedAt ?? null,
    atEpochMs: Date.now()
  });
}

function requiredProbeString(value, key) {
  const normalized = optionalProbeString(value);
  if (!normalized) {
    throw new Error(`kova channel probe ${key} must be a non-empty string`);
  }
  return normalized;
}

function optionalProbeString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function anchorProbeCommand(text) {
  const markers = ["[Chat messages since your last reply - for context]", "[Recent chat messages - for context]", "[Current message - respond to this]"];
  const skip = (start, pattern = /\s/) => { while (pattern.test(text[start] ?? "")) start++; return start; };
  let start = skip(0);
  if (markers.some((marker) => text.startsWith(marker, start))) return text.trim();
  while (text[start] === "[") {
    const newline = text.indexOf("\n", start), end = text.indexOf("]", start + 1);
    if (end < 0 || newline >= 0 && end > newline) break;
    if (markers.some((marker) => text.startsWith(marker, start))) return text.trim();
    start = skip(end + 1, /[ \t]/);
  }
  const newline = text.indexOf("\n", start), colon = text.indexOf(":", start);
  if (colon >= 0 && (newline < 0 || colon < newline)) {
    const prefix = text.slice(start, colon).trim();
    if (prefix.length <= 120 && prefix.toLowerCase() === TARGET_DISPLAY.toLowerCase()) start = skip(colon + 1, /[ \t]/);
  }
  return text.slice(start);
}

function stripProbeShellPrefixes(text) {
  if (["[Chat messages since your last reply - for context]", "[Recent chat messages - for context]"].some((marker) => text.trimStart().startsWith(marker))) return text.trim();
  const afterEnvelope = text.replace(/^(?:[ \t]*\[[^\]\n]+\][ \t]*)+/, "");
  const senderPrefix = afterEnvelope === text ? /^[ \t]*(?!\/)[^\n:]{1,120}:\s+/gm : /^[ \t]*[^\n:]{1,120}:\s+/gm;
  const stripped = afterEnvelope.replace(senderPrefix, "").replace(/\\n/g, " ").trim();
  return stripped.replace(stripped.startsWith("/") ? /[ \t]+/g : /\s+/g, " ");
}

async function normalizeProbeCommand(params) {
  if (!objectOrNull(params) || Object.keys(params).some((key) => !["message", "targetId", "chatType", "threadId", "wasMentioned"].includes(key))) throw new Error("invalid probe command normalization parameters");
  validateProbeRequest("kova.channelProbe.inject", params);
  const current = activeRuntime;
  const runtime = current?.channelRuntime;
  if (!runtime || current.abortSignal.aborted) throw new Error("kova channel probe runtime is not started");
  const message = requiredProbeString(params.message, "message");
  const target = probeRouteParams(params);
  const cfg = currentProbeConfig();
  const route = await resolveProbeRoute(runtime, cfg, target, { readOnly: true });
  if (activeRuntime !== current || current.abortSignal.aborted) throw new Error("probe runtime changed during command normalization");
  const context = runtime.reply.finalizeInboundContext({ Body: message, BodyForAgent: message, RawBody: message, CommandBody: message, ChatType: target.chatType, SenderName: TARGET_DISPLAY, SenderId: TARGET_USER_ID, Provider: CHANNEL_ID, Surface: CHANNEL_ID });
  const text = context.commandText ?? context.BodyForCommands ?? context.CommandBody;
  if (typeof text !== "string") throw new Error("probe command text is unavailable");
  const strip = (value) => {
    if (target.chatType !== "group") return value;
    for (const regex of runtime.mentions.buildMentionRegexes(cfg, route.agentId)) value = value.replace(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`), " ");
    return value.replace(/@[0-9+]{5,}/g, " ").replace(/\s+/g, " ").trim();
  };
  // Session command selection strips once, then command dispatch strips again.
  const trigger = strip(anchorProbeCommand(text)).replace(/\\n/g, " ").trim();
  const { normalizeCommandBody } = await import("openclaw/plugin-sdk/command-surface");
  if (activeRuntime !== current || current.abortSignal.aborted) throw new Error("probe runtime changed during command normalization");
  const commandBody = normalizeCommandBody(strip(trigger));
  // The shell handler starts from the original context and removes structural
  // prefixes before its single mention pass, while command selection strips twice.
  const commandText = strip(stripProbeShellPrefixes(text));
  return { agentId: route.agentId, sessionKey: route.sessionKey, commandText, commandBody };
}

async function resolveProbeRoute(runtime, cfg, { chatType, targetId, threadId }, { readOnly = false } = {}) {
  const baseRoute = runtime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    peer: { kind: chatType, id: targetId }
  });
  const fallback = resolveThreadedRoute(baseRoute, threadId, chatType);
  const bound = bindingState ? await bindingState[readOnly ? "inspectRoute" : "resolveRoute"]({
    route: fallback, channel: CHANNEL_ID, accountId: ACCOUNT_ID,
    conversationId: threadId ?? targetId,
    ...(threadId ? { parentConversationId: targetId } : {})
  }) : { route: fallback };
  if (bound.bindingOwnerAvailable === false) throw new Error("channel binding owner is unavailable");
  return bound.route;
}

async function runOpenClawModelTurn({
  cfg,
  message,
  inboundEventId,
  targetId = TARGET_ID,
  chatType = "direct",
  wasMentioned,
  replyToId,
  threadId,
  silent,
  sourceReplyDeliveryMode,
  from = targetId,
  senderId = TARGET_USER_ID,
  senderName = TARGET_DISPLAY,
  botLoopProtection,
  requiredCapabilities
}) {
  const runtime = activeRuntime.channelRuntime;
  const route = await resolveProbeRoute(runtime, cfg, { chatType, targetId, threadId });
  const storePath = runtime.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: message,
    BodyForAgent: message,
    RawBody: message,
    CommandBody: message,
    From: from,
    To: targetId,
    OriginatingTo: targetId,
    SessionKey: route.sessionKey,
    ParentSessionKey: route.parentSessionKey,
    AccountId: ACCOUNT_ID,
    ChatType: chatType,
    ...(chatType === "group" ? {
      ChatId: targetId,
      GroupSubject: "Kova notebook group",
      GroupChannel: targetId,
      ConversationRoutePeerId: targetId,
      NativeChannelId: targetId,
      ...(wasMentioned === undefined ? {} : { WasMentioned: wasMentioned })
    } : {}),
    SenderName: senderName,
    SenderId: senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: inboundEventId,
    MessageSidFull: inboundEventId,
    ReplyToId: replyToId,
    MessageThreadId: threadId,
    Timestamp: new Date().toISOString(),
    OriginatingChannel: CHANNEL_ID,
    CommandAuthorized: true
  });

  let runId;
  const result = await runtime.inbound.dispatchReply({
    cfg,
    channel: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    botLoopProtection,
    recordInboundSession: runtime.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: runtime.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      durable: {
        replyToMode: "first",
        replyToId,
        threadId,
        silent,
        ...(requiredCapabilities ? { requiredCapabilities } : {})
      },
      deliver: async (delivered, info) => {
        if (info?.kind !== "final") {
          return deliverAdapterPayload(delivered, {
            targetId,
            replyToId,
            threadId,
            silent,
            deliveryKind: typeof info?.kind === "string" ? info.kind : null
          });
        }
        return recordUnhandledDeliveryPayload(delivered, { targetId, replyToId, threadId, silent, info });
      },
      onDelivered: async (delivered, info, result) => {
        deliveryRecords.push({
          path: "durable-message-send-context",
          targetId,
          kind: info?.kind ?? null,
          text: delivered?.text ?? null,
          mediaUrl: delivered?.mediaUrl ?? delivered?.mediaUrls?.[0] ?? null,
          mediaUrls: Array.isArray(delivered?.mediaUrls) ? delivered.mediaUrls : [],
          isError: delivered?.isError === true,
          replyToId,
          threadId,
          silent: silent === true,
          visibleReplySent: result?.visibleReplySent ?? null,
          messageIds: result?.messageIds ?? null
        });
      },
      onError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    replyPipeline: {},
    replyOptions: { ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}), onAgentRunStart: (acceptedRunId) => { runId = acceptedRunId; } },
    record: {
      onRecordError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    log: (event) => {
      modelTurnRecords.push(compactTurnLogEvent(event));
    },
    messageId: inboundEventId
  });
  return { ...result, runId };
}

function resolveThreadedRoute(route, threadId, chatType) {
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    return route;
  }
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    threadId,
    ...(chatType === "group" ? { parentSessionKey: route.sessionKey } : {})
  });
  return {
    ...route,
    sessionKey: threadKeys.sessionKey,
    parentSessionKey: threadKeys.parentSessionKey
  };
}

async function recordOutbound(kind, ctx) {
  const mediaUrls = outboundMediaUrls(ctx);
  const messageId = `kova-${kind}-${outboundRecords.length + 1}`;
  const receipt = createReceipt(messageId, kind, {
    threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
    replyToId: ctx.replyToId ?? undefined
  });
  outboundRecords.push({
    kind,
    messageId,
    to: ctx.to ?? null,
    text: ctx.text ?? null,
    mediaUrl: mediaUrls[0] ?? null,
    mediaUrls,
    mediaPathExists: typeof mediaUrls[0] === "string" && existsSync(mediaUrls[0]),
    payload: ctx.payload ?? null,
    deliveryKind: ctx.deliveryKind ?? null,
    isError: ctx.payload?.isError === true || ctx.isError === true,
    silent: ctx.silent ?? false,
    threadId: ctx.threadId ?? null,
    replyToId: ctx.replyToId ?? null
  });
  return { messageId, receipt };
}

async function deliverAdapterPayload(payload, options = {}) {
  const mediaUrls = outboundMediaUrls({ payload });
  const base = {
    to: options.targetId ?? TARGET_ID,
    payload,
    isError: payload?.isError === true,
    silent: options.silent === true,
    threadId: options.threadId ?? null,
    replyToId: options.replyToId ?? null,
    deliveryKind: options.deliveryKind ?? null
  };
  if (mediaUrls.length === 0) {
    return await recordOutbound(payload?.channelData ? "payload" : "text", {
      ...base,
      text: payload?.text ?? null
    });
  }
  let result = null;
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    result = await recordOutbound("media", {
      ...base,
      text: index === 0 ? (payload?.text ?? null) : null,
      mediaUrl,
      mediaUrls: [mediaUrl]
    });
  }
  return result;
}

function recordUnhandledDeliveryPayload(payload, options = {}) {
  const mediaUrl = firstMediaUrl(payload);
  deliveryRecords.push({
    path: "unhandled-channel-delivery",
    dispatchKind: options.info?.kind ?? null,
    kind: mediaUrl ? "media" : payload?.channelData ? "payload" : "text",
    text: payload?.text ?? null,
    mediaUrl: mediaUrl ?? null,
    mediaUrls: Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : mediaUrl ? [mediaUrl] : [],
    isError: payload?.isError === true,
    targetId: options.targetId ?? TARGET_ID,
    replyToId: options.replyToId ?? null,
    threadId: options.threadId ?? null,
    silent: options.silent === true,
    visibleReplySent: false,
    messageIds: []
  });
  return {
    visibleReplySent: false,
    messageIds: []
  };
}

function firstMediaUrl(payload) {
  if (typeof payload?.mediaUrl === "string" && payload.mediaUrl.length > 0) {
    return payload.mediaUrl;
  }
  if (Array.isArray(payload?.mediaUrls)) {
    return payload.mediaUrls.find((url) => typeof url === "string" && url.length > 0) ?? null;
  }
  return null;
}

function outboundMediaUrls(ctx) {
  const values = Array.isArray(ctx?.mediaUrls)
    ? ctx.mediaUrls
    : [
        ctx?.mediaUrl,
        ctx?.payload?.mediaUrl,
        ...(Array.isArray(ctx?.payload?.mediaUrls) ? ctx.payload.mediaUrls : [])
      ];
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function createReceipt(id, kind = "text", options = {}) {
  return {
    primaryPlatformMessageId: id,
    platformMessageIds: [id],
    parts: [{ platformMessageId: id, kind, index: 0 }],
    sentAt: Date.now(),
    ...(options.threadId ? { threadId: options.threadId } : {}),
    ...(options.replyToId ? { replyToId: options.replyToId } : {})
  };
}

function compactTurnLogEvent(event) {
  return {
    stage: event?.stage ?? null,
    event: event?.event ?? null,
    messageId: event?.messageId ?? null,
    sessionKey: event?.sessionKey ?? null,
    admission: event?.admission ?? null,
    reason: event?.reason ?? null,
    error: event?.error instanceof Error ? event.error.message : event?.error ? String(event.error) : null
  };
}
