import { existsSync, unlinkSync, writeFileSync } from "node:fs";
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
    }
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
      "kova.channelBaseline.runModelTurn",
      async ({ params, respond }) => {
        try {
          const result = await runModelTurn(params);
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
          observations: probeObservations
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
  const senderId = optionalProbeString(params.senderId) ?? TARGET_USER_ID;
  const senderName = optionalProbeString(params.senderName) ?? TARGET_DISPLAY;
  const from = optionalProbeString(params.from) ?? targetId;
  const beforeOutbound = outboundRecords.length;
  const beforeDelivery = deliveryRecords.length;
  const beforeRecords = modelTurnRecords.length;
  const startedAtEpochMs = Date.now();
  let turn = null;
  let error = null;

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
      senderName
    });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }

  const finishedAtEpochMs = Date.now();
  const observation = {
    schemaVersion: "kova.channelProbe.observation.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
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
    error: error?.message ?? null,
    startedAtEpochMs,
    finishedAtEpochMs,
    durationMs: Math.max(0, finishedAtEpochMs - startedAtEpochMs),
    outboundRecords: outboundRecords.slice(beforeOutbound),
    deliveryRecords: deliveryRecords.slice(beforeDelivery),
    modelTurnRecords: modelTurnRecords.slice(beforeRecords)
  };
  probeObservations.push(observation);
  return {
    ok: error === null,
    schemaVersion: "kova.channelProbe.injectResult.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
    observation
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

async function runModelTurn(params = {}) {
  if (!activeRuntime?.channelRuntime) {
    throw new Error("kova channel baseline runtime is not started");
  }
  const selectedCases = selectModelTurnCases(params.cases);
  const expectedText = typeof params.expectedText === "string" && params.expectedText.length > 0
    ? params.expectedText
    : (selectedCases.length === 1 ? selectedCases[0].expectedText : null);
  const includeSharedBaseline = params.includeSharedBaseline !== false;

  const capabilityBaseline = includeSharedBaseline
    ? await runBaseline()
    : {
        ok: true,
        proofs: [],
        proofCount: 0
      };
  outboundRecords = [];
  deliveryRecords = [];
  modelTurnRecords = [];

  const startedAt = performance.now();
  const modelTurnCases = [];
  for (const testCase of selectedCases) {
    modelTurnCases.push(await runModelTurnCase(testCase));
  }

  const finalOutboundRecords = outboundRecords.filter((record) => isFinalOutboundRecord(record));
  const finalTexts = modelTurnCases
    .map((testCase) => testCase.finalText)
    .filter((text) => typeof text === "string" && text.length > 0);
  const matchedText = typeof expectedText === "string"
    ? (finalTexts.find((text) => textEquals(text, expectedText)) ?? null)
    : null;
  const failedCases = modelTurnCases.filter((testCase) => testCase.status !== "passed");
  const capabilityRows = [
    ...(capabilityBaseline.proofs ?? []).map((proof) => ({
      group: proof.group,
      capabilityId: proof.capabilityId,
      status: proof.status,
      proofMode: "shared-runtime-baseline",
      caseId: null,
      reason: proof.reason ?? null
    })),
    ...modelTurnCases.flatMap((testCase) => testCase.capabilities.map((capability) => ({
      group: capability.group,
      capabilityId: capability.id,
      status: testCase.status,
      proofMode: "model-turn",
      caseId: testCase.id,
      workflow: testCase.workflow,
      inventoryWorkflow: testCase.inventoryWorkflow,
      matrix: testCase.matrix,
      userAction: testCase.userAction,
      ownerArea: testCase.ownerArea,
      reason: testCase.reason
    })))
  ];
  const invariants = [
    ...(includeSharedBaseline
      ? [invariant("shared-capability-baseline", capabilityBaseline.ok === true, "all shared OpenClaw channel capabilities passed before model-turn proof")]
      : []),
    invariant("model-turn-case-count", modelTurnCases.length === selectedCases.length, "all requested channel model-turn cases ran"),
    invariant("model-turn-cases-passed", failedCases.length === 0, "all channel model-turn cases passed"),
    invariant("expected-final-text", expectedText === null || Boolean(matchedText), expectedText === null ? "model-turn final channel text is checked per case" : `at least one model-turn final channel send equals ${expectedText}`),
    invariant("terminal-return", modelTurnCases.every((testCase) => testCase.dispatched === true), "all channel model turns returned from OpenClaw dispatch")
  ];
  const ok = invariants.every((item) => item.status === "passed");

  return {
    ok,
    schemaVersion: "kova.channelModelTurnBaselinePluginRun.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
    requestedCase: params.case ?? params.caseId ?? null,
    workflowCaseCatalogId: typeof params.workflowCaseCatalogId === "string" ? params.workflowCaseCatalogId : null,
    expectedText,
    sharedBaselineIncluded: includeSharedBaseline,
    finalText: finalTexts.join("\n"),
    durationMs: elapsedMs(startedAt),
    sharedCapabilityBaseline: capabilityBaseline,
    capabilityRows,
    modelTurnCases,
    invariants,
    outboundRecords,
    deliveryRecords,
    modelTurnRecords
  };
}

function selectModelTurnCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("kova channel model-turn cases were not provided");
  }
  return cases.map((testCase, index) => {
    if (!testCase || typeof testCase !== "object" || Array.isArray(testCase)) {
      throw new Error(`kova channel model-turn case ${index} must be an object`);
    }
    if (typeof testCase.id !== "string" || testCase.id.length === 0) {
      throw new Error(`kova channel model-turn case ${index} must have an id`);
    }
    if (typeof testCase.prompt !== "string" || testCase.prompt.length === 0) {
      throw new Error(`kova channel model-turn case ${testCase.id} must have a prompt`);
    }
    if (!Array.isArray(testCase.capabilities) || testCase.capabilities.length === 0) {
      throw new Error(`kova channel model-turn case ${testCase.id} must declare capabilities`);
    }
    return testCase;
  });
}

