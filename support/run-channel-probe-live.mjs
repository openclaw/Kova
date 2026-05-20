#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDirectGatewayRpcClient,
  parseSupportArgs,
  prepareOpenClawRuntimeFromOcmEnv,
  readTimeoutMs,
  waitForGatewayMethodOk
} from "./openclaw-runtime.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseSupportArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
const requestedCase = args.case ?? "all";
const continueOnFailure = args["continue-on-failure"] === "true";
const artifactPath = join(artifactDir, `channel-probe-live-${safeArtifactSegment(requestedCase)}.json`);
const workflowCaseCatalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "channel-workflow-cases.json"), "utf8"));
const selectedCases = selectWorkflowCases(workflowCaseCatalog, requestedCase);

async function main() {
  let result;
  let clientHandle = null;
  try {
    const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(envName);
    clientHandle = await openDirectGatewayRpcClient(runtimeContext);
    if (!clientHandle.client) {
      throw new Error(`gateway direct RPC unavailable: ${clientHandle.fallbackReason ?? "unknown"}`);
    }
    await waitForGatewayMethodOk(clientHandle.client, "kova.channelProbe.status", {
      timeoutMs,
      notReadyMessage: "kova channel probe plugin registered but channel runtime is not started",
      timeoutMessage: "timed out waiting for kova channel probe runtime"
    });
    await clientHandle.client.request("kova.channelProbe.reset", {}, { timeoutMs: 5000 });
    const activeStartedAtEpochMs = Date.now();
    const rows = [];
    for (const testCase of selectedCases) {
      rows.push(await runLiveCase(clientHandle.client, testCase));
    }
    const activeFinishedAtEpochMs = Date.now();
    result = buildResult({
      runtimeContext,
      rows,
      error: null,
      activeStartedAtEpochMs,
      activeFinishedAtEpochMs
    });
  } catch (error) {
    result = buildResult({
      runtimeContext: null,
      rows: [],
      error,
      activeStartedAtEpochMs: null,
      activeFinishedAtEpochMs: null
    });
  } finally {
    clientHandle?.client?.close?.();
  }

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "kova.channelCapabilityRun.v1",
    ok: result.ok,
    artifactPath,
    ownerArea: "OpenClaw live channel runtime and adapter",
    proofMode: "workflow-baseline",
    envName,
    case: requestedCase,
    workflowCaseCatalogId: workflowCaseCatalog.id,
    workflowCaseIds: selectedCases.map((testCase) => testCase.id),
    liveCaseCount: result.rows.length,
    capabilities: result.capabilities.map((capability) => ({
      ...capability,
      artifactPath
    })),
    activeStartedAtEpochMs: result.artifact.activeStartedAtEpochMs,
    activeFinishedAtEpochMs: result.artifact.activeFinishedAtEpochMs,
    failedCases: result.rows.filter((row) => row.status !== "passed").map(formatFailedCase)
  }, null, 2)}\n`);
  process.exit(result.ok || continueOnFailure ? 0 : 1);
}

async function runLiveCase(client, testCase) {
  const startedAtEpochMs = Date.now();
  let liveResult = null;
  let observation = null;
  let invariants = [];
  let ok = false;
  try {
    liveResult = await client.request("kova.channelProbe.livePreview", {
      caseId: testCase.id,
      mode: requiredString(testCase.livePreview, "mode"),
      targetId: targetIdForCase(testCase.id),
      text: objectOrEmpty(testCase.expects).text
    }, { timeoutMs });
    observation = liveResult?.observation ?? null;
    invariants = evaluateLiveCase(testCase, observation, liveResult);
    ok = liveResult?.ok === true && invariants.every((item) => item.status === "passed");
  } catch (error) {
    invariants = [
      invariant(`${testCase.id}:runner-error`, false, `${testCase.id} runner failed: ${error instanceof Error ? error.message : String(error)}`)
    ];
  }
  const finishedAtEpochMs = Date.now();
  return {
    id: testCase.id,
    status: ok ? "passed" : "failed",
    reason: ok ? null : (observation?.error ?? invariants.find((item) => item.status !== "passed")?.reason ?? "channel live case failed"),
    workflow: testCase.workflow,
    inventoryWorkflow: testCase.inventoryWorkflow,
    matrix: testCase.matrix,
    userAction: testCase.userAction,
    ownerArea: testCase.ownerArea ?? "OpenClaw live channel runtime and adapter",
    capabilities: testCase.atoms,
    startedAtEpochMs,
    finishedAtEpochMs,
    durationMs: Math.max(0, finishedAtEpochMs - startedAtEpochMs),
    invariants,
    observation
  };
}

function evaluateLiveCase(testCase, observation, liveResult) {
  const expects = objectOrEmpty(testCase.expects);
  const records = liveRecords(observation);
  const kinds = new Set(records.map((record) => record.kind).filter(Boolean));
  const requiredRecords = Array.isArray(expects.liveRecords)
    ? expects.liveRecords.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  const forbiddenRecords = Array.isArray(expects.forbidLiveRecords)
    ? expects.forbidLiveRecords.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  const expectedResultKind = typeof expects.resultKind === "string" ? expects.resultKind : null;
  const expectedPhase = typeof expects.livePhase === "string" ? expects.livePhase : null;

  return [
    invariant(`${testCase.id}:probe-live-ran`, liveResult?.ok === true && Boolean(observation), `${testCase.id} exercised OpenClaw live preview/finalizer runtime`),
    invariant(`${testCase.id}:no-live-error`, !observation?.error, `${testCase.id} completed without live preview/finalizer error`),
    invariant(`${testCase.id}:result-kind`, !expectedResultKind || observation?.resultKind === expectedResultKind, `${testCase.id} produced live result kind ${expectedResultKind ?? "unspecified"}`),
    invariant(`${testCase.id}:live-phase`, !expectedPhase || observation?.liveState?.phase === expectedPhase, `${testCase.id} ended live state phase ${expectedPhase ?? "unspecified"}`),
    ...requiredRecords.map((kind) =>
      invariant(`${testCase.id}:record:${kind}`, kinds.has(kind), `${testCase.id} recorded live operation ${kind}`)
    ),
    ...forbiddenRecords.map((kind) =>
      invariant(`${testCase.id}:no-record:${kind}`, !kinds.has(kind), `${testCase.id} did not record live operation ${kind}`)
    )
  ];
}

function buildResult({ runtimeContext, rows, error, activeStartedAtEpochMs, activeFinishedAtEpochMs }) {
  const runError = error ? error.message : null;
  const capabilities = channelCapabilityRows({ rows, runError, artifactPath });
  return {
    ok: !runError && rows.length === selectedCases.length && rows.every((row) => row.status === "passed"),
    rows,
    capabilities,
    artifact: {
      schemaVersion: "kova.channelProbeLiveArtifact.v1",
      workflowCaseCatalogId: workflowCaseCatalog.id,
      workflowCaseIds: selectedCases.map((testCase) => testCase.id),
      runtimeContext: compactRuntimeContext(runtimeContext),
      error: runError,
      activeStartedAtEpochMs,
      activeFinishedAtEpochMs,
      activeTurnMs: activeStartedAtEpochMs === null || activeFinishedAtEpochMs === null
        ? null
        : Math.max(0, activeFinishedAtEpochMs - activeStartedAtEpochMs),
      rows,
      capabilities
    }
  };
}

function channelCapabilityRows({ rows, runError, artifactPath }) {
  const byCapability = new Map();
  for (const row of rows) {
    for (const atom of row.capabilities ?? []) {
      if (!atom || typeof atom.group !== "string" || typeof atom.id !== "string") {
        continue;
      }
      const key = `${atom.group}:${atom.id}`;
      const existing = byCapability.get(key);
      const status = runError ? "failed" : row.status === "passed" ? "passed" : "failed";
      const reasons = [
        ...(existing?.reasons ?? []),
        ...(status === "passed" ? [] : [`${row.id}: ${row.reason ?? "workflow case failed"}`])
      ];
      byCapability.set(key, {
        channelId: "openclaw",
        group: atom.group,
        capabilityId: atom.id,
        required: true,
        status: existing?.status === "failed" || status === "failed" ? "failed" : "passed",
        proofMode: "workflow-baseline",
        summary: `OpenClaw channel live workflow baseline ${atom.group}/${atom.id}`,
        reason: reasons.length > 0 ? reasons.join("; ") : null,
        ownerArea: row.ownerArea ?? "OpenClaw live channel runtime and adapter",
        artifactPath,
        reasons
      });
    }
  }
  return [...byCapability.values()]
    .sort((left, right) =>
      left.group.localeCompare(right.group) ||
      left.capabilityId.localeCompare(right.capabilityId)
    )
    .map(({ reasons, ...capability }) => capability);
}

function selectWorkflowCases(catalog, requestedCase) {
  const cases = Array.isArray(catalog?.cases)
    ? catalog.cases.map(normalizeWorkflowCase).filter((testCase) => testCase.inventoryWorkflow === "live-preview-finalization")
    : [];
  if (requestedCase === "all") {
    return cases;
  }
  const requestedIds = String(requestedCase).split(",").map((item) => item.trim()).filter(Boolean);
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const selected = requestedIds.map((id) => casesById.get(id)).filter(Boolean);
  if (selected.length !== requestedIds.length) {
    const unknown = requestedIds.filter((id) => !casesById.has(id));
    throw new Error(`unknown channel live workflow case${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return selected;
}

