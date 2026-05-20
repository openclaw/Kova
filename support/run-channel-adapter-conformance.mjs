#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs
} from "./openclaw-runtime.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseSupportArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const channelId = args.channel ?? "telegram";
const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
const continueOnFailure = args["continue-on-failure"] === "true";
const artifactPath = join(artifactDir, `channel-adapter-conformance-${safeArtifactSegment(channelId)}.json`);
const openClawCatalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "openclaw-message.json"), "utf8"));
const workflowCatalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "channel-workflow-cases.json"), "utf8"));
const channelRegistry = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", `${channelId}.json`), "utf8"));

let result;
try {
  const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(envName);
  const adapterContext = await loadAdapterContext({ channelId, packageRoot: runtimeContext.packageRoot });
  result = await buildResult({
    runtimeContext,
    adapterContext,
    timeoutMs,
    error: null
  });
} catch (error) {
  result = await buildResult({
    runtimeContext: null,
    adapterContext: null,
    timeoutMs,
    error
  });
}

await mkdir(artifactDir, { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  schemaVersion: "kova.channelCapabilityRun.v1",
  proofMode: "deterministic-shim",
  artifactPath,
  ownerArea: `${channelId} adapter`,
  channelId,
  workflowCaseCatalogId: workflowCatalog.id,
  workflowCaseIds: channelRegistry.workflowCaseIds ?? [],
  capabilities: result.rows.map((row) => ({
    ...row,
    artifactPath
  }))
}, null, 2)}\n`);
process.exit(result.ok || continueOnFailure ? 0 : 1);

async function buildResult({ runtimeContext, adapterContext, timeoutMs: commandTimeoutMs, error }) {
  const runError = error ? error.message : null;
  const capabilityResults = runError || !adapterContext
    ? []
    : await runCapabilityProofs(adapterContext.adapter, channelRegistry);
  const workflowResults = runError || !adapterContext
    ? []
    : await runWorkflowProofs(adapterContext.adapter, channelRegistry, workflowCatalog);
  const rows = [
    ...capabilityRows(capabilityResults, runError),
    ...workflowRows(workflowResults, runError)
  ];
  const ok = !runError && rows.every((row) => row.status === "passed" || row.status === "skipped");

  return {
    ok,
    rows,
    artifact: {
      schemaVersion: "kova.channelAdapterConformanceArtifact.v1",
      channelId,
      adapterId: channelRegistry.adapterId,
      catalogId: openClawCatalog.id,
      workflowCaseCatalogId: workflowCatalog.id,
      runtimeContext: compactRuntimeContext(runtimeContext),
      adapterModulePath: adapterContext?.modulePath ?? null,
      timeoutMs: commandTimeoutMs,
      error: runError,
      capabilityResults,
      workflowResults,
      capabilities: rows
    }
  };
}

async function loadAdapterContext({ channelId: requestedChannelId, packageRoot }) {
  const distribution = channelRegistry.adapterDistribution;
  assert(distribution, `${requestedChannelId} channel registry does not declare adapterDistribution`);
  const modulePath = resolveAdapterModulePath({ distribution, packageRoot });
  const mod = await import(pathToFileURL(modulePath).href);
  const adapter = mod[distribution.exportName]?.message;
  if (!adapter) {
    throw new Error(`packaged ${requestedChannelId} plugin does not expose a message adapter`);
  }
  return { modulePath, adapter, distribution };
}

function resolveAdapterModulePath({ distribution, packageRoot }) {
  if (distribution.kind === "bundled") {
    return join(packageRoot, distribution.modulePath);
  }
  if (distribution.kind === "external") {
    const plugin = readInstalledPluginRecord(distribution.pluginId);
    const moduleBase = plugin.source ? dirname(plugin.source) : plugin.rootDir;
    return join(moduleBase, distribution.modulePath);
  }
  throw new Error(`unsupported adapter distribution kind '${distribution.kind}'`);
}

function readInstalledPluginRecord(pluginId) {
  const stateRoot = process.env.OPENCLAW_STATE_DIR || join(process.env.OPENCLAW_HOME || "", ".openclaw");
  const indexPath = join(stateRoot, "plugins", "installs.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    throw new Error(`installed plugin index is unavailable at ${indexPath}: ${error.message}`);
  }
  const plugin = (parsed.plugins ?? []).find((entry) => entry.pluginId === pluginId);
  if (!plugin?.rootDir) {
    throw new Error(`installed plugin '${pluginId}' is not present in ${indexPath}`);
  }
  return plugin;
}

async function runCapabilityProofs(adapter, channel) {
  const results = [];
  for (const capability of channel.capabilities ?? []) {
    results.push(await captureProof({
      id: `${capability.group}:${capability.id}`,
      group: capability.group,
      capabilityId: capability.id,
      run: () => proveCapability(adapter, capability)
    }));
  }
  return results;
}

async function proveCapability(adapter, capability) {
  if (capability.group === "durable-final") {
    assert(adapter.durableFinal?.capabilities?.[runtimeCapabilityKey(capability)] === true, `${capability.id} is not declared by adapter durable final capabilities`);
    return await proveDurableFinalCapability(adapter, capability.id);
  }
  if (capability.group === "ack") {
    const policy = runtimeCapabilityKey(capability);
    assert(adapter.receive?.supportedAckPolicies?.includes(policy), `${capability.id} is not declared by adapter receive policies`);
    if (policy === "after_agent_dispatch") {
      assert(adapter.receive?.defaultAckPolicy === "after_agent_dispatch", "after-agent-dispatch is not the adapter default ack policy");
    }
    return { observed: { supportedAckPolicies: adapter.receive.supportedAckPolicies, defaultAckPolicy: adapter.receive.defaultAckPolicy } };
  }
  if (capability.group === "live-preview") {
    const key = runtimeCapabilityKey(capability);
    assert(adapter.live?.capabilities?.[key] === true, `${capability.id} is not declared by adapter live capabilities`);
    return { observed: { liveCapabilities: adapter.live.capabilities } };
  }
  if (capability.group === "live-finalizer") {
    const key = runtimeCapabilityKey(capability);
    assert(adapter.live?.finalizer?.capabilities?.[key] === true, `${capability.id} is not declared by adapter live finalizer capabilities`);
    return { observed: { liveFinalizerCapabilities: adapter.live.finalizer.capabilities } };
  }
  return { skipped: true, reason: `no deterministic shim proof for ${capability.group}:${capability.id}` };
}

async function proveDurableFinalCapability(adapter, capabilityId) {
  if (capabilityId === "text") {
    return await runAdapterSend(adapter, { kind: "text", text: "KOVA_TELEGRAM_TEXT_OK" });
  }
  if (capabilityId === "media") {
    return await runAdapterSend(adapter, { kind: "media", text: "KOVA_TELEGRAM_MEDIA_OK", mediaUrl: "https://example.com/kova.png" });
  }
  if (capabilityId === "payload") {
    return await runAdapterSend(adapter, { kind: "payload", text: "KOVA_TELEGRAM_PAYLOAD_OK", payload: { text: "KOVA_TELEGRAM_PAYLOAD_OK" } });
  }
  if (capabilityId === "silent") {
    return await runAdapterSend(adapter, { kind: "text", text: "KOVA_TELEGRAM_SILENT_OK", silent: true });
  }
  if (capabilityId === "reply-to") {
    return await runAdapterSend(adapter, { kind: "text", text: "KOVA_TELEGRAM_REPLY_OK", replyToId: shimReplyToId() });
  }
  if (capabilityId === "thread") {
    return await runAdapterSend(adapter, { kind: "text", text: "KOVA_TELEGRAM_THREAD_OK", threadId: shimThreadId() });
  }
  if (capabilityId === "message-sending-hooks") {
    assert(typeof adapter.send?.text === "function", "adapter text send hook path is missing");
    return { observed: { sendText: true } };
  }
  if (capabilityId === "batch") {
    return await runAdapterSend(adapter, {
      kind: "payload",
      text: "KOVA_TELEGRAM_BATCH_OK",
      payload: {
        text: "KOVA_TELEGRAM_BATCH_OK",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"]
      },
      expectedPlatformSends: 2
    });
  }
  return { skipped: true, reason: `durable final shim proof for ${capabilityId} is not implemented` };
}

async function runWorkflowProofs(adapter, channel, catalog) {
  const cases = new Map((catalog.cases ?? []).map((testCase) => [testCase.id, testCase]));
  const results = [];
  for (const caseId of channel.workflowCaseIds ?? []) {
    const testCase = cases.get(caseId);
    results.push(await captureProof({
      id: caseId,
      group: "workflow",
      capabilityId: caseId,
      workflow: testCase?.workflow ?? null,
      userAction: testCase?.userAction ?? null,
      atoms: testCase?.atoms ?? [],
      run: () => runWorkflowCase(adapter, testCase)
    }));
  }
  return results;
}

async function runWorkflowCase(adapter, testCase) {
  assert(testCase, "workflow case declaration is missing");
  const expected = testCase.expects ?? {};
  const sendInput = {
    kind: expected.kind,
    text: expected.text,
    mediaUrl: expected.mediaSource,
    payload: expected.kind === "payload" ? { text: expected.text, mediaUrl: expected.mediaSource } : null,
    replyToId: expected.replyTo === "inbound-message" ? shimReplyToId() : null,
    threadId: expected.threadId ? shimThreadId() : null,
    silent: expected.silent === true,
    expectedPlatformSends: expected.visibleDeliveries ?? 1
  };
  const proof = await runAdapterSend(adapter, sendInput);
  const invariants = workflowInvariants(testCase, proof);
  const failed = invariants.find((item) => item.status !== "passed") ?? null;
  assert(!failed, failed?.reason ?? `${testCase.id} failed workflow invariant`);
  return { ...proof, invariants };
}

async function runAdapterSend(adapter, input) {
  const platformCalls = [];
  let sendIndex = 0;
  const sendPlatform = async (...call) => {
    platformCalls.push(call);
    sendIndex += 1;
    return {
      messageId: `tg-${sendIndex}`,
      chatId: shimConversationId()
    };
  };
  const context = {
    cfg: {},
    to: shimConversationId(),
    text: input.text ?? "",
    deps: {
      sendTelegram: sendPlatform,
      telegram: sendPlatform,
      discord: sendPlatform
    },
    ...(shimAccountId() ? { accountId: shimAccountId() } : {}),
    ...(input.replyToId ? { replyToId: input.replyToId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.silent === true ? { silent: true } : {})
  };

  let result;
  if (input.kind === "text") {
    result = await adapter.send?.text?.(context);
  } else if (input.kind === "media") {
    result = await adapter.send?.media?.({
      ...context,
      mediaUrl: input.mediaUrl,
      mediaLocalRoots: ["/tmp"]
    });
  } else if (input.kind === "payload") {
    result = await adapter.send?.payload?.({
      ...context,
      payload: input.payload ?? { text: input.text ?? "" },
      ...(input.mediaUrl ? { mediaUrl: input.mediaUrl, mediaLocalRoots: ["/tmp"] } : {})
    });
  } else {
    throw new Error(`unsupported adapter send kind '${input.kind}'`);
  }

  assert(result?.receipt, `${input.kind} send did not return a receipt`);
  return {
    send: {
      kind: input.kind,
      text: input.text ?? null,
      mediaUrl: input.mediaUrl ?? null,
      replyToId: input.replyToId ?? null,
      threadId: input.threadId ?? null,
      silent: input.silent === true,
      expectedPlatformSends: input.expectedPlatformSends ?? 1
    },
    result: compactSendResult(result),
    platformCalls: platformCalls.map(compactPlatformCall)
  };
}

function workflowInvariants(testCase, proof) {
  const expected = {
    ...(testCase.expects ?? {}),
    ...(channelRegistry.workflowOverrides?.[testCase.id] ?? {})
  };
  const expectedDeliveries = expected.visibleDeliveries ?? 1;
  const textCall = proof.platformCalls[expected.textDeliveryIndex ?? 0] ?? null;
  const mediaCall = proof.platformCalls[expected.mediaDeliveryIndex ?? 0] ?? null;
  const targetCall = proof.platformCalls[0] ?? null;
  return [
    invariant(`${testCase.id}:visible-delivery-count`, proof.platformCalls.length === expectedDeliveries, `${testCase.id} produced ${expectedDeliveries} visible adapter delivery; observed ${proof.platformCalls.length}`),
    invariant(`${testCase.id}:delivery-kind`, !expected.kind || proof.send.kind === expected.kind, `${testCase.id} used expected adapter send kind`),
    invariant(`${testCase.id}:text`, !expected.text || textCall?.text === expected.text, `${testCase.id} preserved expected text/caption`),
    invariant(`${testCase.id}:media`, expected.kind !== "media" || mediaCall?.options?.mediaUrl === expected.mediaSource, `${testCase.id} preserved expected media source`),
    invariant(`${testCase.id}:reply-to`, expected.replyTo !== "inbound-message" || platformReplyTargetMatches(targetCall), `${testCase.id} preserved reply target`),
    invariant(`${testCase.id}:thread`, !expected.threadId || platformThreadTargetMatches(targetCall), `${testCase.id} preserved thread target`),
    invariant(`${testCase.id}:silent`, expected.silent !== true || targetCall?.options?.silent === true, `${testCase.id} preserved silent delivery intent`),
    invariant(`${testCase.id}:terminal`, expected.terminal !== true || proof.result.platformMessageIds.length > 0, `${testCase.id} returned terminal adapter receipt`)
  ];
}

function capabilityRows(results, runError) {
  const byId = new Map(results.map((result) => [`${result.group}:${result.capabilityId}`, result]));
  return (channelRegistry.capabilities ?? []).map((capability) => {
    const result = byId.get(`${capability.group}:${capability.id}`) ?? null;
    const status = runError ? "failed" : result?.status ?? "missing";
    return {
      channelId,
      group: capability.group,
      capabilityId: capability.id,
      required: capability.requiredLevel === "blocking",
      status,
      proofMode: "deterministic-shim",
      summary: `${channelId} adapter deterministic shim ${capability.group}/${capability.id}`,
      reason: status === "passed" ? null : (runError ?? result?.reason ?? `${channelId} adapter did not emit proof for ${capability.group}/${capability.id}`),
      ownerArea: `${channelId} adapter`
    };
  });
}

function workflowRows(results, runError) {
  const byId = new Map(results.map((result) => [result.capabilityId, result]));
  return (channelRegistry.workflowCaseIds ?? []).map((caseId) => {
    const result = byId.get(caseId) ?? null;
    const status = runError ? "failed" : result?.status ?? "missing";
    return {
      channelId,
      group: "workflow",
      capabilityId: caseId,
      required: true,
      status,
      proofMode: "deterministic-shim",
      summary: `${channelId} adapter deterministic shim workflow ${caseId}`,
      reason: status === "passed" ? null : (runError ?? result?.reason ?? `${channelId} adapter did not emit workflow proof for ${caseId}`),
      ownerArea: `${channelId} adapter`
    };
  });
}

async function captureProof({ id, group, capabilityId, workflow = null, userAction = null, atoms = [], run }) {
  try {
    const result = await run();
    if (result?.skipped === true) {
      return {
        id,
        group,
        capabilityId,
        workflow,
        userAction,
        atoms,
        status: "skipped",
        reason: result.reason,
        result: null
      };
    }
    return {
      id,
      group,
      capabilityId,
      workflow,
      userAction,
      atoms,
      status: "passed",
      reason: null,
      result
    };
  } catch (error) {
    return {
      id,
      group,
      capabilityId,
      workflow,
      userAction,
      atoms,
      status: "failed",
      reason: error.message,
      result: null
    };
  }
}

function compactPlatformCall(call) {
  const [to, text, options] = call;
  return {
    to,
    text,
    options: {
      mediaUrl: options?.mediaUrl ?? null,
      mediaLocalRoots: options?.mediaLocalRoots ?? null,
      messageThreadId: options?.messageThreadId ?? null,
      replyToMessageId: options?.replyToMessageId ?? null,
      replyTo: options?.replyTo ?? null,
      silent: options?.silent ?? null,
      forceDocument: options?.forceDocument ?? null
    }
  };
}

function compactSendResult(result) {
  return {
    messageId: result.messageId ?? null,
    platformMessageIds: result.receipt?.platformMessageIds ?? [],
    parts: (result.receipt?.parts ?? []).map((part) => ({
      kind: part.kind,
      index: part.index,
      threadId: part.threadId ?? null,
      replyToId: part.replyToId ?? null
    }))
  };
}

function invariant(id, condition, summary) {
  return {
    id,
    status: condition ? "passed" : "failed",
    summary,
    reason: condition ? null : summary
  };
}

function runtimeCapabilityKey(capability) {
  const id = String(capability.id);
  if (capability.group === "ack") {
    return id.replaceAll("-", "_");
  }
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function shimConversationId() {
  return channelRegistry.deterministicShim?.conversationId ?? "12345";
}

function shimThreadId() {
  return channelRegistry.deterministicShim?.threadId ?? "12";
}

function shimReplyToId() {
  return channelRegistry.deterministicShim?.replyToId ?? "900";
}

function shimAccountId() {
  return channelRegistry.deterministicShim?.accountId ?? null;
}

function platformReplyTargetMatches(call) {
  const platform = channelRegistry.deterministicShim?.platform ?? {};
  if (!platform.replyOptionField) {
    return true;
  }
  return valuesEqual(call?.options?.[platform.replyOptionField], platform.replyOptionValue);
}

function platformThreadTargetMatches(call) {
  const platform = channelRegistry.deterministicShim?.platform ?? {};
  if (platform.threadTarget) {
    return call?.to === platform.threadTarget;
  }
  if (platform.threadOptionField) {
    return valuesEqual(call?.options?.[platform.threadOptionField], platform.threadOptionValue);
  }
  return true;
}

function valuesEqual(actual, expected) {
  if (actual === expected) {
    return true;
  }
  if (actual == null || expected == null) {
    return false;
  }
  return String(actual) === String(expected);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function safeArtifactSegment(value) {
  return String(value ?? "all").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function compactRuntimeContext(context) {
  if (!context) {
    return null;
  }
  return {
    source: "ocm-env",
    envName: context.envName ?? null,
    packageRoot: context.packageRoot,
    runtime: context.runtime ?? null
  };
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}
