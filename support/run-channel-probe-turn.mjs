#!/usr/bin/env node
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
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
const requestedCase = args.case ?? "text-final";
const continueOnFailure = args["continue-on-failure"] === "true";
const artifactPath = join(artifactDir, `channel-probe-turn-${safeArtifactSegment(requestedCase)}.json`);
const providerRequestLogPath = join(artifactDir, "mock-openai", "requests.jsonl");
const workflowCaseCatalog = JSON.parse(await readFile(join(repoRoot, "channel-capabilities", "channel-workflow-cases.json"), "utf8"));
const selectedCases = selectWorkflowCases(workflowCaseCatalog, requestedCase);

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
    await waitForGatewayMethodOk(clientHandle.client, "kova.channelBaseline.status", {
      timeoutMs,
      notReadyMessage: "kova channel probe plugin registered but channel runtime is not started",
      timeoutMessage: "timed out waiting for kova channel probe runtime"
    });
    await clientHandle.client.request("kova.channelProbe.reset", {}, { timeoutMs: 5000 });
    const activeStartedAtEpochMs = Date.now();
    const rows = [];
    for (const testCase of selectedCases) {
      rows.push(await runProbeCase(clientHandle.client, testCase));
    }
    const activeFinishedAtEpochMs = Date.now();
    const observationsResult = await clientHandle.client.request("kova.channelProbe.observations", {}, { timeoutMs: 5000 });
    const providerRequestCountAfter = await countJsonl(providerRequestLogPath);
    result = buildResult({
      runtimeContext,
      rows,
      observations: observationsResult?.observations ?? [],
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
      rows: [],
      observations: [],
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
    schemaVersion: "kova.channelProbeTurnRun.v1",
    ok: result.ok,
    artifactPath,
    ownerArea: "OpenClaw",
    envName,
    case: requestedCase,
    workflowCaseCatalogId: workflowCaseCatalog.id,
    workflowCaseIds: selectedCases.map((testCase) => testCase.id),
    modelTurnCaseCount: result.rows.length,
    activeStartedAtEpochMs: result.artifact.activeStartedAtEpochMs,
    activeFinishedAtEpochMs: result.artifact.activeFinishedAtEpochMs,
    failedModelTurnCases: result.rows
      .filter((row) => row.status !== "passed")
      .map(formatFailedCase),
    failedCases: result.rows
      .filter((row) => row.status !== "passed")
      .map(formatFailedCase),
    providerRequestDelta: result.artifact.providerRequestDelta,
    activeTurnMs: result.artifact.activeTurnMs
  }, null, 2)}\n`);
  process.exit(result.ok || continueOnFailure ? 0 : 1);
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

async function runProbeCase(client, testCase) {
  const inboundEventId = `kova-probe-${testCase.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const expects = objectOrEmpty(testCase.expects);
  const params = {
    inboundEventId,
    message: testCase.prompt,
    targetId: targetIdForCase(testCase.id),
    replyToId: expects.replyTo === "inbound-message" ? inboundEventId : null,
    threadId: typeof expects.threadId === "string" ? expects.threadId : undefined,
    silent: expects.silent === true,
    sourceReplyDeliveryMode: typeof testCase.sourceReplyDeliveryMode === "string" ? testCase.sourceReplyDeliveryMode : undefined
  };
  const startedAtEpochMs = Date.now();
  let injectResult = null;
  try {
    for (const fixturePath of mediaFixturePaths(testCase)) {
      writeMediaFixture(fixturePath);
    }
    injectResult = await client.request("kova.channelProbe.inject", params, { timeoutMs });
  } finally {
    for (const fixturePath of mediaFixturePaths(testCase)) {
      removeMediaFixture(fixturePath);
    }
  }
  const finishedAtEpochMs = Date.now();
  const observation = injectResult?.observation ?? null;
  const invariants = evaluateCase(testCase, observation, injectResult);
  const ok = injectResult?.ok === true && invariants.every((item) => item.status === "passed");
  return {
    id: testCase.id,
    status: ok ? "passed" : "failed",
    reason: ok ? null : (observation?.error ?? invariants.find((item) => item.status !== "passed")?.reason ?? "channel probe case failed"),
    workflow: testCase.workflow,
    inventoryWorkflow: testCase.inventoryWorkflow,
    matrix: testCase.matrix,
    userAction: testCase.userAction,
    ownerArea: testCase.ownerArea ?? "OpenClaw",
    capabilities: testCase.atoms,
    inboundEventId,
    startedAtEpochMs,
    finishedAtEpochMs,
    durationMs: Math.max(0, finishedAtEpochMs - startedAtEpochMs),
    invariants,
    observation
  };
}

