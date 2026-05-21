#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { parseSupportArgs, readTimeoutMs } from "../openclaw-runtime.mjs";
import { countProviderRequests, resetProviderScriptForCase } from "./provider-script.mjs";
import { waitForCaseObservations } from "./observations.mjs";
import { evaluateWorkflowCase } from "./evaluator.mjs";
import { prepareWorkflowFixtures } from "./fixtures.mjs";

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
  const channelRegistry = await readJson(join(repoRoot, "channel-capabilities", `${channelId}.json`));
  const workflowCatalog = await readJson(join(repoRoot, "channel-capabilities", "channel-workflow-cases.json"));
  const selectedCases = selectWorkflowCases({ channelRegistry, workflowCatalog, caseSet });
  platform = await driver.startPlatform({ repoRoot, artifactDir, timeoutMs });
  platform.driver = driver;
  const configureResult = await driver.configureOpenClaw({ repoRoot, envName, artifactDir, platform, timeoutMs });
  if (configureResult.status !== 0) {
    throw new Error(`channel ${channelId} OpenClaw configuration failed: ${configureResult.command}`);
  }
  const startupResult = await driver.startOpenClaw({ repoRoot, envName, artifactDir, platform, timeoutMs });
  const rows = [];
  for (const workflowCase of selectedCases) {
    rows.push(await runWorkflowCase({ driver, workflowCase, platform }));
  }
  result = {
    ok: rows.every((row) => row.status === "passed"),
    rows,
    artifact: {
      schemaVersion: "kova.channelConformanceArtifact.v1",
      channelId,
      tier,
      caseSet,
      workflowCaseCatalogId: workflowCatalog.id,
      selectedCaseIds: selectedCases.map((workflowCase) => workflowCase.id),
      driverContract: Object.keys(driver).sort(),
      platform: platformSummary(platform),
      setup: {
        configureOpenClaw: configureResult,
        startOpenClaw: startupResult
      },
      rows
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
  capabilities: result.rows.map((row) => ({
    channelId,
    group: "workflow",
    capabilityId: row.id,
    required: true,
    status: row.status,
    proofMode: "channel-platform-conformance",
    summary: row.summary,
    reason: row.reason,
    ownerArea: row.ownerArea,
    artifactPath
  }))
}, null, 2)}\n`);

process.exit(result.ok || continueOnFailure ? 0 : 1);

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
  const required = [
    "startPlatform",
    "configureOpenClaw",
    "startOpenClaw",
    "enqueueUserEvent",
    "enqueueBotEcho",
    "readPlatformCalls",
    "normalizeObservations",
    "stopPlatform"
  ];
  for (const name of required) {
    if (typeof mod[name] !== "function") {
      throw new Error(`channel driver '${id}' does not export ${name}()`);
    }
  }
  return mod;
}

function selectWorkflowCases({ channelRegistry, workflowCatalog, caseSet: requestedCaseSet }) {
  const cases = Array.isArray(workflowCatalog?.cases) ? workflowCatalog.cases : [];
  const casesById = new Map(cases.map((workflowCase) => [workflowCase.id, workflowCase]));
  const ids = requestedCaseSet === "declared-workflows"
    ? channelRegistry.workflowCaseIds ?? []
    : requestedCaseSet.split(",").map((id) => id.trim()).filter(Boolean);
  const selected = ids.map((id) => casesById.get(id)).filter(Boolean);
  if (selected.length !== ids.length) {
    const unknown = ids.filter((id) => !casesById.has(id));
    throw new Error(`unknown workflow case${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return selected;
}

async function runWorkflowCase({ driver, workflowCase, platform }) {
  const startedAtEpochMs = Date.now();
  const fixtures = await prepareWorkflowFixtures(workflowCase, { envName });
  let row;
  try {
    const providerRequestCountBefore = await countProviderRequests({ artifactDir });
    const callCursor = (await driver.readPlatformCalls({ platform })).length;
    await resetProviderScriptForCase({
      repoRoot,
      artifactDir,
      workflowCase,
      fixtureReplacements: fixtures.replacements
    });
    const inbound = await driver.enqueueUserEvent({ workflowCase, platform });
    let observations = await waitForCaseObservations({
      workflowCase,
      platform,
      callCursor,
      readPlatformCalls: (params) => driver.readPlatformCalls(params),
      normalizeObservations: (params) => driver.normalizeObservations(params),
      timeoutMs
    });
    const providerRequestsBeforeEcho = await countProviderRequests({ artifactDir });
    if (workflowCase.expects?.noSelfTrigger === true) {
      await driver.enqueueBotEcho({ workflowCase, platform, inbound, observations });
      await sleep(1500);
      const calls = await driver.readPlatformCalls({ platform });
      observations = await driver.normalizeObservations({ workflowCase, platform, inbound, calls: calls.slice(callCursor) });
    }
    const providerRequestCountAfter = await countProviderRequests({ artifactDir });
    const providerRequestsDelta = providerRequestCountAfter - providerRequestCountBefore;
    const providerRequestsAfterEcho = providerRequestCountAfter - providerRequestsBeforeEcho;
    const invariants = evaluateWorkflowCase({
      workflowCase,
      observations,
      providerRequestsDelta,
      providerRequestsAfterEcho
    });
    const failed = invariants.find((invariant) => invariant.status !== "passed") ?? null;
    row = {
      id: workflowCase.id,
      status: failed ? "failed" : "passed",
      summary: `${channelId} ${workflowCase.id} channel workflow ${failed ? "failed" : "passed"}`,
      reason: failed?.reason ?? null,
      workflow: workflowCase.workflow,
      inventoryWorkflow: workflowCase.inventoryWorkflow,
      matrix: workflowCase.matrix,
      userAction: workflowCase.userAction,
      ownerArea: workflowCase.ownerArea ?? `${channelId} adapter/runtime`,
      capabilities: workflowCase.atoms ?? [],
      providerRequestsDelta,
      providerRequestsAfterEcho,
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

function failedRow(workflowCase, reason) {
  return {
    id: workflowCase.id,
    status: "failed",
    summary: `${workflowCase.id} channel workflow failed`,
    reason,
    ownerArea: workflowCase.ownerArea ?? "OpenClaw channel adapter/runtime",
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

function platformSummary(value) {
  return {
    apiRoot: value?.apiRoot ?? null,
    artifactDir: value?.artifactDir ?? null,
    callsPath: value?.callsPath ?? null
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
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
