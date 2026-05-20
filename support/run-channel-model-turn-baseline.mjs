#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDirectGatewayRpcClient,
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs
} from "./openclaw-runtime.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseSupportArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
const expectedText = args["expected-text"] ?? null;
const modelTurnCase = args.case ?? "all";
const includeSharedBaseline = args["skip-shared-baseline"] !== "true";
const continueOnModelTurnFailure = args["continue-on-model-turn-failure"] === "true";
const providerRequestPolicyOverride = parseProviderRequestPolicyArg(args["provider-request-policy"]);
const artifactPath = join(artifactDir, `channel-model-turn-baseline-${safeArtifactSegment(modelTurnCase)}.json`);
const providerRequestLogPath = join(artifactDir, "mock-openai", "requests.jsonl");
const capabilityCatalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "openclaw-message.json"), "utf8"));
const workflowCaseCatalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "channel-workflow-cases.json"), "utf8"));
const selectedWorkflowCases = selectWorkflowCases(workflowCaseCatalog, capabilityCatalog, modelTurnCase);

async function main() {
  let result;
  let clientHandle = null;
  const providerRequestCountBefore = await countJsonl(providerRequestLogPath);
  try {
    const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(envName);
    clientHandle = await openDirectGatewayRpcClient(runtimeContext);
    if (!clientHandle.client) {
      throw new Error(`gateway direct RPC unavailable: ${clientHandle.fallbackReason ?? "unknown"}`);
    }
    await waitForBaselineChannel(clientHandle.client, timeoutMs);
    const activeStartedAtEpochMs = Date.now();
    const params = {
      message: selectedWorkflowCases.length === 1 ? selectedWorkflowCases[0].prompt : null,
      case: modelTurnCase,
      cases: selectedWorkflowCases,
      workflowCaseCatalogId: workflowCaseCatalog.id,
      includeSharedBaseline
    };
    if (expectedText) {
      params.expectedText = expectedText;
    }
    const turn = await clientHandle.client.request(
      "kova.channelBaseline.runModelTurn",
      params,
      { timeoutMs }
    );
    const activeFinishedAtEpochMs = Date.now();
    const providerRequestCountAfter = await countJsonl(providerRequestLogPath);
    const providerRequestScopedCount = await countScopedProviderRequests(providerRequestLogPath, turn?.modelTurnCases);
    result = buildResult({
      runtimeContext,
      turn,
      error: null,
      activeStartedAtEpochMs,
      activeFinishedAtEpochMs,
      providerRequestCountBefore,
      providerRequestCountAfter,
      providerRequestScopedCount,
      timeoutMs
    });
  } catch (error) {
    const providerRequestCountAfter = await countJsonl(providerRequestLogPath);
    result = buildResult({
      runtimeContext: null,
      turn: null,
      error,
      providerRequestCountBefore,
      providerRequestCountAfter,
      timeoutMs
    });
  } finally {
    clientHandle?.client?.close?.();
  }

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "kova.channelModelTurnRun.v1",
    ok: result.ok,
    artifactPath,
    ownerArea: "OpenClaw",
    envName,
    case: modelTurnCase,
    workflowCaseCatalogId: workflowCaseCatalog.id,
    workflowCaseIds: selectedWorkflowCases.map((testCase) => testCase.id),
    workflows: [...new Set(selectedWorkflowCases.map((testCase) => testCase.workflow).filter(Boolean))],
    expectedText: result.artifact.turn?.expectedText ?? expectedText,
    sharedBaselineIncluded: result.artifact.turn?.sharedBaselineIncluded ?? null,
    finalText: result.artifact.turn?.finalText ?? null,
    inboundEventId: result.artifact.turn?.modelTurnCases?.[0]?.inboundEvent?.id ?? result.artifact.turn?.inboundEvent?.id ?? null,
    routeSessionKey: result.artifact.turn?.modelTurnCases?.[0]?.routeSessionKey ?? result.artifact.turn?.routeSessionKey ?? null,
    modelTurnCaseCount: result.artifact.turn?.modelTurnCases?.length ?? null,
    failedModelTurnCases: summarizeFailedModelTurnCases(result.artifact.turn?.modelTurnCases),
    capabilityRowCount: result.artifact.turn?.capabilityRows?.length ?? null,
    activeStartedAtEpochMs: result.artifact.activeStartedAtEpochMs,
    activeFinishedAtEpochMs: result.artifact.activeFinishedAtEpochMs,
    activeTurnMs: result.artifact.activeTurnMs,
    providerRequestDelta: result.artifact.providerRequestDelta,
    providerRequestScopedCount: result.artifact.providerRequestScopedCount,
    providerRequestObserved: result.artifact.providerRequestObserved,
    providerRequestScope: result.artifact.providerRequestScope,
    providerRequestPolicy: result.artifact.providerRequestPolicy,
    invariants: result.artifact.invariants
  }, null, 2)}\n`);
  process.exit(result.ok || continueOnModelTurnFailure ? 0 : 1);
}

async function waitForBaselineChannel(client, commandTimeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < commandTimeoutMs) {
    try {
      const status = await client.request("kova.channelBaseline.status", {}, { timeoutMs: 5000 });
      if (status?.ok === true) {
        return status;
      }
      lastError = new Error("kova channel baseline plugin registered but channel runtime is not started");
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw lastError ?? new Error("timed out waiting for kova channel baseline runtime");
}

function buildResult({
  runtimeContext,
  turn,
  error,
  providerRequestCountBefore,
  providerRequestCountAfter,
  providerRequestScopedCount,
  activeStartedAtEpochMs = null,
  activeFinishedAtEpochMs = null,
  timeoutMs: commandTimeoutMs
}) {
  const runError = error ? error.message : turn?.error ?? null;
  const providerRequestDelta = Math.max(0, providerRequestCountAfter - providerRequestCountBefore);
  const providerRequestObserved = Number.isInteger(providerRequestScopedCount) ? providerRequestScopedCount : providerRequestDelta;
  const providerRequestPolicy = providerRequestPolicyOverride ?? resolveProviderRequestPolicy(turn?.modelTurnCases);
  const activeTurnMs = activeStartedAtEpochMs === null || activeFinishedAtEpochMs === null
    ? null
    : Math.max(0, activeFinishedAtEpochMs - activeStartedAtEpochMs);
  const invariants = [
    ...(turn?.invariants ?? []),
    providerRequestInvariant(providerRequestPolicy, providerRequestObserved, runError),
    invariant("no-global-error", !runError, "channel model turn completed without transport or plugin error")
  ];
  const ok = !runError && turn?.ok === true && invariants.every((item) => item.status === "passed");

  return {
    ok,
    artifact: {
      schemaVersion: "kova.channelModelTurnBaselineArtifact.v1",
      workflowCaseCatalogId: workflowCaseCatalog.id,
      workflowCaseIds: selectedWorkflowCases.map((testCase) => testCase.id),
      workflowCaseMessages: selectedWorkflowCases.map((testCase) => ({
        id: testCase.id,
        prompt: testCase.prompt,
        userAction: testCase.userAction
      })),
      runtimeContext: compactRuntimeContext(runtimeContext),
      timeoutMs: commandTimeoutMs,
      message: selectedWorkflowCases.length === 1 ? selectedWorkflowCases[0].prompt : null,
      case: modelTurnCase,
      expectedText: turn?.expectedText ?? expectedText,
      error: runError,
      providerRequestLogPath,
      providerRequestCountBefore,
      providerRequestCountAfter,
      providerRequestDelta,
      providerRequestScopedCount,
      providerRequestObserved,
      providerRequestScope: Number.isInteger(providerRequestScopedCount) ? "kova-inbound-event" : "before-after-delta",
      providerRequestPolicy,
      activeStartedAtEpochMs,
      activeFinishedAtEpochMs,
      activeTurnMs,
      turn,
      invariants
    }
  };
}

function selectWorkflowCases(catalog, capabilityCatalogValue, requestedCase) {
  const knownAtoms = new Set((capabilityCatalogValue?.capabilities ?? []).map((capability) => `${capability.group}:${capability.id}`));
  const cases = Array.isArray(catalog?.cases)
    ? catalog.cases.map(normalizeWorkflowCase)
    : [];
  if (cases.length === 0) {
    throw new Error(`channel workflow case catalog ${catalog?.id ?? "<unknown>"} does not contain cases`);
  }
  const ids = new Set();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) {
      throw new Error(`channel workflow case catalog ${catalog?.id ?? "<unknown>"} duplicates case id ${testCase.id}`);
    }
    ids.add(testCase.id);
    for (const capability of testCase.capabilities) {
      const key = `${capability.group}:${capability.id}`;
      if (!knownAtoms.has(key)) {
        throw new Error(`channel workflow case ${testCase.id} references unknown OpenClaw channel capability ${key}`);
      }
    }
  }
  if (requestedCase == null || requestedCase === "" || requestedCase === "all") {
    return cases;
  }
  const requestedIds = new Set(String(requestedCase).split(",").map((item) => item.trim()).filter(Boolean));
  const selected = cases.filter((testCase) => requestedIds.has(testCase.id));
  if (selected.length !== requestedIds.size) {
    const known = new Set(cases.map((testCase) => testCase.id));
    const unknown = [...requestedIds].filter((id) => !known.has(id));
    throw new Error(`unknown channel workflow case${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return selected;
}

