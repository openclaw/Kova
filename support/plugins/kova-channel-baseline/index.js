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
      async ({ respond }) => {
        try {
          const result = await runBaseline();
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

async function runBaseline() {
  if (!activeRuntime?.channelRuntime) {
    throw new Error("kova channel baseline runtime is not started");
  }
  outboundRecords = [];
  deliveryRecords = [];

  const proofs = [];
  for (const scenario of baselineScenarios) {
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
    proofCount: proofs.length,
    proofs,
    outboundRecords,
    deliveryRecords
  };
}

async function runModelTurn(params = {}) {
  if (!activeRuntime?.channelRuntime) {
    throw new Error("kova channel baseline runtime is not started");
  }
  const message = typeof params.message === "string" && params.message.length > 0
    ? params.message
    : "Reply with exact ASCII text KOVA_AGENT_OK only.";
  const expectedText = typeof params.expectedText === "string" && params.expectedText.length > 0
    ? params.expectedText
    : "KOVA_AGENT_OK";

  outboundRecords = [];
  deliveryRecords = [];
  modelTurnRecords = [];

  const startedAt = performance.now();
  const inboundEventId = `kova-model-turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const turn = await runOpenClawModelTurn({
    message,
    inboundEventId,
    replyToId: inboundEventId
  });
  const finalOutboundRecords = outboundRecords.filter((record) =>
    ["text", "media", "payload"].includes(record.kind)
  );
  const finalTexts = finalOutboundRecords
    .map((record) => record.text)
    .filter((text) => typeof text === "string" && text.length > 0);
  const matchedText = finalTexts.find((text) => text.includes(expectedText)) ?? null;
  const invariants = [
    invariant("turn-dispatched", turn?.dispatched === true, "channel model turn dispatched through OpenClaw runtime"),
    invariant("expected-final-text", Boolean(matchedText), `final channel send contains ${expectedText}`),
    invariant("single-final-send", finalOutboundRecords.length === 1, "one inbound event produced exactly one final channel send"),
    invariant("delivery-receipt", deliveryRecords.some((record) => record.fallback === false), "durable delivery recorded a channel receipt"),
    invariant("terminal-return", true, "channel model turn returned from OpenClaw dispatch")
  ];
  const ok = invariants.every((item) => item.status === "passed");

  return {
    ok,
    schemaVersion: "kova.channelModelTurnBaselinePluginRun.v1",
    channelId: CHANNEL_ID,
    accountId: activeRuntime.accountId,
    inboundEvent: {
      id: inboundEventId,
      authorId: "kova-baseline-user",
      sourceKind: "external-user",
      targetId: TARGET_ID,
      message
    },
    routeSessionKey: turn?.routeSessionKey ?? null,
    dispatched: turn?.dispatched === true,
    finalText: matchedText,
    expectedText,
    durationMs: elapsedMs(startedAt),
    invariants,
    outboundRecords,
    deliveryRecords,
    modelTurnRecords
  };
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
  replyToId
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
        replyToId
      },
      deliver: async (delivered) => {
        deliveryRecords.push({ fallback: true, payload: delivered });
      },
      onDelivered: async (delivered, info, result) => {
        deliveryRecords.push({
          fallback: false,
          kind: info?.kind ?? null,
          text: delivered?.text ?? null,
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
