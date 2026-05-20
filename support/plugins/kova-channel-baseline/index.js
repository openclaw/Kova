import { existsSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  classifyDurableSendRecoveryState,
  createDurableMessageStateRecord,
  createLiveMessageState,
  createMessageReceiveContext,
  createPreviewMessageReceipt,
  defineChannelMessageAdapter,
  deliverFinalizableLivePreview,
  deliverWithFinalizableLivePreviewAdapter,
  deriveDurableFinalDeliveryRequirements,
  markLiveMessagePreviewUpdated,
  shouldAckMessageAfterStage,
  withDurableMessageSendContext
} from "openclaw/plugin-sdk/channel-message";

const CHANNEL_ID = "kova-channel-baseline";
const ACCOUNT_ID = "default";
const TARGET_ID = "dm:kova-baseline-user";
const TARGET_USER_ID = "kova-baseline-user";
const TARGET_DISPLAY = "Kova Baseline User";
const KOVA_IMAGE_PROVIDER_ID = "kova-channel-baseline";
const KOVA_IMAGE_MODEL_ID = "kova-image";
const KOVA_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

let activeRuntime = null;
let outboundRecords = [];
let deliveryRecords = [];
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
    label: "Kova Channel Baseline",
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
      hint: "dm:kova-baseline-user",
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
  id: "kova-channel-baseline",
  name: "Kova Channel Baseline",
  description: "OpenClaw channel capability baseline fixture used by Kova.",
  register(api) {
    api.registerChannel(plugin);
    if (typeof api.registerImageGenerationProvider === "function") {
      api.registerImageGenerationProvider(buildKovaImageGenerationProvider());
    }
    api.registerGatewayMethod(
      "kova.channelBaseline.status",
      ({ respond }) => {
        respond(true, {
          ok: Boolean(activeRuntime?.channelRuntime),
          channelId: CHANNEL_ID,
          accountId: activeRuntime?.accountId ?? null,
          startedAt: activeRuntime?.startedAt ?? null
        });
      },
      { scope: "operator.read" }
    );
    api.registerGatewayMethod(
      "kova.channelBaseline.run",
      async ({ params, respond }) => {
        try {
          const result = await runBaseline(params);
          respond(true, result);
        } catch (error) {
          respond(true, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      },
      { scope: "operator.write" }
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
  modelTurnRecords = [];
  probeObservations = [];
  recoveryRecords = [];
}

async function injectProbeInbound(params = {}) {
  if (!activeRuntime?.channelRuntime) {
    throw new Error("kova channel baseline runtime is not started");
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
  const beforeRecords = modelTurnRecords.length;
  const startedAtEpochMs = Date.now();
  let turn = null;
  let error = null;
  let recovery = null;
  const previousPlatformScript = activePlatformScript;
  activePlatformScript = createPlatformScript(platformScript, { inboundEventId });

  try {
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
  const modelTurnStart = Number.isInteger(offsets.modelTurn) ? offsets.modelTurn : 0;
  const observedAtEpochMs = Date.now();
  return {
    ...observation,
    observedAtEpochMs,
    durationMs: Math.max(0, observedAtEpochMs - observation.startedAtEpochMs),
    outboundRecords: outboundRecords.slice(outboundStart),
    deliveryRecords: deliveryRecords.slice(deliveryStart),
    modelTurnRecords: modelTurnRecords.slice(modelTurnStart)
  };
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
    label: "Kova Channel Baseline Image Provider",
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

async function runBaseline(params = {}) {
  if (!activeRuntime?.channelRuntime) {
    throw new Error("kova channel baseline runtime is not started");
  }
  outboundRecords = [];
  deliveryRecords = [];

  const requestedGroups = normalizeRequestedGroups(params.group ?? params.groups);
  const scenarios = baselineScenarios.filter((scenario) =>
    requestedGroups === null || requestedGroups.has(scenario.group)
  );
  if (scenarios.length === 0) {
    throw new Error(`no kova channel baseline scenarios matched group ${JSON.stringify(params.group ?? params.groups)}`);
  }

  const proofs = [];
  for (const scenario of scenarios) {
    const startedAt = performance.now();
    try {
      const evidence = await scenario.run();
      proofs.push({
        group: scenario.group,
        capabilityId: scenario.capabilityId,
        status: "passed",
        reason: null,
        durationMs: elapsedMs(startedAt),
        evidence
      });
    } catch (error) {
      proofs.push({
        group: scenario.group,
        capabilityId: scenario.capabilityId,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        durationMs: elapsedMs(startedAt)
      });
    }
  }

  return {
    ok: proofs.every((proof) => proof.status === "passed"),
    schemaVersion: "kova.channelCapabilityBaselinePluginRun.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
    groups: requestedGroups === null ? null : [...requestedGroups].sort(),
    proofCount: proofs.length,
    proofs,
    outboundRecords,
    deliveryRecords
  };
}

function normalizeRequestedGroups(value) {
  if (value == null || value === "" || value === "all") {
    return null;
  }
  const values = Array.isArray(value)
    ? value
    : String(value).split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) {
    return null;
  }
  return new Set(values);
}

const baselineScenarios = [
  durableTurnScenario("text", { text: "KOVA_CHANNEL_TEXT_OK" }, {
    expectedKind: "text",
    requiredCapabilities: { text: true, messageSendingHooks: true }
  }),
  durableTurnScenario("media", { text: "caption", mediaUrls: ["https://example.com/kova-channel-baseline.png"] }, {
    expectedKind: "media",
    requiredCapabilities: { media: true, messageSendingHooks: true }
  }),
  durableTurnScenario("payload", {
    text: "",
    channelData: { kovaBaseline: { card: "card" } }
  }, {
    expectedKind: "payload",
    durablePayload: {
      text: "",
      channelData: { kovaBaseline: { card: "card" } }
    },
    requiredCapabilities: { payload: true, messageSendingHooks: true }
  }),
  durableTurnScenario("silent", { text: "quiet" }, {
    expectedKind: "text",
    silent: true,
    requiredCapabilities: { text: true, silent: true, messageSendingHooks: true }
  }),
  durableTurnScenario("reply-to", { text: "reply" }, {
    expectedKind: "text",
    replyToId: "baseline-reply-1",
    requiredCapabilities: { text: true, replyTo: true, messageSendingHooks: true }
  }),
  durableTurnScenario("thread", { text: "thread" }, {
    expectedKind: "text",
    threadId: "thread-1",
    requiredCapabilities: { text: true, thread: true, messageSendingHooks: true }
  }),
  {
    group: "durable-final",
    capabilityId: "native-quote",
    run: async () => {
      const requirements = deriveDurableFinalDeliveryRequirements({
        payload: { text: "quote" },
        extraCapabilities: { nativeQuote: true }
      });
      assert(requirements.nativeQuote === true, "native quote requirement was not derived");
      assert(messageAdapter.durableFinal?.capabilities?.nativeQuote === true, "message adapter does not declare nativeQuote");
      return { requirement: "nativeQuote", adapterCapability: true };
    }
  },
  durableTurnScenario("message-sending-hooks", { text: "hooks" }, {
    expectedKind: "text",
    requiredCapabilities: { text: true, messageSendingHooks: true },
    expectLifecycle: true
  }),
  durableTurnScenario("batch", [{ text: "one" }, { text: "two" }], {
    expectedKind: "text",
    requiredCapabilities: { text: true, batch: true, messageSendingHooks: true },
    expectBatch: 2
  }),
  {
    group: "durable-final",
    capabilityId: "reconcile-unknown-send",
    run: async () => {
      const requirements = deriveDurableFinalDeliveryRequirements({
        payload: { text: "unknown" },
        reconcileUnknownSend: true
      });
      assert(requirements.reconcileUnknownSend === true, "unknown-send reconciliation requirement was not derived");
      const state = classifyDurableSendRecoveryState({
        hasIntent: true,
        hasReceipt: false,
        platformSendMayHaveStarted: true
      });
      const record = createDurableMessageStateRecord({
        intent: { id: "intent-unknown", channel: CHANNEL_ID, to: TARGET_ID, durability: "required" },
        state
      });
      assert(record.state === "unknown_after_send", "unknown send state was not preserved");
      return { requirement: "reconcileUnknownSend", recoveryState: record.state };
    }
  },
  {
    group: "durable-final",
    capabilityId: "after-send-success",
    run: async () => {
      const start = outboundRecords.length;
      await recordOutbound("text", { text: "success", to: TARGET_ID });
      await messageAdapter.send.lifecycle.afterSendSuccess({
        result: { receipt: createReceipt("manual-success") }
      });
      const observed = outboundRecords.slice(start).find((record) => record.kind === "after-send-success");
      assert(observed?.messageId === "manual-success", "after-send-success hook did not observe receipt");
      return { observedReceipt: observed.messageId };
    }
  },
  {
    group: "durable-final",
    capabilityId: "after-commit",
    run: async () => {
      const calls = [];
      await withDurableMessageSendContext(
        {
          cfg: activeRuntime.cfg,
          channel: CHANNEL_ID,
          to: TARGET_ID,
          payloads: [{ text: "commit" }],
          onCommitReceipt: async (receipt) => {
            calls.push(receipt.primaryPlatformMessageId);
          }
        },
        async (ctx) => {
          await ctx.commit(createReceipt("commit-1"));
        }
      );
      assert(calls[0] === "commit-1", "after-commit hook did not observe committed receipt");
      return { committedReceipt: calls[0] };
    }
  },
  {
    group: "live-preview",
    capabilityId: "draft-preview",
    run: async () => {
      const rendered = await renderPayloads([{ text: "draft preview" }]);
      const state = markLiveMessagePreviewUpdated(createLiveMessageState(), rendered);
      assert(state.phase === "previewing", "draft preview did not enter previewing state");
      return { phase: state.phase, textCount: state.lastRendered?.plan?.textCount ?? null };
    }
  },
  {
    group: "live-preview",
    capabilityId: "preview-finalization",
    run: async () => {
      const result = await finalizePreview({ previewId: "preview-final" });
      assert(result.kind === "preview-finalized", "preview finalization did not finalize in place");
      return { resultKind: result.kind, phase: result.liveState?.phase ?? null };
    }
  },
  {
    group: "live-preview",
    capabilityId: "progress-updates",
    run: async () => {
      const first = await renderPayloads([{ text: "step one" }]);
      const second = await renderPayloads([{ text: "step two" }]);
      const state = markLiveMessagePreviewUpdated(
        markLiveMessagePreviewUpdated(createLiveMessageState(), first),
        second
      );
      assert(state.lastRendered?.payloads?.[0]?.text === "step two", "latest progress update was not retained");
      return { phase: state.phase, lastText: state.lastRendered.payloads[0].text };
    }
  },
  {
    group: "live-preview",
    capabilityId: "native-streaming",
    run: async () => {
      const result = await deliverWithFinalizableLivePreviewAdapter({
        kind: "block",
        payload: { text: "streaming block" },
        adapter: {
          buildFinalEdit: () => ({ text: "streaming final" }),
          editFinal: async () => undefined
        },
        deliverNormally: async () => true
      });
      assert(result.kind === "normal-delivered", "non-final streaming block did not route normally");
      assert(messageAdapter.live?.capabilities?.nativeStreaming === true, "adapter does not declare nativeStreaming");
      return { adapterCapability: true, resultKind: result.kind };
    }
  },
  {
    group: "live-preview",
    capabilityId: "quiet-finalization",
    run: async () => {
      let normalDeliveries = 0;
      const result = await finalizePreview({
        previewId: "quiet-final",
        deliverNormally: async () => {
          normalDeliveries += 1;
          return true;
        }
      });
      assert(result.kind === "preview-finalized", "quiet finalization did not finalize preview");
      assert(normalDeliveries === 0, "quiet finalization performed normal delivery");
      return { resultKind: result.kind, normalDeliveries };
    }
  },
  {
    group: "live-finalizer",
    capabilityId: "final-edit",
    run: async () => {
      const edits = [];
      const result = await finalizePreview({
        previewId: "final-edit",
        editFinal: async (id, edit) => {
          edits.push({ id, edit });
        }
      });
      assert(result.kind === "preview-finalized", "final edit did not finalize preview");
      assert(edits[0]?.id === "final-edit", "final edit did not target preview id");
      return { resultKind: result.kind, editedId: edits[0].id };
    }
  },
  {
    group: "live-finalizer",
    capabilityId: "normal-fallback",
    run: async () => {
      let delivered = 0;
      const result = await finalizePreview({
        previewId: "normal-fallback",
        buildFinalEdit: () => undefined,
        deliverNormally: async () => {
          delivered += 1;
          return true;
        }
      });
      assert(result.kind === "normal-delivered", "normal fallback did not deliver normally");
      return { resultKind: result.kind, normalDeliveries: delivered };
    }
  },
  {
    group: "live-finalizer",
    capabilityId: "discard-pending",
    run: async () => {
      const calls = [];
      const result = await finalizePreview({
        previewId: "discard-pending",
        buildFinalEdit: () => undefined,
        draftOverrides: {
          discardPending: async () => calls.push("discard"),
          clear: async () => calls.push("clear")
        }
      });
      assert(result.kind === "normal-delivered", "discard-pending fallback did not complete normal delivery");
      assert(calls.includes("discard"), "pending preview was not discarded before fallback");
      assert(calls.includes("clear"), "draft was not cleared after fallback delivery");
      return { resultKind: result.kind, draftCalls: calls };
    }
  },
  {
    group: "live-finalizer",
    capabilityId: "preview-receipt",
    run: async () => {
      const receipt = createPreviewMessageReceipt({
        id: "preview-receipt",
        threadId: "thread-1",
        replyToId: "reply-1",
        sentAt: 123
      });
      assert(receipt.primaryPlatformMessageId === "preview-receipt", "preview receipt primary id was wrong");
      assert(receipt.parts?.[0]?.kind === "preview", "preview receipt did not include preview part");
      return { receiptId: receipt.primaryPlatformMessageId, receiptKind: receipt.parts[0].kind };
    }
  },
  {
    group: "live-finalizer",
    capabilityId: "retain-on-ambiguous-failure",
    run: async () => {
      const result = await finalizePreview({
        previewId: "retain-preview",
        editFinal: async () => {
          throw new Error("ambiguous edit failure");
        },
        handlePreviewEditError: async () => "retain"
      });
      assert(result.kind === "preview-retained", "ambiguous preview edit failure was not retained");
      return { resultKind: result.kind, phase: result.liveState?.phase ?? null };
    }
  },
  ackScenario("after-receive-record", "after_receive_record", "receive_record"),
  ackScenario("after-agent-dispatch", "after_agent_dispatch", "agent_dispatch"),
  ackScenario("after-durable-send", "after_durable_send", "durable_send"),
  ackScenario("manual", "manual", null),
  workflowTurnScenario("media-thread-final", {
    payload: { text: "workflow media thread", mediaUrls: ["https://example.com/kova-workflow-thread.png"] },
    expectedKind: "media",
    threadId: "workflow-thread-1",
    expectedMediaUrl: "https://example.com/kova-workflow-thread.png"
  }),
  workflowTurnScenario("media-reply-thread-final", {
    payload: { text: "workflow media reply thread", mediaUrls: ["https://example.com/kova-workflow-reply-thread.png"] },
    expectedKind: "media",
    replyToId: "workflow-reply-1",
    threadId: "workflow-thread-2",
    expectedMediaUrl: "https://example.com/kova-workflow-reply-thread.png"
  }),
  workflowTurnScenario("single-inbound-single-final", {
    payload: { text: "workflow single final" },
    expectedKind: "text",
    expectedText: "workflow single final",
    expectedFinalSends: 1
  }),
  workflowTurnScenario("final-delivery-receipt-required", {
    payload: { text: "workflow receipt", mediaUrls: ["https://example.com/kova-workflow-receipt.png"] },
    expectedKind: "media",
    expectedMediaUrl: "https://example.com/kova-workflow-receipt.png",
    requireReceipt: true
  }),
  workflowTurnScenario("terminal-after-final", {
    payload: { text: "workflow terminal" },
    expectedKind: "text",
    expectedText: "workflow terminal",
    requireTerminalReturn: true
  })
];

function durableTurnScenario(capabilityId, replyPayload, options) {
  return {
    group: "durable-final",
    capabilityId,
    run: async () => {
      const payloads = Array.isArray(replyPayload) ? replyPayload : [replyPayload];
      const requirements = deriveDurableFinalDeliveryRequirements({
        payload: options.durablePayload ?? payloads[0],
        silent: options.silent,
        replyToId: options.replyToId,
        threadId: options.threadId,
        batch: options.expectBatch ? true : undefined,
        extraCapabilities: options.requiredCapabilities
      });
      for (const [key, expected] of Object.entries(options.requiredCapabilities ?? {})) {
        assert(requirements[key] === expected, `${key} delivery requirement was not derived`);
      }

      const beforeOutbound = outboundRecords.length;
      const beforeDelivery = deliveryRecords.length;
      const turn = await runSyntheticTurn({
        payload: replyPayload,
        replyToId: options.replyToId,
        threadId: options.threadId,
        silent: options.silent,
        durablePayload: options.durablePayload,
        requiredCapabilities: options.requiredCapabilities
      });
      assert(turn?.dispatched === true, "OpenClaw channel turn did not dispatch");
      const newOutbound = outboundRecords.slice(beforeOutbound).filter((record) =>
        ["text", "media", "payload"].includes(record.kind)
      );
      const newDeliveries = deliveryRecords.slice(beforeDelivery);
      assert(newOutbound.length >= (options.expectBatch ?? 1), "durable turn did not call channel send adapter");
      const first = newOutbound[0];
      assert(first.kind === options.expectedKind, `expected ${options.expectedKind} adapter call, got ${first.kind}`);
      if (options.replyToId) {
        assert(first.replyToId === options.replyToId, "replyToId was not preserved");
      }
      if (options.threadId) {
        assert(first.threadId === options.threadId, "threadId was not preserved");
      }
      if (options.silent) {
        assert(first.silent === true, "silent send intent was not preserved");
      }
      if (options.expectLifecycle) {
        assert(outboundRecords.slice(beforeOutbound).some((record) => record.kind === "after-send-success"), "after-send-success hook did not run");
      }
      if (options.expectBatch) {
        assert(newOutbound.length === options.expectBatch, "batch send did not preserve payload count");
        assert(newOutbound.map((record) => record.text).join("|") === "one|two", "batch send did not preserve order");
      }
      assert(newDeliveries.length > 0, "turn did not report durable delivery result");
      return {
        turnDispatched: true,
        adapterCalls: newOutbound.length,
        deliveryResults: newDeliveries.length,
        firstKind: first.kind,
        firstMessageId: first.messageId
      };
    }
  };
}

function workflowTurnScenario(capabilityId, options) {
  return {
    group: "workflow",
    capabilityId,
    run: async () => {
      const beforeOutbound = outboundRecords.length;
      const beforeDelivery = deliveryRecords.length;
      const turn = await runSyntheticTurn({
        payload: options.payload,
        replyToId: options.replyToId,
        threadId: options.threadId,
        requiredCapabilities: {
          text: true,
          media: options.expectedKind === "media",
          replyTo: Boolean(options.replyToId),
          thread: Boolean(options.threadId),
          messageSendingHooks: true
        }
      });
      assert(turn?.dispatched === true, "workflow turn did not dispatch through OpenClaw channel runtime");

      const caseOutbound = outboundRecords.slice(beforeOutbound).filter((record) =>
        ["text", "media", "payload"].includes(record.kind)
      );
      const caseDeliveries = deliveryRecords.slice(beforeDelivery);
      const visibleDeliveries = caseDeliveries.filter((record) => record.fallback === false);
      const firstOutbound = caseOutbound[0] ?? null;
      const firstDelivery = visibleDeliveries[0] ?? null;
      const expectedFinalSends = options.expectedFinalSends ?? 1;

      assert(caseOutbound.length === expectedFinalSends, `${capabilityId} expected ${expectedFinalSends} final send(s), observed ${caseOutbound.length}`);
      assert(firstOutbound?.kind === options.expectedKind, `${capabilityId} expected ${options.expectedKind} outbound kind, got ${firstOutbound?.kind ?? "none"}`);
      if (options.expectedText) {
        assert(firstOutbound?.text === options.expectedText, `${capabilityId} did not preserve final text`);
      }
      if (options.expectedMediaUrl) {
        assert(firstOutbound?.mediaUrl === options.expectedMediaUrl, `${capabilityId} did not preserve final media URL`);
      }
      if (options.replyToId) {
        assert(firstOutbound?.replyToId === options.replyToId, `${capabilityId} did not preserve reply target`);
        assert(firstDelivery?.replyToId === options.replyToId, `${capabilityId} delivery record did not preserve reply target`);
      }
      if (options.threadId) {
        assert(firstOutbound?.threadId === options.threadId, `${capabilityId} did not preserve thread target`);
        assert(firstDelivery?.threadId === options.threadId, `${capabilityId} delivery record did not preserve thread target`);
      }
      if (options.requireReceipt) {
        assert(Array.isArray(firstDelivery?.messageIds) && firstDelivery.messageIds.length > 0, `${capabilityId} did not record final delivery receipt ids`);
      }
      if (options.requireTerminalReturn) {
        assert(turn?.dispatched === true, `${capabilityId} did not return from channel dispatch after final delivery`);
      }

      return {
        turnDispatched: true,
        finalSendCount: caseOutbound.length,
        visibleDeliveryCount: visibleDeliveries.length,
        firstKind: firstOutbound?.kind ?? null,
        firstMessageId: firstOutbound?.messageId ?? null,
        receiptIds: firstDelivery?.messageIds ?? [],
        threadId: firstOutbound?.threadId ?? null,
        replyToId: firstOutbound?.replyToId ?? null
      };
    }
  };
}

async function runSyntheticTurn({
  payload,
  replyToId = "baseline-inbound-1",
  threadId,
  silent,
  durablePayload,
  requiredCapabilities
}) {
  const runtime = activeRuntime.channelRuntime;
  const cfg = activeRuntime.cfg;
  const route = runtime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    peer: { kind: "direct", id: TARGET_ID }
  });
  const storePath = runtime.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: "Kova channel baseline inbound",
    BodyForAgent: "Kova channel baseline inbound",
    RawBody: "Kova channel baseline inbound",
    CommandBody: "Kova channel baseline inbound",
    From: TARGET_ID,
    To: TARGET_ID,
    OriginatingTo: TARGET_ID,
    SessionKey: route.sessionKey,
    AccountId: ACCOUNT_ID,
    ChatType: "direct",
    SenderName: "Kova Baseline User",
    SenderId: "kova-baseline-user",
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: `kova-inbound-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    MessageSidFull: "kova-inbound-full",
    ReplyToId: replyToId,
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
    recordInboundSession: runtime.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: runtime.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      durable: {
        replyToMode: "first",
        silent,
        replyToId,
        threadId,
        requiredCapabilities
      },
      preparePayload: (prepared) => durablePayload ?? prepared,
      deliver: async (delivered) => {
        return await deliverFallbackPayload(delivered, { replyToId, threadId, silent });
      },
      onDelivered: async (delivered, info, result) => {
        deliveryRecords.push({
          fallback: false,
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
    replyResolver: async () => payload,
    record: {
      onRecordError: (error) => {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  });
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
      deliver: async (delivered) => {
        return await deliverFallbackPayload(delivered, { targetId, replyToId, threadId, silent });
      },
      onDelivered: async (delivered, info, result) => {
        deliveryRecords.push({
          fallback: false,
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

async function renderPayloads(payloads) {
  return await withDurableMessageSendContext(
    {
      cfg: activeRuntime?.cfg ?? {},
      channel: CHANNEL_ID,
      to: TARGET_ID,
      payloads
    },
    async (ctx) => await ctx.render()
  );
}

async function finalizePreview(options = {}) {
  const draft = {
    flush: async () => undefined,
    id: () => options.previewId ?? "preview-1",
    seal: async () => undefined,
    clear: async () => undefined,
    discardPending: async () => undefined,
    ...(options.draftOverrides ?? {})
  };
  const liveState = createLiveMessageState({
    receipt: createReceipt(options.previewId ?? "preview-1"),
    canFinalizeInPlace: true
  });
  return await deliverFinalizableLivePreview({
    kind: "final",
    payload: { text: "final" },
    liveState,
    draft,
    buildFinalEdit: options.buildFinalEdit ?? ((payload) => ({ text: payload.text })),
    editFinal: options.editFinal ?? (async () => undefined),
    deliverNormally: options.deliverNormally ?? (async () => true),
    createPreviewReceipt: options.createPreviewReceipt,
    handlePreviewEditError: options.handlePreviewEditError,
    logPreviewEditFailure: () => undefined
  });
}

function ackScenario(capabilityId, policy, expectedStage) {
  return {
    group: "ack",
    capabilityId,
    run: async () => {
      const stages = ["receive_record", "agent_dispatch", "durable_send", "manual"];
      for (const stage of stages) {
        const expected = expectedStage === stage;
        assert(
          shouldAckMessageAfterStage(policy, stage) === expected,
          `${policy} shouldAckMessageAfterStage(${stage}) did not match expected ${expected}`
        );
      }

      let ackCalls = 0;
      let nackMessage = null;
      const ctx = createMessageReceiveContext({
        id: `msg-${policy}`,
        channel: CHANNEL_ID,
        message: { text: "hello" },
        ackPolicy: policy,
        onAck: async () => {
          ackCalls += 1;
        },
        onNack: async (error) => {
          nackMessage = error instanceof Error ? error.message : String(error);
        }
      });
      assert(ctx.shouldAckAfter(expectedStage ?? "manual") === Boolean(expectedStage), `${policy} receive context ack stage mismatch`);
      await ctx.ack();
      await ctx.ack();
      assert(ctx.ackState === "acked", `${policy} receive context did not enter acked state`);
      assert(ackCalls === 1, `${policy} ack was not idempotent`);
      await ctx.nack(new Error("baseline nack"));
      assert(ctx.ackState === "nacked", `${policy} receive context did not enter nacked state`);
      assert(nackMessage === "baseline nack", `${policy} nack did not preserve error message`);
      return { policy, expectedStage, ackCalls, nackMessage };
    }
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

async function deliverFallbackPayload(payload, options = {}) {
  const mediaUrl = firstMediaUrl(payload);
  const ctx = {
    to: options.targetId ?? TARGET_ID,
    text: payload?.text ?? "",
    isError: payload?.isError === true,
    replyToId: options.replyToId ?? undefined,
    threadId: options.threadId ?? undefined,
    silent: options.silent === true
  };
  const result = mediaUrl
    ? await messageAdapter.send.media({ ...ctx, mediaUrl })
    : payload?.channelData
      ? await messageAdapter.send.payload({ ...ctx, payload })
      : await messageAdapter.send.text(ctx);
  const messageIds = result?.receipt?.platformMessageIds ?? [];
  deliveryRecords.push({
    fallback: true,
    kind: mediaUrl ? "media" : payload?.channelData ? "payload" : "text",
    text: payload?.text ?? null,
    mediaUrl: mediaUrl ?? null,
    mediaUrls: Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : mediaUrl ? [mediaUrl] : [],
    isError: payload?.isError === true,
    replyToId: options.replyToId ?? null,
    threadId: options.threadId ?? null,
    silent: options.silent === true,
    visibleReplySent: messageIds.length > 0,
    messageIds
  });
  return {
    messageIds,
    visibleReplySent: messageIds.length > 0
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

function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function invariant(id, condition, summary) {
  return {
    id,
    status: condition ? "passed" : "failed",
    summary,
    reason: condition ? null : summary
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

function textEquals(actual, expected) {
  return typeof actual === "string" && typeof expected === "string" && actual.trim() === expected.trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