async function runModelTurnCase(testCase) {
  const startedAt = performance.now();
  const beforeOutbound = outboundRecords.length;
  const beforeDelivery = deliveryRecords.length;
  const beforeRecords = modelTurnRecords.length;
  const inboundEventId = `kova-model-turn-${testCase.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const targetId = modelTurnTargetId(testCase.id);
  const botLoopProbe = testCase.expectNoSelfTrigger === true
    ? createSelfTriggerProbe(testCase.id, inboundEventId, targetId)
    : null;
  let turn = null;
  let selfTriggerTurn = null;
  let selfTriggerError = null;
  let error = null;

  try {
    for (const fixturePath of mediaFixturePaths(testCase)) {
      writeMediaFixture(fixturePath);
    }
    turn = await runOpenClawModelTurn({
      message: modelTurnPrompt(testCase, inboundEventId),
      inboundEventId,
      targetId,
      replyToId: testCase.replyToId === null ? null : inboundEventId,
      threadId: testCase.threadId,
      silent: testCase.silent === true,
      sourceReplyDeliveryMode: testCase.sourceReplyDeliveryMode,
      botLoopProtection: botLoopProbe?.firstTurnProtection
    });
    if (botLoopProbe) {
      const beforeSelfTriggerOutbound = outboundRecords.length;
      const beforeSelfTriggerDelivery = deliveryRecords.length;
      const beforeSelfTriggerRecords = modelTurnRecords.length;
      try {
        selfTriggerTurn = await runOpenClawModelTurn({
          message: selfTriggerProbeMessage(testCase, botLoopProbe),
          inboundEventId: botLoopProbe.inboundEventId,
          targetId,
          replyToId: botLoopProbe.inboundEventId,
          threadId: testCase.threadId,
          silent: false,
          sourceReplyDeliveryMode: testCase.sourceReplyDeliveryMode,
          from: botLoopProbe.senderId,
          senderId: botLoopProbe.senderId,
          senderName: "Kova Echo Bot",
          botLoopProtection: botLoopProbe.echoProtection
        });
      } catch (caught) {
        selfTriggerError = caught instanceof Error ? caught : new Error(String(caught));
      }
      botLoopProbe.outboundRecords = outboundRecords.slice(beforeSelfTriggerOutbound);
      botLoopProbe.deliveryRecords = deliveryRecords.slice(beforeSelfTriggerDelivery);
      botLoopProbe.modelTurnRecords = modelTurnRecords.slice(beforeSelfTriggerRecords);
    }
    await waitForAsyncWorkflowEvidence(testCase, beforeOutbound);
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  } finally {
    for (const fixturePath of mediaFixturePaths(testCase)) {
      removeMediaFixture(fixturePath);
    }
  }

  const caseOutboundRecords = outboundRecords.slice(beforeOutbound);
  const caseDeliveryRecords = deliveryRecords.slice(beforeDelivery);
  const caseModelTurnRecords = modelTurnRecords.slice(beforeRecords);
  const modelRecordStarts = caseModelTurnRecords.filter((record) => record.stage === "record" && record.event === "start");
  const modelRecordDones = caseModelTurnRecords.filter((record) => record.stage === "record" && record.event === "done");
  const modelDispatchStarts = caseModelTurnRecords.filter((record) => record.stage === "dispatch" && record.event === "start");
  const modelDispatchDones = caseModelTurnRecords.filter((record) => record.stage === "dispatch" && record.event === "done");
  const finalOutboundRecords = caseOutboundRecords.filter((record) => isFinalOutboundRecord(record));
  const finalDeliveryRecords = finalOutboundRecords;
  const finalTexts = finalDeliveryRecords
    .map((record) => record.text)
    .filter((text) => typeof text === "string" && text.length > 0);
  const matchedText = typeof testCase.expectedText === "string"
    ? (finalTexts.find((text) => textEquals(text, testCase.expectedText)) ?? null)
    : null;
  const visibleErrorText = testCase.expectErrorFinal === true
    ? (finalTexts.find((text) => text.trim().length > 0) ?? null)
    : null;
  const firstFinal = finalDeliveryRecords[0] ?? null;
  const finalDeliveryPolicy = normalizeFinalDeliveries(testCase.finalDeliveries);
  const mediaExpectation = mediaSourceExpectation(testCase);
  const selfTriggerDispatchStarts = botLoopProbe?.modelTurnRecords?.filter((record) => record.stage === "dispatch" && record.event === "start") ?? [];
  const selfTriggerDropped = selfTriggerTurn?.admission?.kind === "drop" &&
    selfTriggerTurn?.admission?.reason === "bot-loop-protection";
  const invariants = [
    invariant(`${testCase.id}:turn-dispatched`, !error && turn?.dispatched === true, `${testCase.id} dispatched through OpenClaw runtime`),
    successPlusExtraVisibleInvariant(testCase, finalDeliveryPolicy, finalOutboundRecords),
    finalDeliveryInvariant(testCase.id, finalDeliveryPolicy, finalDeliveryRecords.length),
    invariant(`${testCase.id}:expected-final-kind`, !testCase.expectedKind || firstFinal?.kind === testCase.expectedKind, `${testCase.id} used expected channel send kind`),
    invariant(`${testCase.id}:expected-final-text`, !testCase.expectedText || Boolean(matchedText), `${testCase.id} final channel send equals expected text`),
    invariant(`${testCase.id}:visible-error-final`, testCase.expectErrorFinal !== true || Boolean(visibleErrorText), `${testCase.id} delivered one non-empty user-visible error response`),
    invariant(`${testCase.id}:delivery-receipt`, finalDeliveryPolicy.expected === 0 || finalDeliveryPolicy.mode === "observe" || finalDeliveryRecords.some((record) => typeof record.messageId === "string" && record.messageId.length > 0), `${testCase.id} durable delivery recorded a channel receipt`),
    invariant(`${testCase.id}:single-final-send`, finalDeliveryRecords.length <= 1 || testCase.allowMultipleFinalSends === true, `${testCase.id} did not duplicate final channel sends`),
    invariant(`${testCase.id}:reply-to`, !testCase.expectReplyToId || firstFinal?.replyToId === inboundEventId, `${testCase.id} preserved reply target`),
    invariant(`${testCase.id}:no-reply-to`, testCase.expectNoReplyToId !== true || firstFinal?.replyToId == null, `${testCase.id} did not attach a reply target`),
    invariant(`${testCase.id}:thread`, !testCase.threadId || firstFinal?.threadId === testCase.threadId, `${testCase.id} preserved thread target`),
    invariant(`${testCase.id}:silent`, testCase.silent !== true || firstFinal?.silent === true, `${testCase.id} preserved silent delivery intent`),
    invariant(`${testCase.id}:media-url`, mediaExpectation.check(finalDeliveryRecords), mediaExpectation.summary),
    invariant(`${testCase.id}:unique-final-media`, !hasMediaExpectation(testCase) || hasUniqueFinalMedia(finalDeliveryRecords), `${testCase.id} did not deliver the same media item more than once`),
    invariant(`${testCase.id}:after-send-success`, testCase.expectHooks !== true || caseOutboundRecords.some((record) => record.kind === "after-send-success"), `${testCase.id} ran after-send-success hook`),
    invariant(`${testCase.id}:after-commit`, testCase.expectHooks !== true || caseOutboundRecords.some((record) => record.kind === "after-commit"), `${testCase.id} ran after-commit hook`),
    invariant(`${testCase.id}:single-inbound-turn`, modelDispatchStarts.length === 1, `${testCase.id} processed exactly one OpenClaw model turn for one inbound user event; observed ${modelDispatchStarts.length}`),
    invariant(`${testCase.id}:model-turn-record-terminal`, modelRecordStarts.length === modelRecordDones.length, `${testCase.id} closed every recorded OpenClaw model turn; starts ${modelRecordStarts.length}, done ${modelRecordDones.length}`),
    invariant(`${testCase.id}:model-turn-dispatch-terminal`, modelDispatchStarts.length === modelDispatchDones.length, `${testCase.id} closed every dispatched OpenClaw model turn; starts ${modelDispatchStarts.length}, done ${modelDispatchDones.length}`),
    invariant(`${testCase.id}:no-self-trigger`, testCase.expectNoSelfTrigger !== true || (!selfTriggerError && selfTriggerDropped && selfTriggerDispatchStarts.length === 0 && botLoopProbe.outboundRecords.length === 0 && botLoopProbe.deliveryRecords.length === 0), `${testCase.id} suppressed bot-authored echo without dispatch or visible delivery`),
    invariant(`${testCase.id}:terminal-return`, !error, `${testCase.id} returned from OpenClaw dispatch`)
  ];
  const ok = invariants.every((item) => item.status === "passed");

  return {
    id: testCase.id,
    status: ok ? "passed" : "failed",
    reason: ok ? null : (error?.message ?? invariants.find((item) => item.status !== "passed")?.reason ?? "model turn case failed"),
    capabilities: testCase.capabilities,
    workflow: testCase.workflow ?? null,
    inventoryWorkflow: testCase.inventoryWorkflow ?? null,
    matrix: compactMatrix(testCase.matrix),
    userAction: testCase.userAction ?? null,
    openclawSurface: testCase.openclawSurface ?? null,
    ownerArea: testCase.ownerArea ?? null,
    inboundEvent: {
      id: inboundEventId,
      authorId: "kova-baseline-user",
      sourceKind: "external-user",
      targetId,
      caseTargetId: targetId,
      message: testCase.prompt
    },
    selfTriggerProbe: botLoopProbe ? {
      inboundEvent: {
        id: botLoopProbe.inboundEventId,
        authorId: botLoopProbe.senderId,
        sourceKind: "bot-authored-echo",
        targetId,
        caseTargetId: targetId,
        message: botLoopProbe.message
      },
      admission: selfTriggerTurn?.admission ?? null,
      dispatched: selfTriggerTurn?.dispatched === true,
      error: selfTriggerError?.message ?? null,
      outboundRecords: botLoopProbe.outboundRecords,
      deliveryRecords: botLoopProbe.deliveryRecords,
      modelTurnRecords: botLoopProbe.modelTurnRecords
    } : null,
    routeSessionKey: turn?.routeSessionKey ?? null,
    dispatched: turn?.dispatched === true,
    finalDeliveries: finalDeliveryPolicy,
    providerRequests: normalizeProviderRequests(testCase.providerRequests),
    finalText: matchedText,
    expectedText: testCase.expectedText,
    durationMs: elapsedMs(startedAt),
    invariants,
    outboundRecords: caseOutboundRecords,
    deliveryRecords: caseDeliveryRecords,
    modelTurnRecords: caseModelTurnRecords
  };
}

function compactMatrix(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    content: typeof value.content === "string" ? value.content : null,
    route: typeof value.route === "string" ? value.route : null,
    delivery: typeof value.delivery === "string" ? value.delivery : null,
    lifecycle: typeof value.lifecycle === "string" ? value.lifecycle : null
  };
}

function modelTurnTargetId(caseId) {
  const safe = String(caseId ?? "case")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "case";
  return `dm:kova-baseline-user-${safe}`;
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
  botLoopProtection
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
        silent
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

function createSelfTriggerProbe(caseId, inboundEventId, targetId = TARGET_ID) {
  const senderId = "kova-baseline-echo-bot";
  const receiverId = TARGET_USER_ID;
  const scopeId = `kova-self-trigger:${caseId}:${inboundEventId}`;
  const conversationId = targetId;
  const config = {
    maxEventsPerWindow: 1,
    windowSeconds: 60,
    cooldownSeconds: 60
  };
  return {
    inboundEventId: `${inboundEventId}:bot-echo`,
    message: "KOVA_SELF_TRIGGER_ECHO",
    senderId,
    receiverId,
    firstTurnProtection: {
      scopeId,
      conversationId,
      senderId: receiverId,
      receiverId: senderId,
      config,
      defaultEnabled: true,
      nowMs: 1_000
    },
    echoProtection: {
      scopeId,
      conversationId,
      senderId,
      receiverId,
      config,
      defaultEnabled: true,
      nowMs: 1_001
    },
    outboundRecords: [],
    deliveryRecords: [],
    modelTurnRecords: []
  };
}

function selfTriggerProbeMessage(testCase, probe) {
  return [
    probe.message,
    `KOVA_MODEL_TURN_CASE:${testCase.id}.self-trigger-probe`,
    `KOVA_INBOUND_EVENT_ID:${probe.inboundEventId}`,
    "This bot-authored echo should be dropped by OpenClaw channel loop protection before any model call.",
    `KOVA_MOCK_RESPONSE_B64:${Buffer.from("KOVA_SELF_TRIGGER_UNEXPECTED", "utf8").toString("base64")}`
  ].join("\n");
}

function modelTurnPrompt(testCase, inboundEventId) {
  const lines = [
    testCase.prompt,
    `KOVA_MODEL_TURN_CASE:${testCase.id}`,
    `KOVA_INBOUND_EVENT_ID:${inboundEventId}`,
    "The Kova mock provider must return the scripted fixture below.",
    `KOVA_MOCK_RESPONSE_B64:${Buffer.from(testCase.responseText, "utf8").toString("base64")}`
  ];
  if (Number.isInteger(testCase.providerErrorStatus)) {
    lines.push(`KOVA_MOCK_PROVIDER_ERROR_STATUS:${testCase.providerErrorStatus}`);
  }
  if (testCase.toolCall) {
    lines.push(
      `KOVA_MOCK_TOOL_CALL_B64:${Buffer.from(JSON.stringify(testCase.toolCall), "utf8").toString("base64")}`
    );
  }
  return lines.join("\n");
}

function normalizeProviderRequests(value) {
  if (value?.mode === "exact" && Number.isInteger(value.expected) && value.expected >= 0) {
    return { mode: "exact", expected: value.expected };
  }
  if ((value?.mode === "minimum" || value?.mode === "min") && Number.isInteger(value.min) && value.min >= 0) {
    return { mode: "minimum", min: value.min };
  }
  return { mode: "observe" };
}

function normalizeFinalDeliveries(value) {
  if (value?.mode === "exact" && Number.isInteger(value.expected) && value.expected >= 0) {
    return { mode: "exact", expected: value.expected };
  }
  if ((value?.mode === "minimum" || value?.mode === "min") && Number.isInteger(value.min) && value.min >= 0) {
    return { mode: "minimum", min: value.min };
  }
  return { mode: "observe" };
}

function finalDeliveryInvariant(caseId, policy, observed) {
  if (policy.mode === "exact") {
    return invariant(
      `${caseId}:final-delivery-count`,
      observed === policy.expected,
      `${caseId} produced exactly ${policy.expected} final channel deliver${policy.expected === 1 ? "y" : "ies"}; observed ${observed}`
    );
  }
  if (policy.mode === "minimum") {
    return invariant(
      `${caseId}:final-delivery-count`,
      observed >= policy.min,
      `${caseId} produced at least ${policy.min} final channel deliver${policy.min === 1 ? "y" : "ies"}; observed ${observed}`
    );
  }
  return invariant(
    `${caseId}:final-delivery-count-observed`,
    true,
    `${caseId} final channel delivery count observed without gating; observed ${observed}`
  );
}

function successPlusExtraVisibleInvariant(testCase, finalDeliveryPolicy, finalOutboundRecords) {
  if (testCase.expectNoExtraVisibleFinal !== true || finalDeliveryPolicy.mode !== "exact") {
    return invariant(
      `${testCase.id}:no-success-plus-extra-visible-observed`,
      true,
      `${testCase.id} does not declare extra visible final gating`
    );
  }
  const hasExpectedSuccess = finalOutboundRecords.some((record) => outboundMatchesExpected(record, testCase));
  const hasExtraVisibleFinal = finalOutboundRecords.length > finalDeliveryPolicy.expected;
  return invariant(
    `${testCase.id}:no-success-plus-extra-visible`,
    !(hasExpectedSuccess && hasExtraVisibleFinal),
    `${testCase.id} did not deliver the expected success plus an extra visible final response`
  );
}

function outboundMatchesExpected(record, testCase) {
  if (!record || !isFinalOutboundRecord(record)) {
    return false;
  }
  if (testCase.expectedKind && record.kind !== testCase.expectedKind) {
    return false;
  }
  if (testCase.expectedText && !textEquals(record.text ?? "", testCase.expectedText)) {
    return false;
  }
  if (hasMediaExpectation(testCase)) {
    return mediaSourceExpectation(testCase).matchesRecord(record);
  }
  return true;
}

function isFinalOutboundRecord(record) {
  return ["text", "media", "payload"].includes(record?.kind);
}

function isManagedOutboundMedia(mediaUrl, sourcePath) {
  if (typeof mediaUrl !== "string" || mediaUrl.length === 0) {
    return false;
  }
  const normalizedMediaUrl = mediaUrl.replaceAll("\\", "/");
  if (!normalizedMediaUrl.includes("/.openclaw/media/outbound/")) {
    return false;
  }
  if (!existsSync(mediaUrl)) {
    return false;
  }
  const sourceName = sourcePath.replaceAll("\\", "/").split("/").pop();
  const outboundName = normalizedMediaUrl.split("/").pop();
  if (!sourceName || !outboundName) {
    return false;
  }
  const dotIndex = sourceName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return outboundName === sourceName || outboundName.startsWith(`${sourceName}---`);
  }
  const stem = sourceName.slice(0, dotIndex);
  const extension = sourceName.slice(dotIndex);
  return outboundName === sourceName || (outboundName.startsWith(`${stem}---`) && outboundName.endsWith(extension));
}

function mediaSourceExpectation(testCase) {
  const sourcePaths = expectedMediaSources(testCase);
  const sourcePath = sourcePaths[0] ?? null;
  if (!sourcePath && testCase.expectedMediaSourcePolicy === "present-existing") {
    return {
      summary: `${testCase.id} delivered generated media to the channel send path`,
      check: (records) => asRecordArray(records).some((record) => hasPresentMedia(record)),
      matchesRecord: (record) => hasPresentMedia(record)
    };
  }
  if (!sourcePath) {
    return {
      summary: `${testCase.id} has no local media expectation`,
      check: () => true,
      matchesRecord: () => true
    };
  }
  if (testCase.expectedMediaSourcePolicy === "sendable-local-or-managed") {
    return {
      summary: `${testCase.id} provided deliverable local media to the channel send path`,
      check: (records) => sourcePaths.every((expectedSource) =>
        asRecordArray(records).some((record) =>
          isManagedOutboundMedia(record?.mediaUrl, expectedSource) || isSameExistingLocalMedia(record, expectedSource)
        )
      ),
      matchesRecord: (record) => sourcePaths.some((expectedSource) =>
        isManagedOutboundMedia(record?.mediaUrl, expectedSource) || isSameExistingLocalMedia(record, expectedSource)
      )
    };
  }
  return {
    summary: sourcePaths.length === 1
      ? `${testCase.id} staged local media for outbound delivery`
      : `${testCase.id} staged every local media item for outbound delivery`,
    check: (records) => sourcePaths.every((expectedSource) =>
      asRecordArray(records).some((record) => isManagedOutboundMedia(record?.mediaUrl, expectedSource))
    ),
    matchesRecord: (record) => sourcePaths.some((expectedSource) =>
      isManagedOutboundMedia(record?.mediaUrl, expectedSource)
    )
  };
}

function hasMediaExpectation(testCase) {
  return expectedMediaSources(testCase).length > 0 ||
    testCase.expectedMediaSourcePolicy === "present-existing";
}

function hasUniqueFinalMedia(records) {
  const seen = new Set();
  for (const record of asRecordArray(records)) {
    if (record?.kind !== "media" || typeof record.mediaUrl !== "string" || record.mediaUrl.length === 0) {
      continue;
    }
    if (seen.has(record.mediaUrl)) {
      return false;
    }
    seen.add(record.mediaUrl);
  }
  return true;
}

function expectedMediaSources(testCase) {
  const sources = [];
  if (typeof testCase.expectedLocalMediaSource === "string" && testCase.expectedLocalMediaSource.length > 0) {
    sources.push(testCase.expectedLocalMediaSource);
  }
  if (Array.isArray(testCase.expectedLocalMediaSources)) {
    for (const source of testCase.expectedLocalMediaSources) {
      if (typeof source === "string" && source.length > 0 && !sources.includes(source)) {
        sources.push(source);
      }
    }
  }
  return sources;
}

function asRecordArray(records) {
  return Array.isArray(records) ? records : [records].filter(Boolean);
}

function isSameExistingLocalMedia(record, sourcePath) {
  return record?.mediaUrl === sourcePath && record.mediaPathExists === true;
}

function writeMediaFixture(path) {
  writeFileSync(path, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  ));
}

function mediaFixturePaths(testCase) {
  const paths = [];
  if (typeof testCase.mediaFixturePath === "string" && testCase.mediaFixturePath.length > 0) {
    paths.push(testCase.mediaFixturePath);
  }
  if (Array.isArray(testCase.mediaFixturePaths)) {
    for (const fixturePath of testCase.mediaFixturePaths) {
      if (typeof fixturePath === "string" && fixturePath.length > 0 && !paths.includes(fixturePath)) {
        paths.push(fixturePath);
      }
    }
  }
  return paths;
}

function removeMediaFixture(path) {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup for a short-lived test fixture.
  }
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

async function waitForAsyncWorkflowEvidence(testCase, beforeOutbound) {
  if (!requiresAsyncWorkflowWait(testCase)) {
    return;
  }
  const timeoutMs = Number.isInteger(testCase.asyncCompletionTimeoutMs)
    ? testCase.asyncCompletionTimeoutMs
    : 15000;
  const finalDeliveryPolicy = normalizeFinalDeliveries(testCase.finalDeliveries);
  const mediaExpectation = mediaSourceExpectation(testCase);
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const finalRecords = outboundRecords
      .slice(beforeOutbound)
      .filter((record) => isFinalOutboundRecord(record));
    const hasExpectedCount = finalDeliveryPolicy.mode === "exact"
      ? finalRecords.length >= finalDeliveryPolicy.expected
      : finalDeliveryPolicy.mode === "minimum"
        ? finalRecords.length >= finalDeliveryPolicy.min
        : finalRecords.length > 0;
    const hasExpectedMedia = testCase.expectedKind !== "media" || finalRecords.some((record) => mediaExpectation.check(record));
    if (hasExpectedCount && hasExpectedMedia) {
      return;
    }
    await sleep(100);
  }
}

function requiresAsyncWorkflowWait(testCase) {
  const matrix = testCase.matrix ?? {};
  return matrix.lifecycle === "async-completion" ||
    matrix.delivery === "background-completion" ||
    matrix.delivery === "completion-handoff";
}

function hasPresentMedia(record) {
  if (!record || typeof record.mediaUrl !== "string" || record.mediaUrl.length === 0) {
    return false;
  }
  if (/^https?:\/\//i.test(record.mediaUrl)) {
    return true;
  }
  return existsSync(record.mediaUrl);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordOutbound(kind, ctx) {
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