function normalizeWorkflowCase(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("channel workflow case must be an object");
  }
  const id = requiredString(entry, "id");
  const expects = objectOrEmpty(entry.expects);
  const providerScript = objectOrEmpty(entry.providerScript);
  const fixtures = objectOrEmpty(entry.fixtures);
  const toolCalls = Array.isArray(providerScript.toolCalls) ? providerScript.toolCalls : [];
  if (toolCalls.length > 1) {
    throw new Error(`channel workflow case ${id} declares ${toolCalls.length} tool calls; the current model-turn runner supports at most one scripted tool call`);
  }
  const expectedText = typeof expects.text === "string"
    ? expects.text
    : (typeof providerScript.finalText === "string" ? providerScript.finalText : null);
  if (!expectedText) {
    throw new Error(`channel workflow case ${id} must declare expects.text or providerScript.finalText`);
  }
  return {
    id,
    workflow: requiredString(entry, "workflow"),
    userAction: requiredString(entry, "userAction"),
    openclawSurface: typeof entry.openclawSurface === "string" ? entry.openclawSurface : null,
    ownerArea: typeof entry.ownerArea === "string" ? entry.ownerArea : null,
    prompt: requiredString(entry, "prompt"),
    responseText: typeof providerScript.finalText === "string" ? providerScript.finalText : expectedText,
    toolCall: toolCalls[0] ?? null,
    expectedText,
    expectedKind: typeof expects.kind === "string" ? expects.kind : null,
    expectedLocalMediaSource: typeof expects.mediaSource === "string" ? expects.mediaSource : null,
    expectedMediaSourcePolicy: typeof expects.mediaSourcePolicy === "string" ? expects.mediaSourcePolicy : null,
    mediaFixturePath: typeof fixtures.mediaPath === "string" ? fixtures.mediaPath : null,
    sourceReplyDeliveryMode: typeof entry.sourceReplyDeliveryMode === "string" ? entry.sourceReplyDeliveryMode : null,
    finalDeliveries: normalizeVisibleDeliveries(id, expects.visibleDeliveries),
    providerRequests: normalizeCaseProviderRequests(id, entry.providerRequests),
    expectReplyToId: expects.replyTo === "inbound-message",
    expectHooks: expects.hooks === true,
    threadId: typeof expects.threadId === "string" ? expects.threadId : null,
    silent: expects.silent === true,
    capabilities: normalizeAtoms(id, entry.atoms)
  };
}

