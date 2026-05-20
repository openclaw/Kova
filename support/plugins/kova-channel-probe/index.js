import { existsSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  createLiveMessageState,
  createMessageReceiveContext,
  createPreviewMessageReceipt,
  defineChannelMessageAdapter,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  markLiveMessagePreviewUpdated
} from "openclaw/plugin-sdk/channel-message";

const CHANNEL_ID = "kova-channel-probe";
const ACCOUNT_ID = "default";
const TARGET_ID = "dm:kova-probe-user";
const TARGET_USER_ID = "kova-probe-user";
const TARGET_DISPLAY = "Kova Probe User";
const KOVA_IMAGE_PROVIDER_ID = "kova-channel-probe";
const KOVA_IMAGE_MODEL_ID = "kova-image";
const KOVA_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

let activeRuntime = null;
let outboundRecords = [];
let deliveryRecords = [];
let ackRecords = [];
let liveRecords = [];
let modelTurnRecords = [];
let probeObservations = [];
let recoveryRecords = [];
let activePlatformScript = null;

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
      reconcileUnknownSend: true,
      afterSendSuccess: true,
      afterCommit: true
    },
    reconcileUnknownSend: async (ctx) => reconcileProbeUnknownSend(ctx)
  },
  live: {
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
      nativeStreaming: true,
      quietFinalization: true
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
        discardPending: true,
        previewReceipt: true,
        retainOnAmbiguousFailure: true
      }
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
      afterSendSuccess: async ({ result }) => {
        outboundRecords.push({
          kind: "after-send-success",
          messageId: result?.receipt?.primaryPlatformMessageId ?? null
        });
      },
      afterCommit: async ({ receipt }) => {
        outboundRecords.push({
          kind: "after-commit",
          messageId: receipt?.primaryPlatformMessageId ?? null
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
    inferTargetChatType: ({ to }) => isKovaTarget(normalizeKovaTarget(to)) ? "direct" : undefined,
    targetResolver: {
      looksLikeId: (raw, normalized) =>
        isKovaTarget(normalizeKovaTarget(normalized ?? raw)),
      hint: "dm:kova-probe-user",
      resolveTarget: async ({ input, normalized }) => {
        const target = normalizeKovaTarget(normalized) ?? normalizeKovaTarget(input);
        return isKovaTarget(target)
          ? {
              to: target,
              kind: "user",
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
  gateway: {
    startAccount: async (ctx) => {
      activeRuntime = {
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        account: ctx.account,
        channelRuntime: ctx.channelRuntime,
        abortSignal: ctx.abortSignal,
        startedAt: new Date().toISOString()
      };
      await new Promise((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", resolve, { once: true });
      });
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

function isKovaTarget(value) {
  return typeof value === "string" &&
    (value === TARGET_ID || value.startsWith(`${TARGET_ID}-`));
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
    api.registerChannel(plugin);
    if (typeof api.registerImageGenerationProvider === "function") {
      api.registerImageGenerationProvider(buildKovaImageGenerationProvider());
    }
    api.registerGatewayMethod(
      "kova.channelProbe.status",
      ({ respond }) => {
        respond(true, {
          ok: Boolean(activeRuntime?.channelRuntime),
          schemaVersion: "kova.channelProbe.status.v1",
          channelId: CHANNEL_ID,
          accountId: activeRuntime?.accountId ?? null,
          startedAt: activeRuntime?.startedAt ?? null
        });
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
      "kova.channelProbe.livePreview",
      async ({ params, respond }) => {
        try {
          const result = await runProbeLivePreview(params);
          respond(true, result);
        } catch (error) {
          respond(true, {
            ok: false,
            schemaVersion: "kova.channelProbe.livePreviewResult.v1",
            channelId: CHANNEL_ID,
            accountId: activeRuntime?.accountId ?? null,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      },
      { scope: "operator.write" }
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
  liveRecords = [];
  modelTurnRecords = [];
  probeObservations = [];
  recoveryRecords = [];
}

async function runProbeLivePreview(params = {}) {
  if (!activeRuntime?.channelRuntime) {
    throw new Error("kova channel probe runtime is not started");
  }
  const caseId = requiredProbeString(params.caseId, "caseId");
  const mode = requiredProbeString(params.mode, "mode");
  if (!["final-edit", "normal-fallback", "retain-ambiguous-failure"].includes(mode)) {
    throw new Error(`kova channel probe live mode is unsupported: ${mode}`);
  }
  const targetId = optionalProbeString(params.targetId) ?? TARGET_ID;
  const text = optionalProbeString(params.text) ?? "KOVA_LIVE_PREVIEW_FINAL_OK";
  const previewId = `kova-live-preview-${caseId}-${Date.now()}`;
  const beforeLive = liveRecords.length;
  const startedAtEpochMs = Date.now();
  let result = null;
  let error = null;

  try {
    const previewReceipt = createPreviewMessageReceipt({ id: previewId });
    const firstRendered = createProbeRenderedTextBatch("KOVA_LIVE_PREVIEW_DRAFT");
    const liveState = markLiveMessagePreviewUpdated(
      createLiveMessageState({ receipt: previewReceipt, canFinalizeInPlace: true }),
      firstRendered
    );
    liveRecords.push({
      kind: "draft-preview",
      caseId,
      targetId,
      previewId,
      phase: liveState.phase,
      canFinalizeInPlace: liveState.canFinalizeInPlace,
      text: firstRendered.payloads[0]?.text ?? null,
      atEpochMs: Date.now()
    });
    const progressRendered = createProbeRenderedTextBatch("KOVA_LIVE_PREVIEW_PROGRESS");
    const progressState = markLiveMessagePreviewUpdated(liveState, progressRendered);
    liveRecords.push({
      kind: "progress-update",
      caseId,
      targetId,
      previewId,
      phase: progressState.phase,
      canFinalizeInPlace: progressState.canFinalizeInPlace,
      text: progressRendered.payloads[0]?.text ?? null,
      transport: "native",
      atEpochMs: Date.now()
    });

    result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload: { text },
      liveState: progressState,
      adapter: defineFinalizableLivePreviewAdapter({
        draft: createProbeLivePreviewDraft({ caseId, previewId }),
        buildFinalEdit: (payload) => mode === "normal-fallback" ? undefined : { text: payload.text },
        editFinal: async (id, edit) => {
          liveRecords.push({
            kind: "final-edit",
            caseId,
            previewId: id,
            edit,
            atEpochMs: Date.now()
          });
          if (mode === "retain-ambiguous-failure") {
            throw new Error("kova live preview edit failed after platform attempt started");
          }
        },
        createPreviewReceipt: (id, edit) => {
          const receipt = createPreviewMessageReceipt({ id, raw: { edit } });
          liveRecords.push({
            kind: "preview-receipt",
            caseId,
            previewId: id,
            messageId: receipt.primaryPlatformMessageId,
            atEpochMs: Date.now()
          });
          return receipt;
        },
        onPreviewFinalized: (id, receipt, state) => {
          liveRecords.push({
            kind: "preview-finalized",
            caseId,
            previewId: id,
            messageId: receipt.primaryPlatformMessageId,
            phase: state.phase,
            canFinalizeInPlace: state.canFinalizeInPlace,
            atEpochMs: Date.now()
          });
        },
        handlePreviewEditError: () => mode === "retain-ambiguous-failure" ? "retain" : "fallback",
        logPreviewEditFailure: (caught) => {
          liveRecords.push({
            kind: "preview-edit-failure",
            caseId,
            previewId,
            error: caught instanceof Error ? caught.message : String(caught),
            atEpochMs: Date.now()
          });
        }
      }),
      deliverNormally: async (payload) => {
        liveRecords.push({
          kind: "normal-delivery",
          caseId,
          targetId,
          text: payload?.text ?? null,
          atEpochMs: Date.now()
        });
        return true;
      },
      onNormalDelivered: () => {
        liveRecords.push({
          kind: "normal-delivered",
          caseId,
          targetId,
          atEpochMs: Date.now()
        });
      }
    });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }

  const finishedAtEpochMs = Date.now();
  return {
    ok: error === null,
    schemaVersion: "kova.channelProbe.livePreviewResult.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
    observation: {
      schemaVersion: "kova.channelProbe.livePreviewObservation.v1",
      channelId: CHANNEL_ID,
      accountId: activeRuntime.accountId,
      caseId,
      mode,
      targetId,
      resultKind: result?.kind ?? null,
      liveState: compactLiveState(result?.liveState),
      error: error?.message ?? null,
      startedAtEpochMs,
      finishedAtEpochMs,
      durationMs: Math.max(0, finishedAtEpochMs - startedAtEpochMs),
      liveRecords: liveRecords.slice(beforeLive)
    }
  };
}

function createProbeLivePreviewDraft({ caseId, previewId }) {
  return {
    flush: async () => {
      liveRecords.push({ kind: "draft-flush", caseId, previewId, atEpochMs: Date.now() });
    },
    id: () => previewId,
    seal: async () => {
      liveRecords.push({ kind: "draft-seal", caseId, previewId, atEpochMs: Date.now() });
    },
    discardPending: async () => {
      liveRecords.push({ kind: "discard-pending", caseId, previewId, atEpochMs: Date.now() });
    },
    clear: async () => {
      liveRecords.push({ kind: "draft-clear", caseId, previewId, atEpochMs: Date.now() });
    }
  };
}

function createProbeRenderedTextBatch(text) {
  return {
    payloads: [{ text }],
    plan: {
      payloadCount: 1,
      textCount: 1,
      mediaCount: 0,
      voiceCount: 0,
      presentationCount: 0,
      interactiveCount: 0,
      channelDataCount: 0,
      items: [{ index: 0, kinds: ["text"], text, mediaUrls: [] }]
    }
  };
}

function compactLiveState(state) {
  if (!state || typeof state !== "object") {
    return null;
  }
  return {
    phase: state.phase ?? null,
    canFinalizeInPlace: state.canFinalizeInPlace === true,
    receiptMessageId: state.receipt?.primaryPlatformMessageId ?? null,
    lastRenderedText: state.lastRendered?.payloads?.[0]?.text ?? null
  };
}

async function injectProbeInbound(params = {}) {
  if (!activeRuntime?.channelRuntime) {
    throw new Error("kova channel probe runtime is not started");
  }
  const message = requiredProbeString(params.message, "message");
  const inboundEventId = optionalProbeString(params.inboundEventId) ??
    `kova-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const targetId = optionalProbeString(params.targetId) ?? TARGET_ID;
  const replyToId = params.replyToId === null ? null : optionalProbeString(params.replyToId);
  const threadId = optionalProbeString(params.threadId);
  const silent = params.silent === true;
  const sourceReplyDeliveryMode = optionalProbeString(params.sourceReplyDeliveryMode);
  const requiredCapabilities = objectOrNull(params.requiredCapabilities);
  const platformScript = objectOrNull(params.platformScript);
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
  let recovery = null;
  const previousPlatformScript = activePlatformScript;
  activePlatformScript = createPlatformScript(platformScript, { inboundEventId });
  const receiveContext = createProbeReceiveContext({
    id: inboundEventId,
    message,
    ackPolicy: optionalProbeString(params.ackPolicy)
  });

  try {
    await maybeAckProbeReceiveContext(receiveContext, "receive_record");
    try {
      turn = await runOpenClawModelTurn({
        message,
        inboundEventId,
        targetId,
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
    if (shouldDrainPendingDeliveries(platformScript)) {
      recovery = await drainProbePendingDeliveries({
        targetId,
        inboundEventId,
        startedAtEpochMs,
        initialError: error?.message ?? null
      });
      if (recovery?.recovered === true) {
        error = null;
      }
    }
  } finally {
    activePlatformScript = previousPlatformScript;
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
      replyToId,
      threadId,
      silent,
      senderId,
      senderName,
      from
    },
    routeSessionKey: turn?.routeSessionKey ?? null,
    dispatched: turn?.dispatched === true,
    admission: turn?.admission ?? null,
    error: terminalError,
    initialError: recovery?.initialError ?? terminalError,
    recovery,
    startedAtEpochMs,
    finishedAtEpochMs,
    durationMs: Math.max(0, finishedAtEpochMs - startedAtEpochMs),
    outboundRecords: outboundRecords.slice(beforeOutbound),
    deliveryRecords: deliveryRecords.slice(beforeDelivery),
    ackRecords: ackRecords.slice(beforeAck),
    modelTurnRecords: modelTurnRecords.slice(beforeRecords),
    recoveryRecords: recoveryRecords.filter((record) => record.inboundEventId === inboundEventId)
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
  const observedAtEpochMs = Date.now();
  return {
    ...observation,
    observedAtEpochMs,
    durationMs: Math.max(0, observedAtEpochMs - observation.startedAtEpochMs),
    outboundRecords: outboundRecords.slice(outboundStart),
    deliveryRecords: deliveryRecords.slice(deliveryStart),
    ackRecords: ackRecords.slice(ackStart),
    modelTurnRecords: modelTurnRecords.slice(modelTurnStart)
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

function createPlatformScript(script, { inboundEventId }) {
  if (!script) {
    return null;
  }
  return {
    inboundEventId,
    failFirstSendAfterStart: script.firstSend === "error-after-platform-start",
    reconcileUnknownSend: optionalProbeString(script.reconcileUnknownSend),
    failedFirstSend: false
  };
}

function shouldDrainPendingDeliveries(script) {
  return objectOrNull(script)?.recoveryTrigger === "drain-pending-deliveries";
}

async function reconcileProbeUnknownSend(ctx) {
  const policy = activePlatformScript?.reconcileUnknownSend ?? "unresolved";
  const record = {
    kind: "reconcile-unknown-send",
    queueId: ctx.queueId,
    channel: ctx.channel,
    to: ctx.to,
    accountId: ctx.accountId ?? null,
    threadId: ctx.threadId ?? null,
    replyToId: ctx.replyToId ?? null,
    payloadCount: Array.isArray(ctx.payloads) ? ctx.payloads.length : 0,
    policy,
    inboundEventId: activePlatformScript?.inboundEventId ?? null,
    atEpochMs: Date.now()
  };
  recoveryRecords.push(record);
  if (policy === "not_sent") {
    return { status: "not_sent" };
  }
  if (policy === "sent") {
    const receipt = createReceipt(`kova-reconciled-${ctx.queueId}`, "text", {
      threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
      replyToId: ctx.replyToId ?? undefined
    });
    return {
      status: "sent",
      receipt,
      messageId: receipt.primaryPlatformMessageId
    };
  }
  return {
    status: "unresolved",
    error: "kova probe unknown-send reconciliation unresolved",
    retryable: true
  };
}

async function drainProbePendingDeliveries({ targetId, inboundEventId, startedAtEpochMs, initialError }) {
  const beforeOutbound = outboundRecords.length;
  const beforeRecovery = recoveryRecords.length;
  const result = {
    trigger: "drain-pending-deliveries",
    triggered: true,
    recovered: false,
    error: null,
    initialError,
    outboundRecordOffset: beforeOutbound,
    recoveryRecordOffset: beforeRecovery,
    startedAtEpochMs: Date.now(),
    finishedAtEpochMs: null,
    durationMs: null
  };
  try {
    const { drainPendingDeliveries } = await import("openclaw/plugin-sdk/delivery-queue-runtime");
    await drainPendingDeliveries({
      drainKey: `${CHANNEL_ID}:${ACCOUNT_ID}:${inboundEventId}`,
      logLabel: "Kova channel probe delivery drain",
      cfg: activeRuntime.cfg,
      log: {
        info: (message) => recoveryRecords.push({ kind: "delivery-drain-log", level: "info", inboundEventId, message, atEpochMs: Date.now() }),
        warn: (message) => recoveryRecords.push({ kind: "delivery-drain-log", level: "warn", inboundEventId, message, atEpochMs: Date.now() }),
        error: (message) => recoveryRecords.push({ kind: "delivery-drain-log", level: "error", inboundEventId, message, atEpochMs: Date.now() })
      },
      selectEntry: (entry) => ({
        match:
          entry.channel === CHANNEL_ID &&
          entry.accountId === ACCOUNT_ID &&
          entry.to === targetId &&
          entry.enqueuedAt >= startedAtEpochMs - 1_000,
        bypassBackoff: true
      })
    });
    result.recovered = outboundRecords.slice(beforeOutbound).some((record) =>
      record.kind === "text" || record.kind === "media" || record.kind === "payload"
    );
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.finishedAtEpochMs = Date.now();
    result.durationMs = Math.max(0, result.finishedAtEpochMs - result.startedAtEpochMs);
  }
  return result;
}

function buildKovaImageGenerationProvider() {
  return {
    id: KOVA_IMAGE_PROVIDER_ID,
    label: "Kova Channel Probe Image Provider",
    defaultModel: KOVA_IMAGE_MODEL_ID,
    models: [KOVA_IMAGE_MODEL_ID],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false
      },
      edit: {
        enabled: false,
        maxCount: 0,
        maxInputImages: 0,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false
      },
      output: {
        formats: ["png"]
      }
    },
    isConfigured: () => true,
    generateImage: async (req) => {
      const count = Number.isInteger(req.count) && req.count > 0 ? Math.min(req.count, 4) : 1;
      return {
        images: Array.from({ length: count }, (_, index) => ({
          buffer: KOVA_PNG_1X1,
          mimeType: "image/png",
          fileName: `kova-generated-image-${index + 1}.png`,
          revisedPrompt: req.prompt,
          metadata: {
            kovaProvider: true,
            prompt: req.prompt
          }
        })),
        model: req.model || KOVA_IMAGE_MODEL_ID,
        metadata: {
          kovaProvider: true
        }
      };
    }
  };
}

async function runOpenClawModelTurn({
  message,
  inboundEventId,
  targetId = TARGET_ID,
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
  const cfg = activeRuntime.cfg;
  const baseRoute = runtime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    peer: { kind: "direct", id: targetId }
  });
  const route = resolveThreadedRoute(baseRoute, threadId);
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
    AccountId: ACCOUNT_ID,
    ChatType: "direct",
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

  return await runtime.turn.runAssembled({
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
          return deliverAdapterPayload(delivered, { targetId, replyToId, threadId, silent });
        }
        return recordUnhandledDeliveryPayload(delivered, { targetId, replyToId, threadId, silent, info });
      },
      onDelivered: async (delivered, info, result) => {
        deliveryRecords.push({
          path: "durable-message-send-context",
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
    replyOptions: sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : undefined,
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
}

function resolveThreadedRoute(route, threadId) {
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    return route;
  }
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    threadId
  });
  return {
    ...route,
    sessionKey: threadKeys.sessionKey
  };
}

async function recordOutbound(kind, ctx) {
  if (activePlatformScript?.failFirstSendAfterStart === true && activePlatformScript.failedFirstSend !== true) {
    activePlatformScript.failedFirstSend = true;
    outboundRecords.push({
      kind: "platform-send-failure",
      attemptedKind: kind,
      to: ctx.to ?? null,
      text: ctx.text ?? null,
      mediaUrl: ctx.mediaUrl ?? null,
      silent: ctx.silent ?? false,
      threadId: ctx.threadId ?? null,
      replyToId: ctx.replyToId ?? null,
      error: "kova probe platform send failed after the send attempt started",
      atEpochMs: Date.now()
    });
    throw new Error("kova probe platform send failed after the send attempt started");
  }
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
    mediaUrl: ctx.mediaUrl ?? null,
    mediaPathExists: typeof ctx.mediaUrl === "string" && existsSync(ctx.mediaUrl),
    payload: ctx.payload ?? null,
    isError: ctx.payload?.isError === true || ctx.isError === true,
    silent: ctx.silent ?? false,
    threadId: ctx.threadId ?? null,
    replyToId: ctx.replyToId ?? null
  });
  return { messageId, receipt };
}

async function deliverAdapterPayload(payload, options = {}) {
  const mediaUrl = firstMediaUrl(payload);
  return await recordOutbound(mediaUrl ? "media" : payload?.channelData ? "payload" : "text", {
    to: options.targetId ?? TARGET_ID,
    text: payload?.text ?? null,
    mediaUrl,
    payload,
    isError: payload?.isError === true,
    silent: options.silent === true,
    threadId: options.threadId ?? null,
    replyToId: options.replyToId ?? null
  });
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
