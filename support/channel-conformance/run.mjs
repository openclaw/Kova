#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { parseSupportArgs, readTimeoutMs } from "../openclaw-runtime.mjs";
import { countProviderRequests, resetProviderScriptForCase } from "./provider-script.mjs";
import { waitForCaseObservations } from "./observations.mjs";
import { evaluateWorkflowCase } from "./evaluator.mjs";
import { prepareWorkflowFixtures } from "./fixtures.mjs";
import { validateChannelDriver } from "./driver-contract.mjs";
import { assertValidObservationSet } from "./observation-schema.mjs";
import { planWorkflowCases } from "./planner.mjs";
import { declaredCapabilityProofRows } from "./capability-proof.mjs";
import { collectRuntimeDiagnostics, runtimeDiagnosticOwnerArea } from "./runtime-diagnostics.mjs";
import { loadChannelCapabilities } from "../../src/registries/channel-capabilities.mjs";
import { loadChannelWorkflowCaseCatalog } from "../../src/registries/channel-workflow-cases.mjs";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = parseSupportArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const channelId = requiredArg(args, "channel");
const tier = args.tier ?? "adapter-shim";
const caseSet = args["case-set"] ?? "declared-workflows";
const continueOnFailure = args["continue-on-failure"] === "true";
const timeoutMs = readTimeoutMs(args["timeout-ms"], 180000);
const artifactPath = join(artifactDir, `channel-conformance-${safeArtifactSegment(channelId)}.json`);

let result;
let driver = null;
let platform = null;
try {
  driver = await loadChannelDriver(channelId);
  const [channelRegistry] = await loadChannelCapabilities(channelId);
  const [workflowCatalog] = await loadChannelWorkflowCaseCatalog();
  const workflowCoverage = planWorkflowCases({ channelRegistry, workflowCatalog, caseSet, driver });
  const selectedCases = workflowCoverage.selected;
  platform = await driver.startPlatform({ repoRoot, artifactDir, timeoutMs });
  platform.driver = driver;
  const configureResult = await driver.configureOpenClaw({ repoRoot, envName, artifactDir, platform, timeoutMs });
  if (configureResult.status !== 0) {
    throw new Error(`channel ${channelId} OpenClaw configuration failed: ${configureResult.command}`);
  }
  const startupResult = await driver.startOpenClaw({ repoRoot, envName, artifactDir, platform, timeoutMs });
  const rows = [];
  for (let index = 0; index < selectedCases.length; index += 1) {
    const row = await runWorkflowCase({ driver, workflowCase: selectedCases[index], platform });
    rows.push(row);
    if (row.status !== "passed" && index < selectedCases.length - 1) {
      await restartOpenClawAfterFailedCase({ driver, platform, failedCaseId: row.id });
    }
  }
  const capabilityProofRows = declaredCapabilityProofRows({
    channelId,
    channelRegistry,
    workflowCoverage,
    rows,
    artifactPath
  });
  result = {
    ok: rows.every((row) => row.status === "passed") &&
      capabilityProofRows.every((row) => row.status === "passed"),
    rows,
    capabilityProofRows,
    artifact: {
      schemaVersion: "kova.channelConformanceArtifact.v1",
      channelId,
      tier,
      caseSet,
      workflowCaseCatalogId: workflowCatalog.id,
      selectedCaseIds: selectedCases.map((workflowCase) => workflowCase.id),
      workflowCoverage: {
        ...workflowCoverage,
        selected: workflowCoverage.selectedRows ?? workflowCoverage.selected
      },
      driverContract: Object.keys(driver).sort(),
      platform: platformSummary(platform),
      setup: {
        configureOpenClaw: configureResult,
        startOpenClaw: startupResult
      },
      rows,
      capabilityProofRows
    }
  };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  result = {
    ok: false,
    rows: [],
    artifact: {
      schemaVersion: "kova.channelConformanceArtifact.v1",
      channelId,
      tier,
      caseSet,
      error: message
    }
  };
} finally {
  if (platform && driver) {
    await driver.stopPlatform({ platform }).catch(() => {});
  }
}

