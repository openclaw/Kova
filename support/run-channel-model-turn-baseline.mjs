#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  openDirectGatewayRpcClient,
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs
} from "./openclaw-runtime.mjs";

const args = parseSupportArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
const message = args.message ?? "Reply with exact ASCII text KOVA_AGENT_OK only.";
const expectedText = args["expected-text"] ?? null;
const modelTurnCase = args.case ?? "all";
const includeSharedBaseline = args["skip-shared-baseline"] !== "true";
const continueOnModelTurnFailure = args["continue-on-model-turn-failure"] === "true";
const artifactPath = join(artifactDir, `channel-model-turn-baseline-${safeArtifactSegment(modelTurnCase)}.json`);
const providerRequestLogPath = join(artifactDir, "mock-openai", "requests.jsonl");

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
    const params = { message, case: modelTurnCase, includeSharedBaseline };
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
    result = buildResult({
      runtimeContext,
      turn,
      error: null,
      activeStartedAtEpochMs,
      activeFinishedAtEpochMs,
      providerRequestCountBefore,
      providerRequestCountAfter,
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
  activeStartedAtEpochMs = null,
  activeFinishedAtEpochMs = null,
  timeoutMs: commandTimeoutMs
}) {
  const runError = error ? error.message : turn?.error ?? null;
  const providerRequestDelta = Math.max(0, providerRequestCountAfter - providerRequestCountBefore);
  const expectedProviderRequests = Array.isArray(turn?.modelTurnCases) ? turn.modelTurnCases.length : 1;
  const activeTurnMs = activeStartedAtEpochMs === null || activeFinishedAtEpochMs === null
    ? null
    : Math.max(0, activeFinishedAtEpochMs - activeStartedAtEpochMs);
  const invariants = [
    ...(turn?.invariants ?? []),
    invariant("provider-request", !runError && providerRequestDelta >= expectedProviderRequests, "channel model turn made the expected mock provider requests"),
    invariant("no-global-error", !runError, "channel model turn completed without transport or plugin error")
  ];
  const ok = !runError && turn?.ok === true && invariants.every((item) => item.status === "passed");

  return {
    ok,
    artifact: {
      schemaVersion: "kova.channelModelTurnBaselineArtifact.v1",
      runtimeContext: compactRuntimeContext(runtimeContext),
      timeoutMs: commandTimeoutMs,
      message,
      case: modelTurnCase,
      expectedText: turn?.expectedText ?? expectedText,
      error: runError,
      providerRequestLogPath,
      providerRequestCountBefore,
      providerRequestCountAfter,
      providerRequestDelta,
      expectedProviderRequests,
      activeStartedAtEpochMs,
      activeFinishedAtEpochMs,
      activeTurnMs,
      turn,
      invariants
    }
  };
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
