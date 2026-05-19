#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs
} from "./openclaw-runtime.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseSupportArgs(process.argv.slice(2));
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
const artifactPath = join(artifactDir, "channel-capability-baseline.json");
const catalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "openclaw-message.json"), "utf8"));

async function main() {
  let result;
  try {
    const runtimeContext = await resolveRuntimeContext(args);
    const baseline = await runOpenClawChannelCapabilityBaseline({
      catalog,
      packageRoot: runtimeContext.packageRoot
    });
    result = buildResult({
      catalog,
      runtimeContext,
      baseline,
      error: null,
      timeoutMs
    });
  } catch (error) {
    result = buildResult({
      catalog,
      runtimeContext: null,
      baseline: null,
      error,
      timeoutMs
    });
  }

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "kova.channelCapabilityRun.v1",
    proofMode: "baseline",
    artifactPath,
    ownerArea: "OpenClaw",
    capabilities: result.rows.map((row) => ({
      ...row,
      artifactPath
    }))
  }, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

async function resolveRuntimeContext(parsed) {
  if (parsed["package-root"]) {
    return {
      source: "package-root",
      packageRoot: resolve(parsed["package-root"]),
      runtime: null
    };
  }

  const envName = requiredArg(parsed, "env");
  const context = prepareOpenClawRuntimeFromOcmEnv(envName);
  return {
    source: "ocm-env",
    envName: context.envName,
    root: context.root,
    gatewayPort: context.gatewayPort,
    binaryPath: context.binaryPath,
    packageRoot: context.packageRoot,
    runtime: context.runtime
  };
}

async function runOpenClawChannelCapabilityBaseline({ catalog: catalogValue, packageRoot }) {
  const channelMessage = await importOpenClawChannelMessage(packageRoot);
  const exportPath = await resolvePackageExportPath(packageRoot, "./plugin-sdk/channel-message");
  const proofs = [];

  for (const capability of catalogValue.capabilities ?? []) {
    const key = `${capability.group}:${capability.id}`;
    const proof = baselineProofs[key];
    const startedAt = performance.now();
    if (!proof) {
      proofs.push({
        group: capability.group,
        capabilityId: capability.id,
        status: "missing",
        reason: `no OpenClaw behavioral baseline proof implemented for ${key}`,
        durationMs: elapsedMs(startedAt)
      });
      continue;
    }

    try {
      const evidence = await proof(channelMessage, capability);
      proofs.push({
        group: capability.group,
        capabilityId: capability.id,
        status: "passed",
        reason: null,
        durationMs: elapsedMs(startedAt),
        evidence
      });
    } catch (error) {
      proofs.push({
        group: capability.group,
        capabilityId: capability.id,
        status: "failed",
        reason: error.message,
        durationMs: elapsedMs(startedAt)
      });
    }
  }

  return {
    packageRoot,
    exportPath,
    proofs
  };
}

async function importOpenClawChannelMessage(packageRoot) {
  const exportPath = await resolvePackageExportPath(packageRoot, "./plugin-sdk/channel-message");
  const mod = await import(pathToFileURL(exportPath).href);
  const requiredExports = [
    "classifyDurableSendRecoveryState",
    "createChannelMessageAdapterFromOutbound",
    "createDurableMessageStateRecord",
    "createLiveMessageState",
    "createMessageReceiveContext",
    "createPreviewMessageReceipt",
    "defineChannelMessageAdapter",
    "defineFinalizableLivePreviewAdapter",
    "deriveDurableFinalDeliveryRequirements",
    "deliverFinalizableLivePreview",
    "deliverWithFinalizableLivePreviewAdapter",
    "markLiveMessagePreviewUpdated",
    "shouldAckMessageAfterStage",
    "withDurableMessageSendContext"
  ];
  const missing = requiredExports.filter((name) => typeof mod[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`openclaw/plugin-sdk/channel-message is missing exports: ${missing.join(", ")}`);
  }
  return mod;
}