function evaluateCase(testCase, observation, injectResult) {
  const expects = objectOrEmpty(testCase.expects);
  const finalRecords = finalOutboundRecords(observation);
  const finalTexts = finalRecords
    .map((record) => record.text)
    .filter((text) => typeof text === "string" && text.length > 0);
  const firstFinal = finalRecords[0] ?? null;
  const visibleDeliveryPolicy = normalizeVisibleDeliveries(expects.visibleDeliveries);
  const expectedText = typeof expects.text === "string" ? expects.text : null;
  const mediaExpectation = mediaSourceExpectation(testCase);
  const modelDispatchStarts = modelTurnRecords(observation).filter((record) => record.stage === "dispatch" && record.event === "start");
  const modelDispatchDones = modelTurnRecords(observation).filter((record) => record.stage === "dispatch" && record.event === "done");
  const modelRecordStarts = modelTurnRecords(observation).filter((record) => record.stage === "record" && record.event === "start");
  const modelRecordDones = modelTurnRecords(observation).filter((record) => record.stage === "record" && record.event === "done");

  return [
    invariant(`${testCase.id}:probe-injected`, injectResult?.ok === true && Boolean(observation), `${testCase.id} injected one inbound user event through the channel probe`),
    invariant(`${testCase.id}:no-probe-error`, !observation?.error, `${testCase.id} completed without probe or OpenClaw transport error`),
    invariant(`${testCase.id}:turn-dispatched`, observation?.dispatched === true, `${testCase.id} dispatched through the OpenClaw runtime`),
    finalDeliveryInvariant(testCase.id, visibleDeliveryPolicy, finalRecords.length),
    invariant(`${testCase.id}:expected-kind`, !expects.kind || firstFinal?.kind === expects.kind, `${testCase.id} produced the expected visible delivery kind`),
    invariant(`${testCase.id}:expected-text`, !expectedText || finalTexts.some((text) => textEquals(text, expectedText)), `${testCase.id} produced the expected visible text`),
    invariant(`${testCase.id}:receipt`, visibleDeliveryPolicy.expected === 0 || visibleDeliveryPolicy.mode === "observe" || hasReceipt(finalRecords, observation), `${testCase.id} recorded a receipt for required visible delivery`),
    invariant(`${testCase.id}:reply-target`, expects.replyTo !== "inbound-message" || firstFinal?.replyToId === observation?.inboundEvent?.id, `${testCase.id} preserved the inbound reply target`),
    invariant(`${testCase.id}:no-reply-target`, expects.replyTo !== "none" || firstFinal?.replyToId == null, `${testCase.id} did not attach a reply target`),
    invariant(`${testCase.id}:thread-target`, typeof expects.threadId !== "string" || firstFinal?.threadId === expects.threadId, `${testCase.id} preserved the thread target`),
    invariant(`${testCase.id}:silent`, expects.silent !== true || firstFinal?.silent === true, `${testCase.id} preserved silent delivery intent`),
    invariant(`${testCase.id}:media`, mediaExpectation.check(finalRecords), mediaExpectation.summary),
    invariant(`${testCase.id}:unique-media`, !hasMediaExpectation(testCase) || hasUniqueFinalMedia(finalRecords), `${testCase.id} did not deliver the same media item more than once`),
    invariant(`${testCase.id}:single-final`, expects.allowMultipleFinalSends === true || finalRecords.length <= 1, `${testCase.id} did not duplicate final visible delivery`),
    invariant(`${testCase.id}:single-inbound-turn`, modelDispatchStarts.length === 1, `${testCase.id} processed exactly one OpenClaw model turn for one user input; observed ${modelDispatchStarts.length}`),
    invariant(`${testCase.id}:record-terminal`, modelRecordStarts.length === modelRecordDones.length, `${testCase.id} closed every recorded OpenClaw model turn; starts ${modelRecordStarts.length}, done ${modelRecordDones.length}`),
    invariant(`${testCase.id}:dispatch-terminal`, modelDispatchStarts.length === modelDispatchDones.length, `${testCase.id} closed every dispatched OpenClaw model turn; starts ${modelDispatchStarts.length}, done ${modelDispatchDones.length}`)
  ];
}