await mkdir(artifactDir, { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  schemaVersion: "kova.channelCapabilityRun.v1",
  proofMode: "channel-platform-conformance",
  artifactPath,
  ownerArea: `${channelId} adapter/runtime`,
  channelId,
  capabilities: compactCapabilityRows([
    ...result.rows.map((row) => ({
      channelId,
      group: "workflow",
      capabilityId: row.id,
      required: true,
      status: row.status,
      proofMode: "channel-platform-conformance",
      summary: row.summary,
      reason: row.reason,
      failureOwner: row.failureOwner ?? null,
      ownerArea: row.ownerArea
    })),
    ...(result.capabilityProofRows ?? [])
  ])
})}\n`);

const setupFailedBeforeAnyWorkflow = !result.ok && result.rows.length === 0;
process.exit(result.ok || (continueOnFailure && !setupFailedBeforeAnyWorkflow) ? 0 : 1);

async function loadChannelDriver(id) {
  if (!/^[a-z0-9-]+$/u.test(id)) {
    throw new Error(`invalid channel id: ${id}`);
  }
  const modulePath = join(repoRoot, "support", "channels", id, "driver.mjs");
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new Error(`channel driver '${id}' is unavailable at ${modulePath}: ${error.message}`);
  }
  return validateChannelDriver(mod, id);
}

async function runWorkflowCase({ driver, workflowCase, platform }) {
  const startedAtEpochMs = Date.now();
  const fixtures = await prepareWorkflowFixtures(workflowCase, { envName });
  const runnableWorkflowCase = withFixtureMediaSourceProof(workflowCase, fixtures);
  let row;
  try {
    const providerRequestCountBefore = await countProviderRequests({ artifactDir });
    const callCursor = (await driver.readPlatformCalls({ platform })).length;
    if (typeof driver.configureWorkflowCase === "function") {
      const configureCaseResult = await driver.configureWorkflowCase({ workflowCase: runnableWorkflowCase, platform });
      if (configureCaseResult?.status !== 0) {
        throw new Error(`channel ${channelId} workflow case configuration failed for ${runnableWorkflowCase.id}: ${configureCaseResult?.command ?? "unknown command"}`);
      }
    }
    await resetProviderScriptForCase({
      repoRoot,
      artifactDir,
      workflowCase: runnableWorkflowCase,
      fixtureReplacements: fixtures.replacements
    });
    const inbound = await driver.enqueueUserEvent({ workflowCase: runnableWorkflowCase, platform });
    let observations = await waitForCaseObservations({
      workflowCase: runnableWorkflowCase,
      platform,
      callCursor,
      readPlatformCalls: (params) => driver.readPlatformCalls(params),
      readProviderRequestCount: () => countProviderRequests({ artifactDir }),
      normalizeObservations: (params) => driver.normalizeObservations(params),
      timeoutMs
    });
    assertValidObservationSet(observations, { caseId: runnableWorkflowCase.id });
    const providerRequestsBeforeEcho = await countProviderRequests({ artifactDir });
    if (runnableWorkflowCase.expects?.noSelfTrigger === true) {
      await driver.enqueueBotEcho({ workflowCase: runnableWorkflowCase, platform, inbound, observations });
      await sleep(1500);
      const calls = await driver.readPlatformCalls({ platform });
      observations = await driver.normalizeObservations({ workflowCase: runnableWorkflowCase, platform, inbound, calls: calls.slice(callCursor) });
      assertValidObservationSet(observations, { caseId: runnableWorkflowCase.id });
    }
    const providerRequestCountAfter = await countProviderRequests({ artifactDir });
    const providerRequestsDelta = providerRequestCountAfter - providerRequestCountBefore;
    const providerRequestsAfterEcho = providerRequestCountAfter - providerRequestsBeforeEcho;
    let runtimeDiagnostics = null;
    let invariants = evaluateWorkflowCase({
      workflowCase: runnableWorkflowCase,
      observations,
      providerRequestsDelta,
      providerRequestsAfterEcho
    });
    let failed = invariants.find((invariant) => invariant.status !== "passed") ?? null;
    if (failed) {
      runtimeDiagnostics = await collectRuntimeDiagnostics({
        envName,
        sinceEpochMs: startedAtEpochMs,
        timeoutMs: Math.min(timeoutMs, 10000)
      });
      invariants = evaluateWorkflowCase({
        workflowCase: runnableWorkflowCase,
        observations,
        providerRequestsDelta,
        providerRequestsAfterEcho,
        runtimeDiagnostics
      });
      failed = invariants.find((invariant) => invariant.status !== "passed") ?? null;
    }
    const failureClassification = classifyWorkflowFailure({
      failedInvariant: failed,
      runtimeDiagnostics,
      workflowCase: runnableWorkflowCase
    });
    row = {
      id: runnableWorkflowCase.id,
      status: failed ? "failed" : "passed",
      summary: `${channelId} ${runnableWorkflowCase.id} channel workflow ${failed ? "failed" : "passed"}`,
      reason: failed?.reason ?? null,
      workflow: runnableWorkflowCase.workflow,
      inventoryWorkflow: runnableWorkflowCase.inventoryWorkflow,
      matrix: runnableWorkflowCase.matrix,
      userAction: runnableWorkflowCase.userAction,
      failureOwner: failed ? failureClassification.failureOwner : null,
      ownerArea: failed
        ? failureClassification.ownerArea
        : (runnableWorkflowCase.ownerArea ?? `${channelId} adapter/runtime`),
      capabilities: runnableWorkflowCase.atoms ?? [],
      providerRequestsDelta,
      providerRequestsAfterEcho,
      runtimeDiagnostics,
      observations,
      invariants
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    row = failedRow(workflowCase, reason);
  } finally {
    await fixtures.cleanup();
  }
  const finishedAtEpochMs = Date.now();
  return {
    ...row,
    startedAtEpochMs,
    finishedAtEpochMs,
    durationMs: Math.max(0, finishedAtEpochMs - startedAtEpochMs)
  };
}

function withFixtureMediaSourceProof(workflowCase, fixtures) {
  if (!Array.isArray(fixtures.sourceProofs) || fixtures.sourceProofs.length === 0) {
    return workflowCase;
  }
  return {
    ...workflowCase,
    expects: {
      ...(workflowCase.expects ?? {}),
      mediaSourceProofs: fixtures.sourceProofs
    }
  };
}

async function restartOpenClawAfterFailedCase({ driver, platform, failedCaseId }) {
  const stop = spawnSync("ocm", ["service", "stop", envName, "--json"], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env
  });
  if (stop.status !== 0) {
    throw new Error(`failed to stop OpenClaw after ${failedCaseId}: ${stop.stderr || stop.stdout}`);
  }
  await driver.startOpenClaw({ repoRoot, envName, artifactDir, platform, timeoutMs });
}

function failedRow(workflowCase, reason) {
  const classification = classifyRunnerFailure(reason, workflowCase);
  return {
    id: workflowCase.id,
    status: "failed",
    summary: `${workflowCase.id} channel workflow failed`,
    reason,
    failureOwner: classification.failureOwner,
    ownerArea: classification.ownerArea,
    invariants: [
      {
        id: `${workflowCase.id}:runner`,
        status: "failed",
        summary: reason,
        reason
      }
    ]
  };
}

function classifyWorkflowFailure({ failedInvariant, runtimeDiagnostics, workflowCase }) {
  const diagnosticOwner = runtimeDiagnosticOwnerArea(runtimeDiagnostics);
  if (diagnosticOwner) {
    return {
      failureOwner: "openclaw-runtime",
      ownerArea: diagnosticOwner
    };
  }

  const invariantId = failedInvariant?.id ?? "";
  if (invariantId.endsWith(":runtime-diagnostics")) {
    return {
      failureOwner: "openclaw-runtime",
      ownerArea: workflowCase.ownerArea ?? "OpenClaw runtime"
    };
  }
  if (invariantId.endsWith(":inbound-media") ||
      invariantId.endsWith(":native-actions") ||
      invariantId.endsWith(":native-message-proof")) {
    return {
      failureOwner: "channel-adapter",
      ownerArea: `${channelId} adapter/platform mapping`
    };
  }
  if (invariantId.endsWith(":route") ||
      invariantId.endsWith(":reply-target") ||
      invariantId.endsWith(":silent")) {
    return {
      failureOwner: "channel-adapter",
      ownerArea: `${channelId} adapter delivery mapping`
    };
  }
  if (invariantId.endsWith(":unmatched-native-visible-sends") ||
      invariantId.endsWith(":no-duplicate-final") ||
      invariantId.endsWith(":no-self-trigger")) {
    return {
      failureOwner: "openclaw-runtime",
      ownerArea: workflowCase.ownerArea ?? "OpenClaw channel runtime"
    };
  }
  if (invariantId.endsWith(":media-source") ||
      invariantId.endsWith(":media-present") ||
      invariantId.endsWith(":visible-delivery-count") ||
      invariantId.endsWith(":expected-kind") ||
      invariantId.endsWith(":expected-text")) {
    return {
      failureOwner: "openclaw-runtime",
      ownerArea: workflowCase.ownerArea ?? `${channelId} adapter/runtime`
    };
  }

  return {
    failureOwner: "unknown",
    ownerArea: workflowCase.ownerArea ?? `${channelId} adapter/runtime`
  };
}

function compactCapabilityRows(rows) {
  return (rows ?? []).map((row) => omitNullish({
    channelId: row.channelId,
    group: row.group,
    capabilityId: row.capabilityId,
    required: row.required,
    status: row.status,
    proofMode: row.proofMode,
    summary: row.summary,
    reason: row.reason,
    failureOwner: row.failureOwner,
    ownerArea: row.ownerArea
  }));
}

function omitNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function classifyRunnerFailure(reason, workflowCase) {
  const text = String(reason ?? "");
  if (/mock provider|mock-ai-provider|script reset|script/i.test(text)) {
    return {
      failureOwner: "mock-provider",
      ownerArea: "Kova mock provider"
    };
  }
  if (/invalid observation|observation.*must|driver|normalizeObservations|enqueueUserEvent|readPlatformCalls/i.test(text)) {
    return {
      failureOwner: "kova-harness",
      ownerArea: "Kova channel conformance harness"
    };
  }
  return {
    failureOwner: "kova-harness",
    ownerArea: workflowCase.ownerArea ?? "Kova channel conformance harness"
  };
}

function platformSummary(value) {
  return {
    apiRoot: value?.apiRoot ?? null,
    artifactDir: value?.artifactDir ?? null,
    callsPath: value?.callsPath ?? null
  };
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function safeArtifactSegment(value) {
  return String(value ?? "all").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