function normalizeVisibleDeliveries(caseId, value) {
  if (Number.isInteger(value) && value >= 0) {
    return { mode: "exact", expected: value };
  }
  if (value == null || value === "observe") {
    return { mode: "observe" };
  }
  throw new Error(`channel workflow case ${caseId} expects.visibleDeliveries must be a non-negative integer or observe`);
}

function normalizeCaseProviderRequests(caseId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mode: "observe" };
  }
  if (value.mode === "exact" && Number.isInteger(value.expected) && value.expected >= 0) {
    return { mode: "exact", expected: value.expected };
  }
  if ((value.mode === "minimum" || value.mode === "min") && Number.isInteger(value.min) && value.min >= 0) {
    return { mode: "minimum", min: value.min };
  }
  if (value.mode === "observe") {
    return { mode: "observe" };
  }
  throw new Error(`channel workflow case ${caseId} has unsupported providerRequests policy`);
}

function normalizeAtoms(caseId, atoms) {
  if (!Array.isArray(atoms) || atoms.length === 0) {
    throw new Error(`channel workflow case ${caseId} must declare atom coverage`);
  }
  return atoms.map((atom, index) => {
    if (!atom || typeof atom !== "object" || Array.isArray(atom)) {
      throw new Error(`channel workflow case ${caseId} atom ${index} must be an object`);
    }
    return {
      group: requiredString(atom, "group"),
      id: requiredString(atom, "id")
    };
  });
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredString(object, key) {
  const value = object?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`channel workflow field ${key} must be a non-empty string`);
  }
  return value;
}