function selectWorkflowCases(catalog, requestedCase) {
  const cases = Array.isArray(catalog?.cases) ? catalog.cases.map(normalizeWorkflowCase) : [];
  if (requestedCase === "all") {
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
  const id = requiredString(entry, "id");
  const prompt = requiredString(entry, "prompt");
  const expects = objectOrEmpty(entry.expects);
  return {
    id,
    workflow: requiredString(entry, "workflow"),
    inventoryWorkflow: requiredString(entry, "inventoryWorkflow"),
    matrix: objectOrEmpty(entry.matrix),
    userAction: requiredString(entry, "userAction"),
    ownerArea: typeof entry.ownerArea === "string" ? entry.ownerArea : null,
    prompt,
    sourceReplyDeliveryMode: typeof entry.sourceReplyDeliveryMode === "string" ? entry.sourceReplyDeliveryMode : null,
    expects,
    fixtures: objectOrEmpty(entry.fixtures),
    providerRequests: objectOrEmpty(entry.providerRequests),
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

function finalOutboundRecords(observation) {
  return Array.isArray(observation?.outboundRecords)
    ? observation.outboundRecords.filter((record) => record?.kind === "text" || record?.kind === "media" || record?.kind === "payload")
    : [];
}

function modelTurnRecords(observation) {
  return Array.isArray(observation?.modelTurnRecords) ? observation.modelTurnRecords : [];
}

function normalizeVisibleDeliveries(value) {
  if (Number.isInteger(value) && value >= 0) {
    return { mode: "exact", expected: value };
  }
  return { mode: "observe" };
}

function finalDeliveryInvariant(caseId, policy, observed) {
  if (policy.mode === "exact") {
    return invariant(
      `${caseId}:visible-delivery-count`,
      observed === policy.expected,
      `${caseId} produced exactly ${policy.expected} visible deliver${policy.expected === 1 ? "y" : "ies"}; observed ${observed}`
    );
  }
  return invariant(
    `${caseId}:visible-delivery-observed`,
    observed > 0,
    `${caseId} produced at least one visible delivery; observed ${observed}`
  );
}

function hasReceipt(finalRecords, observation) {
  return finalRecords.some((record) => typeof record.messageId === "string" && record.messageId.length > 0) ||
    (Array.isArray(observation?.deliveryRecords) && observation.deliveryRecords.some((record) =>
      Array.isArray(record?.messageIds) && record.messageIds.length > 0
    ));
}

function mediaSourceExpectation(testCase) {
  const expects = objectOrEmpty(testCase.expects);
  const sources = [];
  if (typeof expects.mediaSource === "string" && expects.mediaSource.length > 0) {
    sources.push(expects.mediaSource);
  }
  if (Array.isArray(expects.mediaSources)) {
    for (const source of expects.mediaSources) {
      if (typeof source === "string" && source.length > 0) {
        sources.push(source);
      }
    }
  }
  if (sources.length === 0) {
    return {
      check: () => true,
      summary: `${testCase.id} has no media source expectation`
    };
  }
  if (expects.mediaSourcePolicy === "exact") {
    return {
      check: (records) => sources.every((source) =>
        records.some((record) => isManagedOutboundMedia(record?.mediaUrl, source) || isSameExistingLocalMedia(record, source))
      ),
      summary: `${testCase.id} delivered every expected exact media source`
    };
  }
  return {
    check: (records) => records.some(hasPresentMedia),
    summary: `${testCase.id} delivered present media to the channel send path`
  };
}

function hasMediaExpectation(testCase) {
  const expects = objectOrEmpty(testCase.expects);
  return typeof expects.mediaSource === "string" ||
    (Array.isArray(expects.mediaSources) && expects.mediaSources.length > 0);
}

function hasUniqueFinalMedia(records) {
  const mediaUrls = records
    .flatMap((record) => Array.isArray(record.mediaUrls) && record.mediaUrls.length > 0 ? record.mediaUrls : [record.mediaUrl])
    .filter((mediaUrl) => typeof mediaUrl === "string" && mediaUrl.length > 0);
  return mediaUrls.length === new Set(mediaUrls).size;
}

function hasPresentMedia(record) {
  const mediaUrls = Array.isArray(record?.mediaUrls) && record.mediaUrls.length > 0
    ? record.mediaUrls
    : [record?.mediaUrl];
  return mediaUrls.some((mediaUrl) =>
    typeof mediaUrl === "string" &&
    mediaUrl.length > 0 &&
    (/^https?:\/\//i.test(mediaUrl) || existsSync(mediaUrl))
  );
}

function isManagedOutboundMedia(mediaUrl, sourcePath) {
  if (typeof mediaUrl !== "string" || mediaUrl.length === 0) {
    return false;
  }
  const normalizedMediaUrl = mediaUrl.replaceAll("\\", "/");
  if (!normalizedMediaUrl.includes("/.openclaw/media/outbound/") || !existsSync(mediaUrl)) {
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

function isSameExistingLocalMedia(record, sourcePath) {
  return record?.mediaUrl === sourcePath && record.mediaPathExists === true;
}

function mediaFixturePaths(testCase) {
  const fixtures = objectOrEmpty(testCase.fixtures);
  const paths = [];
  if (typeof fixtures.mediaPath === "string" && fixtures.mediaPath.length > 0) {
    paths.push(fixtures.mediaPath);
  }
  if (Array.isArray(fixtures.mediaPaths)) {
    for (const fixturePath of fixtures.mediaPaths) {
      if (typeof fixturePath === "string" && fixturePath.length > 0 && !paths.includes(fixturePath)) {
        paths.push(fixturePath);
      }
    }
  }
  return paths;
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
    // Best-effort cleanup for temporary local media fixtures.
  }
}

function textEquals(actual, expected) {
  return normalizeText(actual) === normalizeText(expected);
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function invariant(id, condition, summary) {
  return {
    id,
    status: condition ? "passed" : "failed",
    summary,
    reason: condition ? null : summary
  };
}

function buildResult({
  runtimeContext,
  rows,
  observations,
  error,
  providerRequestCountBefore,
  providerRequestCountAfter,
  activeStartedAtEpochMs = null,
  activeFinishedAtEpochMs = null,
  timeoutMs: commandTimeoutMs
}) {
  const runError = error ? error.message : null;
  const providerRequestDelta = Math.max(0, providerRequestCountAfter - providerRequestCountBefore);
  const activeTurnMs = activeStartedAtEpochMs === null || activeFinishedAtEpochMs === null
    ? null
    : Math.max(0, activeFinishedAtEpochMs - activeStartedAtEpochMs);
  const invariants = [
    providerRequestInvariant(selectedCases, providerRequestDelta, runError),
    invariant("no-global-error", !runError, "channel probe turn completed without runner or Gateway error")
  ];
  return {
    ok: !runError && rows.length === selectedCases.length && rows.every((row) => row.status === "passed") && invariants.every((item) => item.status === "passed"),
    rows,
    artifact: {
      schemaVersion: "kova.channelProbeTurnArtifact.v1",
      workflowCaseCatalogId: workflowCaseCatalog.id,
      workflowCaseIds: selectedCases.map((testCase) => testCase.id),
      runtimeContext: compactRuntimeContext(runtimeContext),
      timeoutMs: commandTimeoutMs,
      error: runError,
      providerRequestLogPath,
      providerRequestCountBefore,
      providerRequestCountAfter,
      providerRequestDelta,
      activeStartedAtEpochMs,
      activeFinishedAtEpochMs,
      activeTurnMs,
      rows,
      observations,
      invariants
    }
  };
}

function providerRequestInvariant(cases, observed, runError) {
  if (runError) {
    return invariant("provider-request-count", false, `provider request count unavailable because run failed: ${runError}`);
  }
  const minimum = cases.reduce((total, testCase) => {
    const policy = objectOrEmpty(testCase.providerRequests);
    return policy.mode === "minimum" && Number.isInteger(policy.min) ? total + policy.min : total;
  }, 0);
  if (minimum > 0) {
    return invariant("provider-request-count", observed >= minimum, `channel probe turn made at least ${minimum} mock provider request${minimum === 1 ? "" : "s"}; observed ${observed}`);
  }
  return invariant("provider-request-count-observed", true, `channel probe turn provider request count observed without gating; observed ${observed}`);
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

function targetIdForCase(caseId) {
  const safe = String(caseId ?? "case")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "case";
  return `dm:kova-probe-user-${safe}`;
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

function requiredArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function safeArtifactSegment(value) {
  const safe = String(value ?? "all").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return safe.length > 120 ? `${safe.slice(0, 100)}-${hashString(safe)}` : safe;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

await main();