async function resolvePackageExportPath(packageRoot, exportName) {
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const exportEntry = packageJson.exports?.[exportName];
  const relativePath = typeof exportEntry === "string"
    ? exportEntry
    : exportEntry?.default;
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error(`OpenClaw package does not export ${exportName}`);
  }
  return join(packageRoot, relativePath);
}

const baselineProofs = {
  "durable-final:text": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({ payload: { text: "hello" } });
    assert(requirements.text === true, "text delivery requirement was not derived");
    const rendered = await renderPayloads(mod, [{ text: "hello" }]);
    assert(rendered.plan.textCount === 1, "text payload was not rendered as text");
    const { result, calls } = await sendWithOutboundBridge(mod, "text", { text: "hello" });
    assert(calls[0]?.text === "hello", "text adapter context did not preserve text");
    assert(result.receipt?.parts?.[0]?.kind === "text", "text send did not produce a text receipt part");
    return { requirement: "text", renderedTextCount: rendered.plan.textCount, receiptKind: result.receipt.parts[0].kind };
  },

  "durable-final:media": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({
      payload: { text: "caption", mediaUrls: ["file:///tmp/kova-a.png", "file:///tmp/kova-b.png"] }
    });
    assert(requirements.media === true, "media delivery requirement was not derived");
    const rendered = await renderPayloads(mod, [{ text: "caption", mediaUrls: ["file:///tmp/kova-a.png"] }]);
    assert(rendered.plan.mediaCount === 1, "media payload was not rendered as media");
    const { result, calls } = await sendWithOutboundBridge(mod, "media", {
      text: "caption",
      mediaUrl: "file:///tmp/kova-a.png"
    });
    assert(calls[0]?.mediaUrl === "file:///tmp/kova-a.png", "media adapter context did not preserve mediaUrl");
    assert(result.receipt?.parts?.[0]?.kind === "media", "media send did not produce a media receipt part");
    return { requirement: "media", renderedMediaCount: rendered.plan.mediaCount, receiptKind: result.receipt.parts[0].kind };
  },

  "durable-final:payload": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({
      payload: { text: "card", presentation: { blocks: [{ type: "text", text: "card" }] } },
      payloadTransport: true
    });
    assert(requirements.payload === true, "payload transport requirement was not derived");
    const { result, calls } = await sendWithOutboundBridge(mod, "payload", {
      text: "",
      payload: { presentation: { blocks: [{ type: "text", text: "card" }] } }
    });
    assert(calls[0]?.payload?.presentation?.blocks?.length === 1, "payload adapter context lost presentation data");
    assert(result.receipt?.parts?.[0]?.kind === "card", "payload send did not produce a card receipt part");
    return { requirement: "payload", receiptKind: result.receipt.parts[0].kind };
  },

  "durable-final:silent": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({ payload: { text: "quiet" }, silent: true });
    assert(requirements.silent === true, "silent delivery requirement was not derived");
    const { calls } = await sendWithOutboundBridge(mod, "text", { text: "quiet", silent: true });
    assert(calls[0]?.silent === true, "adapter context did not preserve silent delivery intent");
    return { requirement: "silent", silent: calls[0].silent };
  },

  "durable-final:reply-to": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({
      payload: { text: "reply" },
      replyToId: "reply-1"
    });
    assert(requirements.replyTo === true, "reply-to delivery requirement was not derived");
    const { result, calls } = await sendWithOutboundBridge(mod, "text", { text: "reply", replyToId: "reply-1" });
    assert(calls[0]?.replyToId === "reply-1", "adapter context did not preserve replyToId");
    assert(result.receipt?.replyToId === "reply-1", "receipt did not preserve replyToId");
    return { requirement: "replyTo", replyToId: result.receipt.replyToId };
  },

  "durable-final:thread": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({
      payload: { text: "thread" },
      threadId: "thread-1"
    });
    assert(requirements.thread === true, "thread delivery requirement was not derived");
    const { result, calls } = await sendWithOutboundBridge(mod, "text", { text: "thread", threadId: "thread-1" });
    assert(calls[0]?.threadId === "thread-1", "adapter context did not preserve threadId");
    assert(result.receipt?.threadId === "thread-1", "receipt did not preserve threadId");
    return { requirement: "thread", threadId: result.receipt.threadId };
  },

  "durable-final:native-quote": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({
      payload: { text: "quote" },
      extraCapabilities: { nativeQuote: true }
    });
    assert(requirements.nativeQuote === true, "native quote capability was not derived from extras");
    const adapter = mod.createChannelMessageAdapterFromOutbound({
      id: "kova-baseline",
      capabilities: { nativeQuote: true },
      outbound: { sendText: async () => ({ messageId: "quote-1" }) }
    });
    assert(adapter.durableFinal?.capabilities?.nativeQuote === true, "adapter did not preserve nativeQuote capability metadata");
    return { requirement: "nativeQuote", adapterCapability: adapter.durableFinal.capabilities.nativeQuote };
  },

  "durable-final:message-sending-hooks": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({ payload: { text: "hooks" } });
    assert(requirements.messageSendingHooks === true, "message sending hooks requirement was not derived by default");
    const calls = [];
    await mod.withDurableMessageSendContext(
      {
        cfg: {},
        channel: "kova-baseline",
        to: "room-1",
        payloads: [{ text: "hooks" }],
        onPreviewUpdate: async (rendered, state) => {
          calls.push("preview");
          return mod.markLiveMessagePreviewUpdated(state, rendered);
        },
        onEditReceipt: async (receipt) => {
          calls.push("edit");
          return receipt;
        },
        onDeleteReceipt: async () => {
          calls.push("delete");
        },
        onSendFailure: async () => {
          calls.push("failure");
        }
      },
      async (ctx) => {
        const rendered = await ctx.render();
        const state = await ctx.previewUpdate(rendered);
        await ctx.edit(createReceipt("preview-hooks"), rendered);
        await ctx.delete(state.receipt ?? createReceipt("preview-hooks"));
        await ctx.fail(new Error("baseline hook failure"));
      }
    );
    for (const expected of ["preview", "edit", "delete", "failure"]) {
      assert(calls.includes(expected), `message send ${expected} hook did not run`);
    }
    return { requirement: "messageSendingHooks", hooks: calls };
  },

  "durable-final:batch": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({ payload: { text: "one" }, batch: true });
    assert(requirements.batch === true, "batch delivery requirement was not derived");
    const rendered = await renderPayloads(mod, [{ text: "one" }, { text: "two" }]);
    assert(rendered.plan.payloadCount === 2, "batch render did not preserve payload count");
    assert(rendered.plan.items?.[0]?.text === "one" && rendered.plan.items?.[1]?.text === "two", "batch render did not preserve order");
    return { requirement: "batch", payloadCount: rendered.plan.payloadCount };
  },

  "durable-final:reconcile-unknown-send": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({
      payload: { text: "unknown" },
      reconcileUnknownSend: true
    });
    assert(requirements.reconcileUnknownSend === true, "unknown-send reconciliation requirement was not derived");
    const state = mod.classifyDurableSendRecoveryState({
      hasIntent: true,
      hasReceipt: false,
      platformSendMayHaveStarted: true
    });
    assert(state === "unknown_after_send", "ambiguous durable send was not classified as unknown_after_send");
    const record = mod.createDurableMessageStateRecord({
      intent: { id: "intent-unknown", channel: "kova-baseline", to: "room-1", durability: "required" },
      state
    });
    assert(record.state === "unknown_after_send", "durable state record did not preserve unknown_after_send");
    return { requirement: "reconcileUnknownSend", recoveryState: record.state };
  },

  "durable-final:after-send-success": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({
      payload: { text: "success" },
      afterSendSuccess: true
    });
    assert(requirements.afterSendSuccess === true, "after-send-success requirement was not derived");
    const calls = [];
    const adapter = mod.defineChannelMessageAdapter({
      durableFinal: { capabilities: { afterSendSuccess: true } },
      send: {
        text: async () => ({ receipt: createReceipt("success-1") }),
        lifecycle: {
          afterSendSuccess: async ({ result }) => {
            calls.push(result.receipt.primaryPlatformMessageId);
          }
        }
      }
    });
    const result = await adapter.send.text({ text: "success" });
    await adapter.send.lifecycle.afterSendSuccess({ result });
    assert(calls[0] === "success-1", "after-send-success lifecycle hook did not observe send result");
    return { requirement: "afterSendSuccess", observedReceipt: calls[0] };
  },

  "durable-final:after-commit": async (mod) => {
    const requirements = mod.deriveDurableFinalDeliveryRequirements({
      payload: { text: "commit" },
      afterCommit: true
    });
    assert(requirements.afterCommit === true, "after-commit requirement was not derived");
    const calls = [];
    await mod.withDurableMessageSendContext(
      {
        cfg: {},
        channel: "kova-baseline",
        to: "room-1",
        payloads: [{ text: "commit" }],
        onCommitReceipt: async (receipt) => {
          calls.push(receipt.primaryPlatformMessageId);
        }
      },
      async (ctx) => {
        await ctx.commit(createReceipt("commit-1"));
      }
    );
    assert(calls[0] === "commit-1", "commit hook did not observe committed receipt");
    return { requirement: "afterCommit", committedReceipt: calls[0] };
  },

  "live-preview:draft-preview": async (mod) => {
    const rendered = await renderPayloads(mod, [{ text: "draft preview" }]);
    const state = mod.markLiveMessagePreviewUpdated(mod.createLiveMessageState(), rendered);
    assert(state.phase === "previewing", "draft preview did not enter previewing state");
    assert(state.lastRendered?.plan?.textCount === 1, "draft preview did not retain rendered payload");
    return { phase: state.phase, textCount: state.lastRendered.plan.textCount };
  },

  "live-preview:preview-finalization": async (mod) => {
    const result = await finalizePreview(mod, { previewId: "preview-final" });
    assert(result.kind === "preview-finalized", "preview finalization did not finalize in place");
    assert(result.liveState?.phase === "finalized", "live state was not finalized");
    return { resultKind: result.kind, phase: result.liveState.phase };
  },

  "live-preview:progress-updates": async (mod) => {
    const first = await renderPayloads(mod, [{ text: "step one" }]);
    const second = await renderPayloads(mod, [{ text: "step two" }]);
    const state = mod.markLiveMessagePreviewUpdated(
      mod.markLiveMessagePreviewUpdated(mod.createLiveMessageState(), first),
      second
    );
    assert(state.phase === "previewing", "progress updates did not stay in previewing state");
    assert(state.lastRendered?.payloads?.[0]?.text === "step two", "latest progress update was not retained");
    return { phase: state.phase, lastText: state.lastRendered.payloads[0].text };
  },

  "live-preview:native-streaming": async (mod) => {
    const adapter = mod.defineChannelMessageAdapter({
      live: { capabilities: { nativeStreaming: true } },
      send: {}
    });
    assert(adapter.live?.capabilities?.nativeStreaming === true, "native streaming capability metadata was not preserved");
    const result = await mod.deliverWithFinalizableLivePreviewAdapter({
      kind: "block",
      payload: { text: "streaming block" },
      adapter: mod.defineFinalizableLivePreviewAdapter({
        buildFinalEdit: () => ({ text: "streaming final" }),
        editFinal: async () => undefined
      }),
      deliverNormally: async () => true
    });
    assert(result.kind === "normal-delivered", "non-final streaming block did not route through live adapter delivery");
    return { adapterCapability: adapter.live.capabilities.nativeStreaming, resultKind: result.kind };
  },

  "live-preview:quiet-finalization": async (mod) => {
    let normalDeliveries = 0;
    const result = await finalizePreview(mod, {
      previewId: "quiet-final",
      deliverNormally: async () => {
        normalDeliveries += 1;
        return true;
      }
    });
    assert(result.kind === "preview-finalized", "quiet finalization did not finalize preview");
    assert(normalDeliveries === 0, "quiet finalization unexpectedly performed normal delivery");
    return { resultKind: result.kind, normalDeliveries };
  },

  "live-finalizer:final-edit": async (mod) => {
    const edits = [];
    const result = await finalizePreview(mod, {
      previewId: "final-edit",
      editFinal: async (id, edit) => {
        edits.push({ id, edit });
      }
    });
    assert(result.kind === "preview-finalized", "final edit did not finalize preview");
    assert(edits[0]?.id === "final-edit", "final edit did not target the preview id");
    return { resultKind: result.kind, editedId: edits[0].id };
  },

  "live-finalizer:normal-fallback": async (mod) => {
    let delivered = 0;
    const result = await finalizePreview(mod, {
      previewId: "normal-fallback",
      buildFinalEdit: () => undefined,
      deliverNormally: async () => {
        delivered += 1;
        return true;
      }
    });
    assert(result.kind === "normal-delivered", "normal fallback did not deliver normally");
    assert(delivered === 1, "normal fallback delivered an unexpected number of times");
    return { resultKind: result.kind, normalDeliveries: delivered };
  },

  "live-finalizer:discard-pending": async (mod) => {
    const calls = [];
    const result = await finalizePreview(mod, {
      previewId: "discard-pending",
      buildFinalEdit: () => undefined,
      draftOverrides: {
        discardPending: async () => {
          calls.push("discard");
        },
        clear: async () => {
          calls.push("clear");
        }
      }
    });
    assert(result.kind === "normal-delivered", "discard-pending fallback did not complete normal delivery");
    assert(calls.includes("discard"), "pending preview was not discarded before fallback");
    assert(calls.includes("clear"), "draft was not cleared after fallback delivery");
    return { resultKind: result.kind, draftCalls: calls };
  },

  "live-finalizer:preview-receipt": async (mod) => {
    const receipt = mod.createPreviewMessageReceipt({
      id: "preview-receipt",
      threadId: "thread-1",
      replyToId: "reply-1",
      sentAt: 123
    });
    assert(receipt.primaryPlatformMessageId === "preview-receipt", "preview receipt primary id was wrong");
    assert(receipt.parts?.[0]?.kind === "preview", "preview receipt did not include a preview part");
    assert(receipt.threadId === "thread-1" && receipt.replyToId === "reply-1", "preview receipt lost thread or reply target");
    return { receiptId: receipt.primaryPlatformMessageId, receiptKind: receipt.parts[0].kind };
  },

  "live-finalizer:retain-on-ambiguous-failure": async (mod) => {
    const result = await finalizePreview(mod, {
      previewId: "retain-preview",
      editFinal: async () => {
        throw new Error("ambiguous edit failure");
      },
      handlePreviewEditError: async () => "retain"
    });
    assert(result.kind === "preview-retained", "ambiguous preview edit failure was not retained");
    assert(result.liveState?.phase === "previewing", "retained preview did not stay previewing");
    return { resultKind: result.kind, phase: result.liveState.phase };
  },

  "ack:after-receive-record": async (mod) => proveAckPolicy(mod, "after_receive_record", "receive_record"),
  "ack:after-agent-dispatch": async (mod) => proveAckPolicy(mod, "after_agent_dispatch", "agent_dispatch"),
  "ack:after-durable-send": async (mod) => proveAckPolicy(mod, "after_durable_send", "durable_send"),
  "ack:manual": async (mod) => proveAckPolicy(mod, "manual", null)
};

