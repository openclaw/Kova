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
    : await runCapabilityProofs(adapterContext, channelRegistry);
  const rows = [
    ...capabilityRows(capabilityResults, runError)
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
      runtimeContext: compactRuntimeContext(runtimeContext),
      adapterModulePath: adapterContext?.modulePath ?? null,
      timeoutMs: commandTimeoutMs,
      error: runError,
      capabilityResults,
      capabilities: rows
    }
  };
}

async function loadAdapterContext({ channelId: requestedChannelId, packageRoot }) {
  const distribution = channelRegistry.adapterDistribution;
  assert(distribution, `${requestedChannelId} channel registry does not declare adapterDistribution`);
  const modulePath = resolveAdapterModulePath({ distribution, packageRoot });
  const mod = await import(pathToFileURL(modulePath).href);
  const plugin = mod[distribution.exportName];
  const adapter = plugin?.message;
  if (!adapter) {
    throw new Error(`packaged ${requestedChannelId} plugin does not expose a message adapter`);
  }
  return { modulePath, plugin, adapter, distribution };
}

function resolveAdapterModulePath({ distribution, packageRoot }) {
  if (distribution.kind === "bundled") {
    return join(packageRoot, distribution.modulePath);
  }
  if (distribution.kind === "external") {
    const plugin = readInstalledPluginRecord(distribution.pluginId);
    return join(plugin.rootDir, distribution.modulePath);
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

async function runCapabilityProofs(adapterContext, channel) {
  const results = [];
  for (const capability of channel.capabilities ?? []) {
    results.push(await captureProof({
      id: `${capability.group}:${capability.id}`,
      group: capability.group,
      capabilityId: capability.id,
      run: () => proveCapability(adapterContext, capability)
    }));
  }
  return results;
}

async function proveCapability(adapterContext, capability) {
  const { adapter, plugin } = adapterContext;
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
  if (capability.group === "native-platform") {
    return await proveNativePlatformCapability(plugin, capability.id);
  }
  return { skipped: true, reason: `no deterministic shim proof for ${capability.group}:${capability.id}` };
}

async function proveNativePlatformCapability(plugin, capabilityId) {
  if (capabilityId.startsWith("action-")) {
    const expectedAction = capabilityId.slice("action-".length);
    const discovery = await describeMessageTool(plugin);
    assert(discovery.actions.includes(expectedAction), `${expectedAction} is not exposed by message tool discovery`);
    return {
      observed: {
        actions: discovery.actions,
        capabilities: discovery.capabilities
      }
    };
  }

  if (capabilityId === "delivery-pin") {
    const discovery = await describeMessageTool(plugin);
    assert(discovery.capabilities.includes("delivery-pin"), "delivery-pin is not exposed by message tool discovery");
    assert(plugin.outbound?.deliveryCapabilities?.pin === true, "outbound delivery pin capability is not declared");
    assert(typeof plugin.outbound?.pinDeliveredMessage === "function", "outbound pinDeliveredMessage handler is missing");
    return {
      observed: {
        actions: discovery.actions,
        capabilities: discovery.capabilities,
        outboundDeliveryCapabilities: plugin.outbound.deliveryCapabilities
      }
    };
  }

  if (capabilityId === "presentation") {
    const discovery = await describeMessageTool(plugin);
    assert(discovery.capabilities.includes("presentation"), "presentation is not exposed by message tool discovery");
    assert(plugin.outbound?.presentationCapabilities?.supported === true, "outbound presentation support is not declared");
    assert(typeof plugin.outbound?.renderPresentation === "function", "outbound renderPresentation handler is missing");
    return {
      observed: {
        actions: discovery.actions,
        capabilities: discovery.capabilities,
        presentationCapabilities: plugin.outbound.presentationCapabilities
      }
    };
  }

  return { skipped: true, reason: `native platform shim proof for ${capabilityId} is not implemented` };
}

async function describeMessageTool(plugin) {
  const describe = plugin.actions?.describeMessageTool;
  assert(typeof describe === "function", "plugin does not expose message tool discovery");
  const discovery = await describe({
    cfg: channelShimConfig(),
    ...(shimAccountId() ? { accountId: shimAccountId() } : {})
  });
  return {
    actions: Array.isArray(discovery?.actions) ? discovery.actions : [],
    capabilities: Array.isArray(discovery?.capabilities) ? discovery.capabilities : []
  };
}

async function proveDurableFinalCapability(adapter, capabilityId) {
  if (capabilityId === "text") {
    return await runAdapterSend(adapter, { kind: "text", text: `KOVA_${channelId.toUpperCase()}_TEXT_OK` });
  }
  if (capabilityId === "media") {
    return await runAdapterSend(adapter, { kind: "media", text: `KOVA_${channelId.toUpperCase()}_MEDIA_OK`, mediaUrl: "https://example.com/kova.png" });
  }
  if (capabilityId === "payload") {
    const text = `KOVA_${channelId.toUpperCase()}_PAYLOAD_OK`;
    return await runAdapterSend(adapter, { kind: "payload", text, payload: { text } });
  }
  if (capabilityId === "silent") {
    return await runAdapterSend(adapter, { kind: "text", text: `KOVA_${channelId.toUpperCase()}_SILENT_OK`, silent: true });
  }
  if (capabilityId === "reply-to") {
    return await runAdapterSend(adapter, { kind: "text", text: `KOVA_${channelId.toUpperCase()}_REPLY_OK`, replyToId: shimReplyToId() });
  }
  if (capabilityId === "thread") {
    return await runAdapterSend(adapter, { kind: "text", text: `KOVA_${channelId.toUpperCase()}_THREAD_OK`, threadId: shimThreadId() });
  }
  if (capabilityId === "message-sending-hooks") {
    assert(typeof adapter.send?.text === "function", "adapter text send hook path is missing");
    return { observed: { sendText: true } };
  }
  if (capabilityId === "batch") {
    const text = `KOVA_${channelId.toUpperCase()}_BATCH_OK`;
    return await runAdapterSend(adapter, {
      kind: "payload",
      text,
      payload: {
        text,
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"]
      },
      expectedPlatformSends: 2
    });
  }
  return { skipped: true, reason: `durable final shim proof for ${capabilityId} is not implemented` };
}

async function runAdapterSend(adapter, input) {
  const platformCalls = [];
  let sendIndex = 0;
  const sendPlatform = async (...call) => {
    platformCalls.push(call);
    sendIndex += 1;
    return platformSendResult(sendIndex);
  };
  const context = {
    cfg: {},
    to: shimConversationId(),
    text: input.text ?? "",
    deps: {
      [channelId]: sendPlatform
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

function runtimeCapabilityKey(capability) {
  const id = String(capability.id);
  if (capability.group === "ack") {
    return id.replaceAll("-", "_");
  }
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function shimConversationId() {
  return requiredShimValue("conversationId");
}

function shimThreadId() {
  return requiredShimValue("threadId");
}

function shimReplyToId() {
  return requiredShimValue("replyToId");
}

function shimAccountId() {
  return channelRegistry.deterministicShim?.accountId ?? null;
}

function channelShimConfig() {
  const config = channelRegistry.deterministicShim?.config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config;
  }
  return {};
}

function requiredShimValue(key) {
  const value = channelRegistry.deterministicShim?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${channelId} deterministicShim.${key} must be declared`);
  }
  return value;
}

function platformSendResult(sendIndex) {
  const platform = channelRegistry.deterministicShim?.platform ?? {};
  const resultMessageIdPrefix = platform.resultMessageIdPrefix;
  const resultTargetField = platform.resultTargetField;
  if (typeof resultMessageIdPrefix !== "string" || resultMessageIdPrefix.length === 0) {
    throw new Error(`${channelId} deterministicShim.platform.resultMessageIdPrefix must be declared`);
  }
  if (typeof resultTargetField !== "string" || resultTargetField.length === 0) {
    throw new Error(`${channelId} deterministicShim.platform.resultTargetField must be declared`);
  }
  return {
    messageId: `${resultMessageIdPrefix}-${sendIndex}`,
    [resultTargetField]: shimConversationId()
  };
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
