import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
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

let activeRuntime = null;
let outboundRecords = [];
let deliveryRecords = [];
let modelTurnRecords = [];

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

export default definePluginEntry({
  id: "kova-channel-baseline",
  name: "Kova Channel Baseline",
  description: "OpenClaw channel capability baseline fixture used by Kova.",
  register(api) {
    api.registerChannel(plugin);
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
  }
});

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
  const selectedCases = selectModelTurnCases(params.case ?? params.caseId);
  const expectedText = typeof params.expectedText === "string" && params.expectedText.length > 0
    ? params.expectedText
    : (selectedCases.length === 1 ? selectedCases[0].expectedText : "KOVA_AGENT_OK");
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
  const matchedText = finalTexts.find((text) => textEquals(text, expectedText)) ?? null;
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
      reason: testCase.reason
    })))
  ];
  const invariants = [
    ...(includeSharedBaseline
      ? [invariant("shared-capability-baseline", capabilityBaseline.ok === true, "all shared OpenClaw channel capabilities passed before model-turn proof")]
      : []),
    invariant("model-turn-case-count", modelTurnCases.length === selectedCases.length, "all requested channel model-turn cases ran"),
    invariant("model-turn-cases-passed", failedCases.length === 0, "all channel model-turn cases passed"),
    invariant("expected-final-text", Boolean(matchedText), `at least one model-turn final channel send equals ${expectedText}`),
    invariant("terminal-return", modelTurnCases.every((testCase) => testCase.dispatched === true), "all channel model turns returned from OpenClaw dispatch")
  ];
  const ok = invariants.every((item) => item.status === "passed");

  return {
    ok,
    schemaVersion: "kova.channelModelTurnBaselinePluginRun.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
    requestedCase: params.case ?? params.caseId ?? null,
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

function selectModelTurnCases(requestedCase) {
  if (requestedCase == null || requestedCase === "" || requestedCase === "all") {
    return modelTurnCaseDefinitions;
  }
  const cases = new Set(String(requestedCase).split(",").map((item) => item.trim()).filter(Boolean));
  const selected = modelTurnCaseDefinitions.filter((testCase) => cases.has(testCase.id));
  if (selected.length !== cases.size) {
    const known = new Set(modelTurnCaseDefinitions.map((testCase) => testCase.id));
    const unknown = [...cases].filter((id) => !known.has(id));
    throw new Error(`unknown channel model-turn case${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return selected;
}

async function runModelTurnCase(testCase) {
  const startedAt = performance.now();
  const beforeOutbound = outboundRecords.length;
  const beforeDelivery = deliveryRecords.length;
  const beforeRecords = modelTurnRecords.length;
  const inboundEventId = `kova-model-turn-${testCase.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let turn = null;
  let error = null;

  try {
    if (testCase.mediaFixturePath) {
      writeMediaFixture(testCase.mediaFixturePath);
    }
    turn = await runOpenClawModelTurn({
      message: modelTurnPrompt(testCase, inboundEventId),
      inboundEventId,
      replyToId: testCase.replyToId === null ? null : inboundEventId,
      threadId: testCase.threadId,
      silent: testCase.silent === true
    });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  } finally {
    if (testCase.mediaFixturePath) {
      removeMediaFixture(testCase.mediaFixturePath);
    }
  }

  const caseOutboundRecords = outboundRecords.slice(beforeOutbound);
  const caseDeliveryRecords = deliveryRecords.slice(beforeDelivery);
  const caseModelTurnRecords = modelTurnRecords.slice(beforeRecords);
  const finalOutboundRecords = caseOutboundRecords.filter((record) => isFinalOutboundRecord(record));
  const finalDeliveryRecords = finalOutboundRecords.length > 0
    ? finalOutboundRecords
    : normalizeFinalDeliveryRecords(caseDeliveryRecords);
  const finalTexts = finalDeliveryRecords
    .map((record) => record.text)
    .filter((text) => typeof text === "string" && text.length > 0);
  const matchedText = typeof testCase.expectedText === "string"
    ? (finalTexts.find((text) => textEquals(text, testCase.expectedText)) ?? null)
    : null;
  const firstFinal = finalDeliveryRecords[0] ?? null;
  const finalDeliveryPolicy = normalizeFinalDeliveries(testCase.finalDeliveries);
  const invariants = [
    invariant(`${testCase.id}:turn-dispatched`, !error && turn?.dispatched === true, `${testCase.id} dispatched through OpenClaw runtime`),
    finalDeliveryInvariant(testCase.id, finalDeliveryPolicy, finalDeliveryRecords.length),
    invariant(`${testCase.id}:expected-final-kind`, !testCase.expectedKind || firstFinal?.kind === testCase.expectedKind, `${testCase.id} used expected channel send kind`),
    invariant(`${testCase.id}:expected-final-text`, !testCase.expectedText || Boolean(matchedText), `${testCase.id} final channel send equals expected text`),
    invariant(`${testCase.id}:delivery-receipt`, finalDeliveryPolicy.expected === 0 || finalDeliveryPolicy.mode === "observe" || caseDeliveryRecords.some((record) => record.fallback === false), `${testCase.id} durable delivery recorded a channel receipt`),
    invariant(`${testCase.id}:single-final-send`, finalDeliveryRecords.length <= 1 || testCase.allowMultipleFinalSends === true, `${testCase.id} did not duplicate final channel sends`),
    invariant(`${testCase.id}:reply-to`, !testCase.expectReplyToId || firstFinal?.replyToId === inboundEventId, `${testCase.id} preserved reply target`),
    invariant(`${testCase.id}:thread`, !testCase.threadId || firstFinal?.threadId === testCase.threadId, `${testCase.id} preserved thread target`),
    invariant(`${testCase.id}:silent`, testCase.silent !== true || firstFinal?.silent === true, `${testCase.id} preserved silent delivery intent`),
    invariant(`${testCase.id}:media-url`, !testCase.expectedLocalMediaSource || isManagedOutboundMedia(firstFinal?.mediaUrl, testCase.expectedLocalMediaSource), `${testCase.id} staged local media for outbound delivery`),
    invariant(`${testCase.id}:after-send-success`, testCase.expectHooks !== true || caseOutboundRecords.some((record) => record.kind === "after-send-success"), `${testCase.id} ran after-send-success hook`),
    invariant(`${testCase.id}:after-commit`, testCase.expectHooks !== true || caseOutboundRecords.some((record) => record.kind === "after-commit"), `${testCase.id} ran after-commit hook`),
    invariant(`${testCase.id}:terminal-return`, !error, `${testCase.id} returned from OpenClaw dispatch`)
  ];
  const ok = invariants.every((item) => item.status === "passed");

  return {
    id: testCase.id,
    status: ok ? "passed" : "failed",
    reason: ok ? null : (error?.message ?? invariants.find((item) => item.status !== "passed")?.reason ?? "model turn case failed"),
    capabilities: testCase.capabilities,
    inboundEvent: {
      id: inboundEventId,
      authorId: "kova-baseline-user",
      sourceKind: "external-user",
      targetId: TARGET_ID,
      message: testCase.prompt
    },
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

const modelTurnCaseDefinitions = [
  {
    id: "text-final",
    prompt: "Return the exact text response for the text final channel capability.",
    responseText: "KOVA_AGENT_OK",
    expectedText: "KOVA_AGENT_OK",
    expectedKind: "text",
    finalDeliveries: { mode: "exact", expected: 1 },
    providerRequests: { mode: "exact", expected: 1 },
    expectReplyToId: true,
    expectHooks: true,
    capabilities: [
      { group: "durable-final", id: "text" },
      { group: "durable-final", id: "reply-to" },
      { group: "durable-final", id: "message-sending-hooks" },
      { group: "durable-final", id: "after-send-success" },
      { group: "durable-final", id: "after-commit" },
      { group: "ack", id: "after-agent-dispatch" },
      { group: "ack", id: "after-durable-send" }
    ]
  },
  {
    id: "media-final",
    prompt: "Return a final answer with a media directive and caption.",
    responseText: "MEDIA:/tmp/kova-channel-model-turn-media.png\nKOVA_AGENT_MEDIA_OK",
    expectedText: "KOVA_AGENT_MEDIA_OK",
    expectedKind: "media",
    expectedLocalMediaSource: "/tmp/kova-channel-model-turn-media.png",
    mediaFixturePath: "/tmp/kova-channel-model-turn-media.png",
    finalDeliveries: { mode: "exact", expected: 1 },
    providerRequests: { mode: "exact", expected: 1 },
    expectReplyToId: true,
    capabilities: [
      { group: "durable-final", id: "media" }
    ]
  },
  {
    id: "thread-final",
    prompt: "Return text that must stay in the inbound thread.",
    responseText: "KOVA_AGENT_THREAD_OK",
    expectedText: "KOVA_AGENT_THREAD_OK",
    expectedKind: "text",
    finalDeliveries: { mode: "exact", expected: 1 },
    providerRequests: { mode: "exact", expected: 1 },
    threadId: "kova-model-turn-thread",
    capabilities: [
      { group: "durable-final", id: "thread" }
    ]
  },
  {
    id: "silent-final",
    prompt: "Return text while the channel runtime marks the durable send as silent.",
    responseText: "KOVA_AGENT_SILENT_OK",
    expectedText: "KOVA_AGENT_SILENT_OK",
    expectedKind: "text",
    finalDeliveries: { mode: "exact", expected: 1 },
    providerRequests: { mode: "exact", expected: 1 },
    silent: true,
    capabilities: [
      { group: "durable-final", id: "silent" }
    ]
  }
];

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
  ackScenario("manual", "manual", null)
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
        deliveryRecords.push({ fallback: true, payload: delivered });
      },
      onDelivered: async (delivered, info, result) => {
        deliveryRecords.push({
          fallback: false,
          kind: info?.kind ?? null,
          text: delivered?.text ?? null,
          mediaUrl: delivered?.mediaUrl ?? delivered?.mediaUrls?.[0] ?? null,
          mediaUrls: Array.isArray(delivered?.mediaUrls) ? delivered.mediaUrls : [],
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
  replyToId,
  threadId,
  silent
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
    Body: message,
    BodyForAgent: message,
    RawBody: message,
    CommandBody: message,
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
        deliveryRecords.push({ fallback: true, payload: delivered });
      },
      onDelivered: async (delivered, info, result) => {
        deliveryRecords.push({
          fallback: false,
          kind: info?.kind ?? null,
          text: delivered?.text ?? null,
          mediaUrl: delivered?.mediaUrl ?? delivered?.mediaUrls?.[0] ?? null,
          mediaUrls: Array.isArray(delivered?.mediaUrls) ? delivered.mediaUrls : [],
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

function modelTurnPrompt(testCase, inboundEventId) {
  return [
    testCase.prompt,
    `KOVA_MODEL_TURN_CASE:${testCase.id}`,
    `KOVA_INBOUND_EVENT_ID:${inboundEventId}`,
    "The Kova mock provider must return the scripted fixture below.",
    `KOVA_MOCK_RESPONSE_B64:${Buffer.from(testCase.responseText, "utf8").toString("base64")}`
  ].join("\n");
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

function isFinalOutboundRecord(record) {
  return ["text", "media", "payload"].includes(record?.kind);
}

function normalizeFinalDeliveryRecords(records) {
  if (!Array.isArray(records)) {
    return [];
  }
  return records
    .filter((record) => record?.fallback === false)
    .map((record) => ({
      kind: deliveryRecordKind(record),
      text: record.text ?? null,
      mediaUrl: record.mediaUrl ?? record.mediaUrls?.[0] ?? null,
      mediaUrls: Array.isArray(record.mediaUrls) ? record.mediaUrls : [],
      silent: record.silent === true,
      threadId: record.threadId ?? null,
      replyToId: record.replyToId ?? null,
      messageIds: record.messageIds ?? null,
      visibleReplySent: record.visibleReplySent ?? null
    }))
    .filter((record) => isFinalOutboundRecord(record));
}

function deliveryRecordKind(record) {
  if (typeof record?.mediaUrl === "string" && record.mediaUrl.length > 0) {
    return "media";
  }
  if (Array.isArray(record?.mediaUrls) && record.mediaUrls.some((url) => typeof url === "string" && url.length > 0)) {
    return "media";
  }
  return record?.kind === "payload" ? "payload" : "text";
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

function writeMediaFixture(path) {
  writeFileSync(path, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  ));
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
    payload: ctx.payload ?? null,
    silent: ctx.silent ?? false,
    threadId: ctx.threadId ?? null,
    replyToId: ctx.replyToId ?? null
  });
  return { messageId, receipt };
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