async function renderPayloads(mod, payloads) {
  return await mod.withDurableMessageSendContext(
    {
      cfg: {},
      channel: "kova-baseline",
      to: "room-1",
      payloads
    },
    async (ctx) => await ctx.render()
  );
}

async function sendWithOutboundBridge(mod, kind, ctx) {
  const calls = [];
  const adapter = mod.createChannelMessageAdapterFromOutbound({
    id: "kova-baseline",
    outbound: {
      deliveryCapabilities: { durableFinal: { [kind === "payload" ? "payload" : kind]: true } },
      sendText: async (sendCtx) => {
        calls.push(sendCtx);
        return { messageId: "text-1" };
      },
      sendMedia: async (sendCtx) => {
        calls.push(sendCtx);
        return { messageId: "media-1" };
      },
      sendPayload: async (sendCtx) => {
        calls.push(sendCtx);
        return { messageId: "payload-1" };
      }
    }
  });

  const result = await adapter.send[kind](ctx);
  return { adapter, result, calls };
}

async function finalizePreview(mod, options = {}) {
  const draft = {
    flush: async () => undefined,
    id: () => options.previewId ?? "preview-1",
    seal: async () => undefined,
    clear: async () => undefined,
    discardPending: async () => undefined,
    ...(options.draftOverrides ?? {})
  };
  const liveState = mod.createLiveMessageState({
    receipt: createReceipt(options.previewId ?? "preview-1"),
    canFinalizeInPlace: true
  });
  return await mod.deliverFinalizableLivePreview({
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

async function proveAckPolicy(mod, policy, expectedStage) {
  const stages = ["receive_record", "agent_dispatch", "durable_send", "manual"];
  for (const stage of stages) {
    const expected = expectedStage === stage;
    assert(
      mod.shouldAckMessageAfterStage(policy, stage) === expected,
      `${policy} shouldAckMessageAfterStage(${stage}) did not match expected ${expected}`
    );
  }

  let ackCalls = 0;
  let nackMessage = null;
  const ctx = mod.createMessageReceiveContext({
    id: `msg-${policy}`,
    channel: "kova-baseline",
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

function buildResult({ catalog: catalogValue, runtimeContext, baseline, error, timeoutMs: commandTimeoutMs }) {
  const baselineError = error ? error.message : null;
  const proofByCapability = new Map((baseline?.proofs ?? []).map((proof) => [`${proof.group}:${proof.capabilityId}`, proof]));
  const rows = [];
  let ok = !baselineError;

  for (const capability of catalogValue.capabilities ?? []) {
    const proof = proofByCapability.get(`${capability.group}:${capability.id}`) ?? null;
    const status = baselineError ? "failed" : proof?.status ?? "missing";
    if (status !== "passed") {
      ok = false;
    }
    rows.push({
      channelId: "openclaw",
      group: capability.group,
      capabilityId: capability.id,
      required: true,
      status,
      proofMode: "baseline",
      summary: `OpenClaw behavioral baseline ${capability.group}/${capability.id}`,
      reason: status === "passed" ? null : (baselineError ?? proof?.reason ?? `OpenClaw baseline did not emit proof for ${capability.group}/${capability.id}`),
      ownerArea: "OpenClaw"
    });
  }

  return {
    ok,
    rows,
    artifact: {
      schemaVersion: "kova.channelCapabilityBaselineArtifact.v1",
      catalogId: catalogValue.id,
      catalogCapabilityCount: catalogValue.capabilities.length,
      runtimeContext: compactRuntimeContext(runtimeContext),
      timeoutMs: commandTimeoutMs,
      baseline: baseline ? {
        packageRoot: baseline.packageRoot,
        exportPath: baseline.exportPath,
        proofCount: baseline.proofs.length,
        passed: baseline.proofs.filter((proof) => proof.status === "passed").length,
        failed: baseline.proofs.filter((proof) => proof.status === "failed").length,
        missing: baseline.proofs.filter((proof) => proof.status === "missing").length
      } : null,
      error: baselineError,
      proofs: baseline?.proofs ?? [],
      capabilities: rows
    }
  };
}

function createReceipt(id) {
  return {
    primaryPlatformMessageId: id,
    platformMessageIds: [id],
    parts: [{ platformMessageId: id, kind: "text", index: 0 }],
    sentAt: 123
  };
}

function compactRuntimeContext(context) {
  if (!context) {
    return null;
  }
  return {
    source: context.source,
    envName: context.envName ?? null,
    packageRoot: context.packageRoot,
    runtime: context.runtime ?? null
  };
}

function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

await main();