function normalizeWorkflowCase(entry) {
  const id = requiredString(entry, "id");
  return {
    id,
    workflow: requiredString(entry, "workflow"),
    inventoryWorkflow: requiredString(entry, "inventoryWorkflow"),
    matrix: objectOrEmpty(entry.matrix),
    userAction: requiredString(entry, "userAction"),
    ownerArea: typeof entry.ownerArea === "string" ? entry.ownerArea : null,
    livePreview: objectOrEmpty(entry.livePreview),
    expects: objectOrEmpty(entry.expects),
    atoms: Array.isArray(entry.atoms)
      ? entry.atoms.map(normalizeAtom).filter(Boolean)
      : []
  };
}

function normalizeAtom(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const group = typeof value.group === "string" && value.group.length > 0 ? value.group : null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : null;
  return group || id ? { group, id } : null;
}

function formatFailedCase(row) {
  return {
    id: row.id,
    workflow: row.workflow,
    inventoryWorkflow: row.inventoryWorkflow,
    matrix: row.matrix,
    userAction: row.userAction,
    ownerArea: row.ownerArea,
    reason: row.reason,
    capabilities: row.capabilities,
    failedInvariants: row.invariants
      .filter((item) => item.status !== "passed")
      .map((item) => ({
        id: item.id,
        reason: item.reason
      }))
  };
}

function liveRecords(observation) {
  return Array.isArray(observation?.liveRecords) ? observation.liveRecords : [];
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

function targetIdForCase(caseId) {
  const safe = String(caseId ?? "case")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "case";
  return `dm:kova-probe-user-${safe}`;
}

function safeArtifactSegment(value) {
  const raw = String(value ?? "case")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return raw || "case";
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function requiredString(object, key) {
  const value = object?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`channel live workflow field ${key} must be a non-empty string`);
  }
  return value;
}

function invariant(id, condition, summary) {
  return {
    id,
    status: condition ? "passed" : "failed",
    summary,
    reason: condition ? null : summary
  };
}

await main();
