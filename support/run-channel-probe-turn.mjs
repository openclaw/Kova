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
import { readChannelWorkflowCaseCatalogSync } from "./channel-workflow-catalog.mjs";
import { channelWorkflowScript } from "./channel-workflow-provider-script.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = parseSupportArgs(process.argv.slice(2));
const envName = requiredArg(args, "env");
const artifactDir = requiredArg(args, "artifact-dir");
const timeoutMs = readTimeoutMs(args["timeout-ms"], 120000);
const requestedCase = args.case ?? "text-final";
const continueOnFailure = args["continue-on-failure"] === "true";
const artifactPath = join(artifactDir, `channel-probe-turn-${safeArtifactSegment(requestedCase)}.json`);
const providerRequestLogPath = join(artifactDir, "mock-openai", "requests.jsonl");
const providerPortPath = join(artifactDir, "mock-openai", "port");
const workflowCaseCatalog = readChannelWorkflowCaseCatalogSync(repoRoot);
const selectedCases = selectWorkflowCases(workflowCaseCatalog, requestedCase);

async function main() {
  let result;
  let clientHandle = null;
  const providerRequestCountBefore = await countJsonl(providerRequestLogPath);
  try {
    const runtimeContext = prepareOpenClawRuntimeFromOcmEnv(envName);
    clientHandle = await openDirectGatewayRpcClient(runtimeContext);
    await waitForGatewayMethodOk(clientHandle.client, "kova.channelProbe.status", {
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
    proofMode: "workflow-baseline",
    envName,
    case: requestedCase,
    workflowCaseCatalogId: workflowCaseCatalog.id,
    workflowCaseIds: selectedCases.map((testCase) => testCase.id),
    modelTurnCaseCount: result.rows.length,
    capabilities: result.capabilities.map((capability) => ({
      ...capability,
      artifactPath
    })),
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
    ackPolicy: typeof testCase.receiveAckPolicy === "string" ? testCase.receiveAckPolicy : undefined,
    manualAck: expects.ackStage === "manual",
    requiredCapabilities: objectOrEmpty(testCase.requiredCapabilities),
    sourceReplyDeliveryMode: typeof testCase.sourceReplyDeliveryMode === "string" ? testCase.sourceReplyDeliveryMode : undefined,
    botLoopProtection: expects.noSelfTrigger === true
      ? createBotEchoProtection(testCase, inboundEventId, targetIdForCase(testCase.id)).firstTurnProtection
      : undefined
  };
  const botEcho = expects.noSelfTrigger === true
    ? createBotEchoProtection(testCase, inboundEventId, params.targetId)
    : null;
  const startedAtEpochMs = Date.now();
  let injectResult = null;
  let observation = null;
  let invariants = [];
  let ok = false;
  const fixturePaths = mediaFixturePaths(testCase);
  try {
    await replaceMockProviderScriptForCase(testCase);
    for (const fixturePath of fixturePaths) {
      writeMediaFixture(fixturePath);
    }
    injectResult = await client.request("kova.channelProbe.inject", params, { timeoutMs });
    observation = injectResult?.observation ?? null;
    observation = await waitForProbeObservation(client, testCase, inboundEventId, observation);
    if (botEcho) {
      const selfTriggerObservation = await runBotEchoProbe(client, testCase, botEcho, observation);
      observation = await readLatestProbeObservation(client, inboundEventId, observation);
      observation = {
        ...observation,
        selfTriggerObservation
      };
    }
    invariants = evaluateCase(testCase, observation, injectResult);
    ok = injectResult?.ok === true && invariants.every((item) => item.status === "passed");
  } catch (error) {
    invariants = [
      invariant(`${testCase.id}:runner-error`, false, `${testCase.id} runner failed: ${error instanceof Error ? error.message : String(error)}`)
    ];
  } finally {
    for (const fixturePath of fixturePaths) {
      removeMediaFixture(fixturePath);
    }
  }
  const finishedAtEpochMs = Date.now();
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

async function replaceMockProviderScriptForCase(testCase) {
  const port = await readProviderPort();
  const script = channelWorkflowScript([testCase.id], repoRoot);
  const response = await fetch(`http://127.0.0.1:${port}/admin/script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...script,
      id: `kova-channel-workflow:${testCase.id}`
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`mock provider script reset failed for ${testCase.id}: ${response.status} ${text}`);
  }
}

async function readProviderPort() {
  try {
    const raw = (await readFile(providerPortPath, "utf8")).trim();
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
    throw new Error(`invalid mock provider port file ${providerPortPath}: ${raw}`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`mock provider port file is missing: ${providerPortPath}`);
    }
    throw error;
  }
}

async function runBotEchoProbe(client, testCase, botEcho, firstObservation) {
  const firstText = finalOutboundRecords(firstObservation)
    .map((record) => record.text)
    .find((text) => typeof text === "string" && text.trim().length > 0);
  const expects = objectOrEmpty(testCase.expects);
  const echoResult = await client.request("kova.channelProbe.inject", {
    inboundEventId: botEcho.inboundEventId,
    message: firstText ?? expects.text ?? "KOVA_SELF_TRIGGER_ECHO",
    targetId: botEcho.targetId,
    replyToId: botEcho.inboundEventId,
    threadId: typeof expects.threadId === "string" ? expects.threadId : undefined,
    silent: false,
    sourceReplyDeliveryMode: typeof testCase.sourceReplyDeliveryMode === "string" ? testCase.sourceReplyDeliveryMode : undefined,
    from: botEcho.senderId,
    senderId: botEcho.senderId,
    senderName: "Kova Echo Bot",
    botLoopProtection: botEcho.echoProtection
  }, { timeoutMs });
  return echoResult?.observation ?? null;
}

function createBotEchoProtection(testCase, inboundEventId, targetId) {
  const senderId = "kova-probe-echo-bot";
  const receiverId = "kova-probe-user";
  const scopeId = `kova-self-trigger:${testCase.id}:${inboundEventId}`;
  const config = {
    maxEventsPerWindow: 1,
    windowSeconds: 60,
    cooldownSeconds: 60
  };
  return {
    inboundEventId: `${inboundEventId}:bot-echo`,
    targetId,
    senderId,
    firstTurnProtection: {
      scopeId,
      conversationId: targetId,
      senderId: receiverId,
      receiverId: senderId,
      config,
      defaultEnabled: true,
      nowMs: 1_000
    },
    echoProtection: {
      scopeId,
      conversationId: targetId,
      senderId,
      receiverId,
      config,
      defaultEnabled: true,
      nowMs: 1_001
    }
  };
}

async function waitForProbeObservation(client, testCase, inboundEventId, initialObservation) {
  if (!requiresObservationWait(testCase)) {
    return initialObservation;
  }
  const timeoutMs = asyncObservationTimeoutMs(testCase);
  const startedAt = Date.now();
  let latest = initialObservation;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await readLatestProbeObservation(client, inboundEventId, latest);
    if (observationSatisfiesWait(testCase, latest)) {
      return latest;
    }
    await sleep(100);
  }
  return await readLatestProbeObservation(client, inboundEventId, latest);
}

async function readLatestProbeObservation(client, inboundEventId, priorObservation) {
  const result = await client.request("kova.channelProbe.observations", {}, { timeoutMs: 5000 });
  const observations = Array.isArray(result?.observations) ? result.observations : [];
  return observations.find((observation) => observation?.inboundEvent?.id === inboundEventId) ?? priorObservation;
}

function requiresObservationWait(testCase) {
  const matrix = objectOrEmpty(testCase.matrix);
  return matrix.lifecycle === "async-completion" ||
    matrix.delivery === "background-completion" ||
    matrix.delivery === "completion-handoff";
}

function asyncObservationTimeoutMs(testCase) {
  const value = objectOrEmpty(testCase.expects).asyncCompletionTimeoutMs;
  return Number.isInteger(value) && value > 0 ? value : 15000;
}

function observationSatisfiesWait(testCase, observation) {
  const expects = objectOrEmpty(testCase.expects);
  const policy = normalizeVisibleDeliveries(expects.visibleDeliveries);
  const records = finalOutboundRecords(observation);
  const countSatisfied = policy.mode === "exact"
    ? records.length >= policy.expected
    : records.length > 0;
  if (!countSatisfied) {
    return false;
  }
  if (expects.kind && !records.some((record) => record.kind === expects.kind)) {
    return false;
  }
  return mediaSourceExpectation(testCase).check(records);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateCase(testCase, observation, injectResult) {
  const expects = objectOrEmpty(testCase.expects);
  const finalRecords = finalOutboundRecords(observation);
  const finalTexts = finalRecords
    .map((record) => record.text)
    .filter((text) => typeof text === "string" && text.length > 0);
  const firstFinal = finalRecords[0] ?? null;
  const selfTriggerObservation = observation?.selfTriggerObservation ?? null;
  const visibleDeliveryPolicy = normalizeVisibleDeliveries(expects.visibleDeliveries);
  const expectedText = typeof expects.text === "string" ? expects.text : null;
  const mediaExpectation = mediaSourceExpectation(testCase);
  const modelDispatchStarts = modelTurnRecords(observation).filter((record) => record.stage === "dispatch" && record.event === "start");
  const modelDispatchDones = modelTurnRecords(observation).filter((record) => record.stage === "dispatch" && record.event === "done");
  const modelDispatchTerminals = modelTurnRecords(observation).filter((record) => record.stage === "dispatch" && (record.event === "done" || record.event === "error"));
  const modelRecordStarts = modelTurnRecords(observation).filter((record) => record.stage === "record" && record.event === "start");
  const modelRecordDones = modelTurnRecords(observation).filter((record) => record.stage === "record" && record.event === "done");
  const modelRecordTerminals = modelTurnRecords(observation).filter((record) => record.stage === "record" && (record.event === "done" || record.event === "error"));
  const selfTriggerDispatchStarts = modelTurnRecords(selfTriggerObservation).filter((record) => record.stage === "dispatch" && record.event === "start");
  const selfTriggerVisibleDeliveries = finalOutboundRecords(selfTriggerObservation);
  const selfTriggerDropped = selfTriggerObservation?.admission?.kind === "drop" &&
    selfTriggerObservation?.admission?.reason === "bot-loop-protection";
  const unhandledDeliveries = unhandledDeliveryRecords(observation);
  const ackRecords = receiveAckRecords(observation);
  const expectedAckPolicy = typeof testCase.receiveAckPolicy === "string" ? testCase.receiveAckPolicy : null;
  const expectedAckStage = typeof expects.ackStage === "string" ? expects.ackStage : null;

  return [
    invariant(`${testCase.id}:probe-injected`, injectResult?.ok === true && Boolean(observation), `${testCase.id} injected one inbound user event through the channel probe`),
    invariant(`${testCase.id}:no-probe-error`, !observation?.error, `${testCase.id} completed without probe or OpenClaw transport error`),
    invariant(`${testCase.id}:durable-handled`, unhandledDeliveries.length === 0, `${testCase.id} had every final durable delivery handled by OpenClaw; unhandled ${unhandledDeliveries.length}`),
    invariant(`${testCase.id}:turn-dispatched`, observation?.dispatched === true, `${testCase.id} dispatched through the OpenClaw runtime`),
    finalDeliveryInvariant(testCase.id, visibleDeliveryPolicy, finalRecords.length),
    invariant(`${testCase.id}:expected-kind`, expectedKindMatches(expects.kind, finalRecords), `${testCase.id} produced the expected visible delivery kind`),
    invariant(`${testCase.id}:expected-text`, !expectedText || finalTexts.some((text) => textEquals(text, expectedText)), `${testCase.id} produced the expected visible text`),
    invariant(`${testCase.id}:channel-data`, !isJsonObject(expects.channelData) || jsonEqual(firstFinal?.payload?.channelData, expects.channelData), `${testCase.id} preserved structured channel payload data`),
    invariant(`${testCase.id}:error-final`, expects.errorFinal !== true || (firstFinal?.isError === true || finalTexts.some((text) => text.trim().length > 0)), `${testCase.id} delivered one user-visible error response`),
    invariant(`${testCase.id}:receipt`, visibleDeliveryPolicy.expected === 0 || visibleDeliveryPolicy.mode === "observe" || hasReceipt(finalRecords, observation), `${testCase.id} recorded a receipt for required visible delivery`),
    invariant(`${testCase.id}:reply-target`, expects.replyTo !== "inbound-message" || firstFinal?.replyToId === observation?.inboundEvent?.id, `${testCase.id} preserved the inbound reply target`),
    invariant(`${testCase.id}:no-reply-target`, expects.replyTo !== "none" || firstFinal?.replyToId == null, `${testCase.id} did not attach a reply target`),
    invariant(`${testCase.id}:thread-target`, typeof expects.threadId !== "string" || firstFinal?.threadId === expects.threadId, `${testCase.id} preserved the thread target`),
    invariant(`${testCase.id}:silent`, expects.silent !== true || firstFinal?.silent === true, `${testCase.id} preserved silent delivery intent`),
    invariant(`${testCase.id}:media`, mediaExpectation.check(finalRecords), mediaExpectation.summary),
    invariant(`${testCase.id}:unique-media`, !hasMediaExpectation(testCase) || hasUniqueFinalMedia(finalRecords), `${testCase.id} did not deliver the same media item more than once`),
    invariant(`${testCase.id}:single-final`, expects.allowMultipleFinalSends === true || finalRecords.length <= 1, `${testCase.id} did not duplicate final visible delivery`),
    invariant(`${testCase.id}:single-inbound-turn`, modelDispatchStarts.length === 1, `${testCase.id} processed exactly one OpenClaw model turn for one user input; observed ${modelDispatchStarts.length}`),
    invariant(`${testCase.id}:record-terminal`, modelRecordStarts.length === modelRecordTerminals.length, `${testCase.id} closed every recorded OpenClaw model turn; starts ${modelRecordStarts.length}, terminal ${modelRecordTerminals.length}`),
    invariant(`${testCase.id}:dispatch-terminal`, modelDispatchStarts.length === modelDispatchTerminals.length, `${testCase.id} closed every dispatched OpenClaw model turn; starts ${modelDispatchStarts.length}, terminal ${modelDispatchTerminals.length}`),
    invariant(`${testCase.id}:ack-policy`, !expectedAckPolicy || ackRecords.some((record) => record.kind === "receive-context" && record.policy === expectedAckPolicy), `${testCase.id} created a receive context with ack policy ${expectedAckPolicy ?? "unspecified"}`),
    invariant(`${testCase.id}:ack-stage`, !expectedAckStage || ackRecords.some((record) => record.kind === "ack-stage" && record.stage === expectedAckStage && record.state === "acked"), `${testCase.id} acknowledged the inbound event at ${expectedAckStage ?? "unspecified"} stage`),
    invariant(`${testCase.id}:no-self-trigger`, expects.noSelfTrigger !== true || (selfTriggerDropped && selfTriggerDispatchStarts.length === 0 && selfTriggerVisibleDeliveries.length === 0), `${testCase.id} suppressed bot-authored echo before a second model turn or visible delivery`),
    invariant(`${testCase.id}:no-openclaw-error`, observation?.error == null, `${testCase.id} finished without an OpenClaw turn error`)
  ];
}

function selectWorkflowCases(catalog, requestedCase) {
  const cases = Array.isArray(catalog?.cases) ? catalog.cases.map(normalizeWorkflowCase) : [];
  if (requestedCase === "all") {
    return cases;
  }
  const requestedIds = String(requestedCase).split(",").map((item) => item.trim()).filter(Boolean);
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const selected = requestedIds.map((id) => casesById.get(id)).filter(Boolean);
  if (selected.length !== requestedIds.length) {
    const unknown = requestedIds.filter((id) => !casesById.has(id));
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
    receiveAckPolicy: typeof entry.receiveAckPolicy === "string" ? entry.receiveAckPolicy : null,
    requiredCapabilities: objectOrEmpty(entry.requiredCapabilities),
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
  if (!Array.isArray(observation?.outboundRecords)) {
    return [];
  }
  const records = observation.outboundRecords.filter(isVisibleOutboundRecord);
  const concreteRecords = records.filter((record) => record?.deliveryKind !== "block");
  return concreteRecords.length > 0 ? concreteRecords : records;
}

function isVisibleOutboundRecord(record) {
  return record?.kind === "text" || record?.kind === "media" || record?.kind === "payload";
}

function expectedKindMatches(expectedKind, records) {
  if (!expectedKind) {
    return records.length > 0;
  }
  if (expectedKind === "payload") {
    return records.length > 0;
  }
  return records.some((record) => record?.kind === expectedKind);
}

function modelTurnRecords(observation) {
  return Array.isArray(observation?.modelTurnRecords) ? observation.modelTurnRecords : [];
}

function unhandledDeliveryRecords(observation) {
  return Array.isArray(observation?.deliveryRecords)
    ? observation.deliveryRecords.filter((record) => record?.path === "unhandled-channel-delivery")
    : [];
}

function receiveAckRecords(observation) {
  return Array.isArray(observation?.ackRecords) ? observation.ackRecords : [];
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

function isJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
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
  const capabilities = channelCapabilityRows({
    rows,
    runError,
    artifactPath
  });
  return {
    ok: !runError && rows.length === selectedCases.length && rows.every((row) => row.status === "passed") && invariants.every((item) => item.status === "passed"),
    rows,
    capabilities,
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
      capabilities,
      observations,
      invariants
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
        summary: `OpenClaw channel workflow baseline ${atom.group}/${atom.id}`,
        reason: reasons.length > 0 ? reasons.join("; ") : null,
        ownerArea: row.ownerArea ?? "OpenClaw",
        artifactPath,
        workflowCaseIds: [
          ...(existing?.workflowCaseIds ?? []),
          row.id
        ],
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