function resolveProviderRequestPolicy(cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    return { mode: "observe", reason: "no completed model-turn cases declared a provider request policy" };
  }
  const policies = cases.map((testCase) => normalizeProviderRequestPolicy(testCase?.providerRequests));
  if (policies.every((policy) => policy.mode === "exact")) {
    return {
      mode: "exact",
      expected: policies.reduce((total, policy) => total + policy.expected, 0),
      source: "model-turn-cases"
    };
  }
  if (policies.every((policy) => policy.mode === "minimum")) {
    return {
      mode: "minimum",
      min: policies.reduce((total, policy) => total + policy.min, 0),
      source: "model-turn-cases"
    };
  }
  return {
    mode: "observe",
    reason: "mixed or observational provider request policies; provider request count is recorded but not a failure gate"
  };
}

function parseProviderRequestPolicyArg(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (text === "observe") {
    return { mode: "observe", source: "cli" };
  }
  const exact = text.match(/^exact:(\d+)$/);
  if (exact) {
    return { mode: "exact", expected: Number(exact[1]), source: "cli" };
  }
  const minimum = text.match(/^(?:minimum|min):(\d+)$/);
  if (minimum) {
    return { mode: "minimum", min: Number(minimum[1]), source: "cli" };
  }
  throw new Error(`unsupported provider request policy '${text}'; expected observe, exact:<count>, or min:<count>`);
}

function normalizeProviderRequestPolicy(value) {
  if (value?.mode === "exact" && Number.isInteger(value.expected) && value.expected >= 0) {
    return { mode: "exact", expected: value.expected };
  }
  if ((value?.mode === "minimum" || value?.mode === "min") && Number.isInteger(value.min) && value.min >= 0) {
    return { mode: "minimum", min: value.min };
  }
  if (value?.mode === "observe") {
    return { mode: "observe" };
  }
  return { mode: "observe" };
}

function providerRequestInvariant(policy, observed, runError) {
  if (policy?.mode === "exact") {
    return invariant(
      "provider-request-count",
      !runError && observed === policy.expected,
      `channel model turn made exactly ${policy.expected} mock provider request${policy.expected === 1 ? "" : "s"}; observed ${observed}`
    );
  }
  if (policy?.mode === "minimum") {
    return invariant(
      "provider-request-count",
      !runError && observed >= policy.min,
      `channel model turn made at least ${policy.min} mock provider request${policy.min === 1 ? "" : "s"}; observed ${observed}`
    );
  }
  return invariant(
    "provider-request-count-observed",
    true,
    `channel model turn provider request count observed without gating; observed ${observed}`
  );
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

function summarizeFailedModelTurnCases(cases) {
  if (!Array.isArray(cases)) {
    return [];
  }
  return cases
    .filter((testCase) => testCase?.status !== "passed")
    .map((testCase) => ({
      id: testCase.id ?? null,
      workflow: testCase.workflow ?? null,
      userAction: testCase.userAction ?? null,
      capabilities: Array.isArray(testCase.capabilities)
        ? testCase.capabilities.map((capability) => ({
            group: capability.group ?? null,
            id: capability.id ?? null
          }))
        : [],
      reason: testCase.reason ?? null,
      failedInvariants: Array.isArray(testCase.invariants)
        ? testCase.invariants
            .filter((invariant) => invariant?.status !== "passed")
            .map((invariant) => ({
              id: invariant.id ?? null,
              reason: invariant.reason ?? invariant.summary ?? null
            }))
        : []
    }));
}

async function countJsonl(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function countScopedProviderRequests(path, cases) {
  const inboundEventIds = new Set(
    Array.isArray(cases)
      ? cases
          .map((testCase) => testCase?.inboundEvent?.id)
          .filter((id) => typeof id === "string" && id.length > 0)
      : []
  );
  if (inboundEventIds.size === 0) {
    return null;
  }
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const entryInboundIds = Array.isArray(entry?.kova?.inboundEventIds) ? entry.kova.inboundEventIds : [];
    if (entryInboundIds.some((id) => inboundEventIds.has(id))) {
      count += 1;
    }
  }
  return count;
}

function invariant(id, condition, summary) {
  return {
    id,
    status: condition ? "passed" : "failed",
    summary,
    reason: condition ? null : summary
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

await main();
