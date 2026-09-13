import { buildAgentCliPreProviderAttribution } from "../collectors/agent-cli-attribution.mjs";
import { buildAgentTurnBreakdown } from "../collectors/agent-turns.mjs";
import { buildGatewaySessionPreProviderAttribution } from "../collectors/gateway-session-turn-attribution.mjs";
import { computeProviderTurnAttribution } from "../collectors/provider.mjs";
import { commandResultPassed, isAgentCliMessageCommand, isAgentMessageCommand } from "../measurement-contract.mjs";
import { countPostStartupHealthFailures, postStartupHealthFailureBreakdown } from "./health.mjs";
import { collectResults, isStatusCommand } from "./records.mjs";
import {
  delta,
  findFirstString,
  findPayloadText,
  isoOrNull,
  maxNullable,
  numberOrNull,
  parseJsonObject,
  roundNumber
} from "./shared.mjs";
import { checkAggregateThreshold, checkTurnThreshold } from "./violations.mjs";

const PROVIDER_RECOVERY_MODES = new Set(["error-then-recover", "disconnect-then-recover"]);

export function collectAgentTurns(record, providerEvidence, scenario, timelineSummary, logSummary) {
  const turns = [];
  let index = 0;
  const scenarioExpectedText = scenario.agent?.expectedText ?? null;
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (!isAgentMessageCommand(result.command)) {
        continue;
      }
      index += 1;
      const expectedFailure = phase.expectedAgentFailure === true || scenario.agent?.expectedFailure === true;
      const gatewaySession = extractGatewaySessionTurn(result);
      const channelModelTurn = gatewaySession ? null : extractChannelModelTurn(result);
      const expectedText = channelModelTurn ? channelModelTurn.expectedText : scenarioExpectedText;
      const timingResult = gatewaySession
        ? resultForActiveTurnWindow(result, gatewaySession)
        : (channelModelTurn ? resultForChannelModelTurnWindow(result, channelModelTurn) : result);
      const attribution = computeProviderTurnAttribution(timingResult, providerEvidence);
      const response = extractAgentResponse(result);
      const expectedTextPresent = typeof expectedText === "string" && expectedText.length > 0
        ? responseMatchesExpectedText(response, expectedText)
        : null;
      const commandPassed = commandResultPassed(result) && result.timedOut !== true;
      const expectedFailureObserved = expectedFailure === true && commandPassed;
      const normalResponseOk = channelModelTurn
        ? commandPassed
        : commandPassed && response.usable === true && (expectedTextPresent !== false);
      const isAgentCliTurn = isAgentCliMessageCommand(result.command);
      const phaseBreakdown = buildAgentTurnBreakdown({ result: timingResult, attribution, timelineSummary, logSummary });
      const turnDiagnostics = summarizeActiveTurnDiagnostics({
        timelineSummary,
        activeStartedAtEpochMs: timingResult.startedAtEpochMs,
        activeFinishedAtEpochMs: timingResult.finishedAtEpochMs,
        gatewaySession
      });
      const gatewaySessionPreProviderAttribution = gatewaySession
        ? buildGatewaySessionPreProviderAttribution({
            label: agentTurnLabel(phase.id, index),
            phaseId: phase.id,
            activeStartedAtEpochMs: timingResult.startedAtEpochMs,
            activeFinishedAtEpochMs: timingResult.finishedAtEpochMs,
            attribution,
            timelineSummary
          })
        : null;
      const agentCliPreProviderAttribution = isAgentCliTurn
        ? buildAgentCliPreProviderAttribution({
            label: agentTurnLabel(phase.id, index),
            phaseId: phase.id,
            activeStartedAtEpochMs: timingResult.startedAtEpochMs,
            activeFinishedAtEpochMs: timingResult.finishedAtEpochMs,
            attribution,
            timelineSummary
          })
        : null;
      turns.push({
        schemaVersion: "kova.agentTurnEvidence.v1",
        index,
        phaseId: phase.id,
        label: agentTurnLabel(phase.id, index),
        expectedFailure,
        expectedFailureObserved,
        command: result.command,
        status: result.status,
        timedOut: result.timedOut === true,
        totalTurnMs: timingResult.durationMs ?? attribution?.totalTurnMs ?? null,
        commandStartedAt: timingResult.startedAt ?? null,
        commandStartedAtEpochMs: timingResult.startedAtEpochMs ?? null,
        commandFinishedAt: timingResult.finishedAt ?? null,
        commandFinishedAtEpochMs: timingResult.finishedAtEpochMs ?? null,
        rawCommandStartedAt: result.startedAt ?? null,
        rawCommandStartedAtEpochMs: result.startedAtEpochMs ?? null,
        rawCommandFinishedAt: result.finishedAt ?? null,
        rawCommandFinishedAtEpochMs: result.finishedAtEpochMs ?? null,
        rawCommandDurationMs: result.durationMs ?? null,
        gatewaySession,
        channelModelTurn,
        expectedText,
        responseText: response.text,
        responseOk: expectedFailure ? expectedFailureObserved : normalResponseOk,
        assistantResponseOk: normalResponseOk,
        expectedTextPresent,
        preProviderMs: attribution?.preProviderMs ?? null,
        providerFinalMs: attribution?.providerFinalMs ?? null,
        postProviderMs: attribution?.postProviderMs ?? null,
        firstByteLatencyMs: attribution?.firstByteLatencyMs ?? null,
        firstChunkLatencyMs: attribution?.firstChunkLatencyMs ?? null,
        preProviderDominance: attribution?.preProviderDominates ?? null,
        providerDominance: attribution?.providerDominates ?? null,
        requestCount: attribution?.requestCount ?? 0,
        missingProviderRequest: attribution?.missingProviderRequest ?? true,
        providerRoutes: attribution?.routes ?? [],
        providerModels: attribution?.models ?? [],
        providerStatuses: attribution?.statuses ?? [],
        providerModes: attribution?.modes ?? [],
        providerOutcomes: attribution?.outcomes ?? [],
        providerErrorClasses: attribution?.errorClasses ?? [],
        providerErrors: attribution?.errors ?? [],
        providerRequestTiming: attribution?.providerRequestTiming ?? null,
        providerAfterCommandEnd: attribution?.providerAfterCommandEnd ?? false,
        providerLateByMs: attribution?.providerLateByMs ?? null,
        phaseBreakdown,
        turnDiagnostics,
        gatewaySessionPreProviderAttribution,
        agentCliPreProviderAttribution,
        metadataScanCount: turnDiagnostics.metadataScan.count,
        metadataScanTotalMs: turnDiagnostics.metadataScan.totalDurationMs,
        metadataScanMaxMs: turnDiagnostics.metadataScan.maxDurationMs,
        eventLoopMaxMs: turnDiagnostics.eventLoop.maxMs,
        sessionPollCount: turnDiagnostics.sessionPolling.pollCount,
        cleanupMs: phaseBreakdown?.buckets?.cleanupMs ?? null,
        processLeaks: result.processSnapshots?.leaks ?? null,
        processLeakCount: result.processSnapshots?.leaks?.leakCount ?? null,
        leakedProcesses: result.processSnapshots?.leaks?.leakedProcesses ?? [],
        healthOk: phase.metrics?.health?.ok ?? null,
        healthP95Ms: phase.metrics?.healthSummary?.p95Ms ?? null,
        resourceSamples: summarizeTurnResources(result.resourceSamples)
      });
    }
  }
  return turns;
}

export function preferredPreProviderAttributionSummary(...summaries) {
  return summaries.find((summary) => summary?.count > 0) ?? summaries[0];
}

export function checkGatewaySessionTransport(violations, agentTurns, scenario) {
  if (scenario.id !== "gateway-session-send-turn" && scenario.surface !== "gateway-session-send-turn") {
    return;
  }
  for (const turn of agentTurns) {
    if (!turn.gatewaySession) {
      continue;
    }
    const transport = turn.gatewaySession.gatewayTransportKind;
    if (transport === "direct-gateway-rpc") {
      continue;
    }
    violations.push({
      kind: "harness",
      metric: "gatewayTransport.kind",
      expected: "direct-gateway-rpc",
      actual: transport ?? "unknown",
      phaseId: turn.phaseId,
      message: `Gateway session benchmark used ${transport ?? "unknown"} transport; direct Gateway RPC is required for Gateway product measurement`
    });
  }
}

export function checkChannelModelTurnCases(violations, agentTurns) {
  for (const turn of agentTurns) {
    const failedCases = Array.isArray(turn.channelModelTurn?.failedModelTurnCases)
      ? turn.channelModelTurn.failedModelTurnCases
      : [];
    for (const failedCase of failedCases) {
      const caseId = typeof failedCase?.id === "string" && failedCase.id.length > 0
        ? failedCase.id
        : "unknown";
      const failedInvariants = Array.isArray(failedCase.failedInvariants)
        ? failedCase.failedInvariants.filter((invariant) => invariant?.id || invariant?.reason)
        : [];
      const failedInvariant = failedInvariants[0]?.id ?? null;
      const failedInvariantSummary = formatChannelInvariantFailures(failedInvariants);
      const atomCoverage = formatChannelAtomCoverage(failedCase.capabilities);
      const workflow = typeof failedCase.workflow === "string" && failedCase.workflow.length > 0
        ? failedCase.workflow
        : null;
      const inventoryWorkflow = typeof failedCase.inventoryWorkflow === "string" && failedCase.inventoryWorkflow.length > 0
        ? failedCase.inventoryWorkflow
        : null;
      const matrix = compactChannelWorkflowMatrix(failedCase.matrix);
      const matrixDetail = formatChannelWorkflowMatrix(matrix);
      const ownerArea = typeof failedCase.ownerArea === "string" && failedCase.ownerArea.length > 0
        ? failedCase.ownerArea
        : "OpenClaw";
      const detail = [
        workflow ? `workflow ${workflow}` : null,
        inventoryWorkflow ? `inventory ${inventoryWorkflow}` : null,
        matrixDetail ? `matrix ${matrixDetail}` : null,
        failedInvariantSummary,
        atomCoverage ? `atoms ${atomCoverage}` : null
      ].filter(Boolean).join("; ");
      violations.push({
        kind: "channel",
        metric: `channelModelTurn.case.${caseId}`,
        phaseId: turn.phaseId,
        workflow,
        inventoryWorkflow,
        matrix,
        failedInvariant,
        failedInvariants,
        failedInvariantCount: failedInvariants.length,
        failedInvariantSummary,
        atomCoverage,
        userAction: typeof failedCase.userAction === "string" ? failedCase.userAction : null,
        ownerArea,
        expected: "passed",
        actual: "failed",
        message: `channel model turn case ${caseId} failed${failedCase?.reason ? `: ${failedCase.reason}` : ""}${detail ? ` (${detail})` : ""}`
      });
    }
  }
}

function formatChannelAtomCoverage(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return null;
  }
  const atoms = capabilities
    .map((capability) => [capability?.group, capability?.id].filter(Boolean).join("/"))
    .filter(Boolean);
  return atoms.length > 0 ? atoms.join(", ") : null;
}

function formatChannelInvariantFailures(invariants) {
  if (!Array.isArray(invariants) || invariants.length === 0) {
    return null;
  }
  const ids = invariants
    .map((invariant) => invariant?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) {
    return null;
  }
  const shown = ids.slice(0, 4);
  const suffix = ids.length > shown.length ? `, +${ids.length - shown.length} more` : "";
  return `${ids.length === 1 ? "invariant" : "invariants"} ${shown.join(", ")}${suffix}`;
}

function extractGatewaySessionTurn(result) {
  if (!result?.command?.includes("run-gateway-session-send-turn.mjs")) {
    return null;
  }
  const payload = parseJsonObject(result.stdout);
  if (!payload || payload.surface !== "gateway-session-send-turn") {
    return null;
  }
  const activeStartedAtEpochMs = numberOrNull(payload.activeStartedAtEpochMs ?? payload.sendStartedAtEpochMs);
  const activeFinishedAtEpochMs = numberOrNull(
    payload.activeFinishedAtEpochMs ??
    payload.assistantMatchedAtEpochMs ??
    payload.finishedAtEpochMs
  );
  if (activeStartedAtEpochMs === null || activeFinishedAtEpochMs === null || activeFinishedAtEpochMs < activeStartedAtEpochMs) {
    return null;
  }
  const activeTurnMs = numberOrNull(payload.activeTurnMs) ?? Math.max(0, activeFinishedAtEpochMs - activeStartedAtEpochMs);
  return {
    schemaVersion: "kova.gatewaySessionTurn.v1",
    method: payload.method ?? "sessions.send",
    surface: payload.surface,
    createSession: typeof payload.createSession === "boolean" ? payload.createSession : null,
    minAssistantCount: numberOrNull(payload.minAssistantCount),
    sessionKey: payload.sessionKey ?? null,
    runId: payload.runId ?? null,
    gatewayTransportKind: payload.gatewayTransport?.kind ?? null,
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    activeTurnMs,
    sessionCreateDurationMs: numberOrNull(payload.sessionCreateDurationMs),
    sendDurationMs: numberOrNull(payload.sendDurationMs),
    timeToFirstAssistantMs: numberOrNull(payload.timeToFirstAssistantMs),
    timeToMatchedAssistantMs: numberOrNull(payload.timeToMatchedAssistantMs),
    assistantMessageCount: numberOrNull(payload.assistantMessageCount),
    historyPollCount: numberOrNull(payload.historyPollCount),
    historyErrorCount: numberOrNull(payload.historyErrorCount),
    expectedTextPresent: typeof payload.expectedTextPresent === "boolean" ? payload.expectedTextPresent : null
  };
}

function extractChannelModelTurn(result) {
  if (!result?.command?.includes("run-channel-probe-turn.mjs")) {
    return null;
  }
  const payload = parseJsonObject(result.stdout);
  if (!payload || payload.schemaVersion !== "kova.channelProbeTurnRun.v1") {
    return null;
  }
  const activeStartedAtEpochMs = numberOrNull(payload.activeStartedAtEpochMs);
  const activeFinishedAtEpochMs = numberOrNull(payload.activeFinishedAtEpochMs);
  if (activeStartedAtEpochMs === null || activeFinishedAtEpochMs === null || activeFinishedAtEpochMs < activeStartedAtEpochMs) {
    return null;
  }
  const activeTurnMs = numberOrNull(payload.activeTurnMs) ?? Math.max(0, activeFinishedAtEpochMs - activeStartedAtEpochMs);
  return {
    schemaVersion: "kova.channelModelTurn.v1",
    surface: "channel-model-turn-baseline",
    inboundEventId: payload.inboundEventId ?? null,
    routeSessionKey: payload.routeSessionKey ?? null,
    expectedText: typeof payload.expectedText === "string" && payload.expectedText.length > 0 ? payload.expectedText : null,
    finalText: typeof payload.finalText === "string" && payload.finalText.length > 0 ? payload.finalText : null,
    expectedTextPresent: typeof payload.finalText === "string" && typeof payload.expectedText === "string"
      ? textEquals(payload.finalText, payload.expectedText)
      : null,
    providerRequestDelta: numberOrNull(payload.providerRequestDelta),
    modelTurnCaseCount: numberOrNull(payload.modelTurnCaseCount),
    capabilityRowCount: numberOrNull(payload.capabilityRowCount),
    failedModelTurnCases: Array.isArray(payload.failedModelTurnCases) || Array.isArray(payload.failedCases)
      ? (payload.failedModelTurnCases ?? payload.failedCases).map(compactFailedModelTurnCase).filter(Boolean)
      : [],
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    activeTurnMs
  };
}

function compactFailedModelTurnCase(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    id: typeof value.id === "string" ? value.id : null,
    workflow: typeof value.workflow === "string" ? value.workflow : null,
    inventoryWorkflow: typeof value.inventoryWorkflow === "string" ? value.inventoryWorkflow : null,
    matrix: compactChannelWorkflowMatrix(value.matrix),
    userAction: typeof value.userAction === "string" ? value.userAction : null,
    ownerArea: typeof value.ownerArea === "string" ? value.ownerArea : null,
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.map((capability) => ({
          group: typeof capability?.group === "string" ? capability.group : null,
          id: typeof capability?.id === "string" ? capability.id : null
        })).filter((capability) => capability.group || capability.id)
      : [],
    reason: typeof value.reason === "string" ? value.reason : null,
    failedInvariants: Array.isArray(value.failedInvariants)
      ? value.failedInvariants.map((invariant) => ({
          id: typeof invariant?.id === "string" ? invariant.id : null,
          reason: typeof invariant?.reason === "string" ? invariant.reason : null
        }))
      : []
  };
}

function compactChannelWorkflowMatrix(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const matrix = {
    content: typeof value.content === "string" ? value.content : null,
    route: typeof value.route === "string" ? value.route : null,
    delivery: typeof value.delivery === "string" ? value.delivery : null,
    lifecycle: typeof value.lifecycle === "string" ? value.lifecycle : null
  };
  return Object.values(matrix).some(Boolean) ? matrix : null;
}

function formatChannelWorkflowMatrix(matrix) {
  if (!matrix) {
    return null;
  }
  return [
    matrix.content,
    matrix.route,
    matrix.delivery,
    matrix.lifecycle
  ].filter(Boolean).join("/");
}

function resultForActiveTurnWindow(result, gatewaySession) {
  return {
    ...result,
    startedAt: isoOrNull(gatewaySession.activeStartedAtEpochMs),
    startedAtEpochMs: gatewaySession.activeStartedAtEpochMs,
    finishedAt: isoOrNull(gatewaySession.activeFinishedAtEpochMs),
    finishedAtEpochMs: gatewaySession.activeFinishedAtEpochMs,
    durationMs: gatewaySession.activeTurnMs
  };
}

function resultForChannelModelTurnWindow(result, channelModelTurn) {
  return {
    ...result,
    startedAt: isoOrNull(channelModelTurn.activeStartedAtEpochMs),
    startedAtEpochMs: channelModelTurn.activeStartedAtEpochMs,
    finishedAt: isoOrNull(channelModelTurn.activeFinishedAtEpochMs),
    finishedAtEpochMs: channelModelTurn.activeFinishedAtEpochMs,
    durationMs: channelModelTurn.activeTurnMs
  };
}

function summarizeActiveTurnDiagnostics({ timelineSummary, activeStartedAtEpochMs, activeFinishedAtEpochMs, gatewaySession }) {
  const events = Array.isArray(timelineSummary?.turnAttributionEvents) && timelineSummary.turnAttributionEvents.length > 0
    ? timelineSummary.turnAttributionEvents
    : (Array.isArray(timelineSummary?.events) ? timelineSummary.events : []);
  const windowEvents = events.filter((event) =>
    eventEpochMs(event) !== null &&
    eventEpochMs(event) >= activeStartedAtEpochMs &&
    eventEpochMs(event) <= activeFinishedAtEpochMs
  );
  const metadataScans = windowEvents.filter((event) =>
    (event.type === "span.end" || event.type === "span.error" || event.type === "mark") &&
    event.name === "plugins.metadata.scan"
  );
  const eventLoopSamples = windowEvents.filter((event) => event.type === "eventLoop.sample");
  const eventLoopMaxValues = eventLoopSamples
    .map((event) => numberOrNull(event.maxMs ?? event.eventLoopDelayMs))
    .filter((value) => value !== null);

  return {
    schemaVersion: "kova.activeTurnDiagnostics.v1",
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    metadataScan: summarizeTimedEvents(metadataScans),
    eventLoop: {
      sampleCount: eventLoopSamples.length,
      maxMs: eventLoopMaxValues.length > 0 ? Math.max(...eventLoopMaxValues) : null,
      slowestSample: selectSlowestEventLoopSample(eventLoopSamples)
    },
    sessionPolling: {
      pollCount: gatewaySession?.historyPollCount ?? null,
      errorCount: gatewaySession?.historyErrorCount ?? null
    }
  };
}

function summarizeTimedEvents(events) {
  const durations = events.map((event) => numberOrNull(event.durationMs)).filter((value) => value !== null);
  return {
    count: events.length,
    totalDurationMs: roundNumber(durations.reduce((total, value) => total + value, 0)),
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : null,
    slowest: events
      .filter((event) => typeof event.durationMs === "number")
      .toSorted((left, right) => right.durationMs - left.durationMs)
      .map(compactTimelineEvent)
      .at(0) ?? null
  };
}

function selectSlowestEventLoopSample(samples) {
  return samples
    .map((event) => ({
      timestamp: event.timestamp ?? null,
      maxMs: numberOrNull(event.maxMs ?? event.eventLoopDelayMs),
      p95Ms: numberOrNull(event.p95Ms),
      p99Ms: numberOrNull(event.p99Ms),
      activeSpanName: event.activeSpanName ?? event.spanName ?? null
    }))
    .filter((sample) => sample.maxMs !== null)
    .toSorted((left, right) => right.maxMs - left.maxMs)
    .at(0) ?? null;
}

function compactTimelineEvent(event) {
  return {
    type: event.type ?? null,
    name: event.name ?? null,
    timestamp: event.timestamp ?? null,
    durationMs: event.durationMs ?? null,
    pluginId: event.pluginId ?? event.attributes?.pluginId ?? null
  };
}

function eventEpochMs(event) {
  const direct = numberOrNull(event?.timestampEpochMs ?? event?.timeEpochMs);
  if (direct !== null) {
    return direct;
  }
  const parsed = Date.parse(event?.timestamp ?? event?.time ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateAgentFailureContainment({ turns, record, thresholds, gatewayExpected = true, health = null }) {
  const healthFailures = countPostStartupHealthFailures(record, health);
  const healthFailureBreakdown = postStartupHealthFailureBreakdown(health);
  if (turns.length === 0) {
    return {
      schemaVersion: "kova.agentFailureContainment.v1",
      processLeakCount: 0,
      leakLimit: 0,
      leakedProcesses: [],
      processLeaksOk: true,
      finalGatewayState: record.finalMetrics?.service?.gatewayState ?? null,
      gatewayHealthy: gatewayExpected ? null : true,
      healthFailures,
      healthFailureScope: "post-startup",
      healthFailureBreakdown,
      healthLimit: 0,
      statusWorks: null,
      dashboardResponsive: null,
      tuiResponsive: null
    };
  }
  const leakCount = turns.reduce((total, turn) => total + (turn.processLeakCount ?? 0), 0);
  const leakedProcesses = turns.flatMap((turn) => (turn.leakedProcesses ?? []).map((process) => ({
    ...process,
    phaseId: turn.phaseId,
    turn: turn.label
  })));
  const leakLimit = typeof thresholds.agentProcessLeaks === "number" ? thresholds.agentProcessLeaks : 0;
  const healthLimit = typeof thresholds.agentContainmentHealthFailures === "number"
    ? thresholds.agentContainmentHealthFailures
    : (typeof thresholds.providerFailureHealthFailures === "number" ? thresholds.providerFailureHealthFailures : 0);
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const statusCommands = collectResults(record).filter((result) =>
    isStatusCommand(result.command)
  );
  const statusWorks = statusCommands.length === 0 ? null : statusCommands.some((result) => result.status === 0 && result.timedOut !== true);

  return {
    schemaVersion: "kova.agentFailureContainment.v1",
    processLeakCount: leakCount,
    leakLimit,
    leakedProcesses,
    processLeaksOk: leakCount <= leakLimit,
    finalGatewayState,
    gatewayHealthy: gatewayExpected ? finalGatewayState === "running" && healthFailures <= healthLimit : true,
    healthFailures,
    healthFailureScope: "post-startup",
    healthFailureBreakdown,
    healthLimit,
    statusWorks,
    dashboardResponsive: null,
    tuiResponsive: null
  };
}

export function checkAgentFailureContainment(violations, containment) {
  if (containment.processLeaksOk !== true) {
    const first = containment.leakedProcesses[0];
    violations.push({
      kind: "agent-containment",
      metric: "agentProcessLeakCount",
      expected: `<= ${containment.leakLimit}`,
      actual: containment.processLeakCount,
      message: `agent command leaked ${containment.processLeakCount} process(es) after completion${first ? `; first leak ${first.role} pid ${first.pid} ${first.command}` : ""}`
    });
  }
  if (containment.gatewayHealthy === false) {
    violations.push({
      kind: "agent-containment",
      metric: "agentGatewayHealthy",
      expected: `gateway running and post-startup health failures <= ${containment.healthLimit}`,
      actual: `gateway=${containment.finalGatewayState ?? "unknown"} healthFailures=${containment.healthFailures}`,
      message: `gateway was not healthy after agent command; gateway=${containment.finalGatewayState ?? "unknown"}, post-startup health failures=${containment.healthFailures}`
    });
  }
  if (containment.statusWorks === false) {
    violations.push({
      kind: "agent-containment",
      metric: "agentStatusWorks",
      expected: "post-agent status command succeeds",
      actual: false,
      message: "post-agent status command did not succeed"
    });
  }
}

export function selectAgentTurn(turns, label) {
  return turns.find((turn) => turn.label === label) ?? null;
}

export function collectSlowestProviderTurn(turns) {
  if (turns.length === 0) {
    return null;
  }
  return turns.toSorted((left, right) => (right.totalTurnMs ?? -1) - (left.totalTurnMs ?? -1))[0];
}

export function maxTurnDuration(turns) {
  const durations = turns.map((turn) => turn.totalTurnMs).filter((value) => typeof value === "number");
  return durations.length === 0 ? null : Math.max(...durations);
}

export function summarizeAgentTurnStats(turns) {
  return {
    schemaVersion: "kova.agentTurnStats.v1",
    count: turns.length,
    totalTurnMs: summarizeNumericField(turns, "totalTurnMs"),
    preProviderMs: summarizeNumericField(turns, "preProviderMs"),
    providerFinalMs: summarizeNumericField(turns, "providerFinalMs"),
    postProviderMs: summarizeNumericField(turns, "postProviderMs"),
    cleanupMs: summarizeNumericField(turns, "cleanupMs"),
    firstByteLatencyMs: summarizeNumericField(turns, "firstByteLatencyMs"),
    processLeakCount: turns.reduce((sum, turn) => sum + (turn.processLeakCount ?? 0), 0),
    missingProviderRequestCount: turns.filter((turn) => turn.missingProviderRequest === true).length,
    responseOkCount: turns.filter((turn) => turn.responseOk === true).length
  };
}

export function summarizeAgentTurnDiagnostics(turns) {
  return {
    schemaVersion: "kova.agentTurnDiagnosticsSummary.v1",
    metadataScanCount: turns.reduce((sum, turn) => sum + (turn.metadataScanCount ?? 0), 0),
    metadataScanTotalMs: roundNumber(turns.reduce((sum, turn) => sum + (turn.metadataScanTotalMs ?? 0), 0)),
    metadataScanMaxMs: maxNullable(...turns.map((turn) => turn.metadataScanMaxMs)),
    eventLoopMaxMs: maxNullable(...turns.map((turn) => turn.eventLoopMaxMs)),
    eventLoopSampleCount: turns.reduce((sum, turn) => sum + (turn.turnDiagnostics?.eventLoop?.sampleCount ?? 0), 0),
    sessionPollCount: turns.reduce((sum, turn) => sum + (turn.sessionPollCount ?? 0), 0),
    sessionPollErrorCount: turns.reduce((sum, turn) => sum + (turn.gatewaySession?.historyErrorCount ?? 0), 0)
  };
}

function summarizeNumericField(items, field) {
  const values = items
    .map((item) => item?.[field])
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      median: null,
      p95: null,
      max: null
    };
  }
  return {
    count: values.length,
    min: values[0],
    median: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.at(-1)
  };
}

function maxProviderRequestConcurrency(requests) {
  const events = [];
  for (const request of requests ?? []) {
    if (typeof request.receivedAtEpochMs !== "number" || typeof request.respondedAtEpochMs !== "number") {
      continue;
    }
    if (request.respondedAtEpochMs < request.receivedAtEpochMs) {
      continue;
    }
    events.push({ time: request.receivedAtEpochMs, delta: 1 });
    events.push({ time: request.respondedAtEpochMs, delta: -1 });
  }
  let current = 0;
  let max = 0;
  for (const event of events.toSorted((left, right) => left.time - right.time || right.delta - left.delta)) {
    current += event.delta;
    max = Math.max(max, current);
  }
  return max;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const position = (percentileValue / 100) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = position - lower;
  return Math.round((sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight) * 1000) / 1000;
}

export function checkAgentTurnCorrectness(violations, turns, expectedText) {
  for (const turn of turns) {
    if (turn.expectedFailure === true) {
      if (turn.expectedFailureObserved !== true) {
        violations.push({
          kind: "agent",
          metric: "agentTurn.expectedFailureObserved",
          phaseId: turn.phaseId,
          expected: "provider failure surfaced as command failure",
          actual: turn.status,
          message: `${turn.label} agent turn was expected to fail from provider behavior, but the failure was not observed clearly`
        });
      }
      continue;
    }
    if (turn.responseOk !== true) {
      violations.push({
        kind: "agent",
        metric: "agentTurn.responseOk",
        phaseId: turn.phaseId,
        expected: "usable assistant response",
        actual: turn.responseText ?? "none",
        message: `${turn.label} agent turn did not produce the expected assistant response`
      });
    }
    const turnExpectedText = turn.channelModelTurn ? null : (turn.expectedText ?? expectedText);
    if (typeof turnExpectedText === "string" && turnExpectedText.length > 0 && turn.expectedTextPresent !== true) {
      violations.push({
        kind: "agent",
        metric: "agentTurn.expectedTextPresent",
        phaseId: turn.phaseId,
        expected: turnExpectedText,
        actual: turn.responseText ?? "none",
        message: `${turn.label} agent turn response did not exactly match expected text ${turnExpectedText}`
      });
    }
  }
}

export function evaluateProviderSimulation({ turns, scenario, record, thresholds, health = null }) {
  const mode = scenario.mockProvider?.mode ?? "normal";
  const expected = mode !== "normal" && scenario.agent !== undefined;
  const issue = classifyProviderIssue(turns);
  const providerRequests = record.providerEvidence?.requests ?? [];
  const expectedFailureTurns = turns.filter((turn) => turn.expectedFailure === true);
  const normalTurns = turns.filter((turn) => turn.expectedFailure !== true);
  const healthLimit = typeof thresholds.providerFailureHealthFailures === "number" ? thresholds.providerFailureHealthFailures : 0;
  const healthFailures = countPostStartupHealthFailures(record, health);
  const healthFailureBreakdown = postStartupHealthFailureBreakdown(health);
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const containmentOk = !expected || (
    finalGatewayState === "running" &&
    healthFailures <= healthLimit
  );
  const protocolFailureObserved = mode === "protocol-failure"
    ? hasProtocolFailureRequest(providerRequests) && issue.kind === "malformed-response"
    : null;
  const disconnectObserved = mode === "disconnect-then-recover"
    ? hasDisconnectFailureRequest(providerRequests) || turns.some((turn) => hasProviderFailureEvidence(turn, "provider-disconnect"))
    : null;
  const recoveryOk = PROVIDER_RECOVERY_MODES.has(mode)
    ? hasProviderFailureBeforeSuccessfulRequest(providerRequests, mode) ||
      (
        turns.some((turn) => hasProviderFailureEvidence(turn, mode === "disconnect-then-recover" ? "provider-disconnect" : null)) &&
        turns.some((turn) => turn.responseOk === true && hasSuccessfulProviderRequest(turn))
      )
    : null;
  const providerSlowMinMs = thresholds.providerSlowMinMs ?? scenario.mockProvider?.delayMs ?? null;
  const slowObserved = mode === "slow"
    ? turns.some((turn) => typeof turn.providerFinalMs === "number" && typeof providerSlowMinMs === "number" && turn.providerFinalMs >= providerSlowMinMs)
    : null;
  const providerRequestCount = record.providerEvidence?.requestCount ?? turns.reduce((total, turn) => total + (turn.requestCount ?? 0), 0);
  const providerRequestCountMin = thresholds.providerRequestCountMin ?? scenario.mockProvider?.concurrency ?? null;
  const providerMaxConcurrency = maxProviderRequestConcurrency(record.providerEvidence?.requests ?? []);
  const providerConcurrencyMin = thresholds.providerConcurrencyMin ?? (typeof scenario.mockProvider?.concurrency === "number" ? Math.min(2, scenario.mockProvider.concurrency) : null);
  const requestCountOk = typeof providerRequestCountMin === "number" ? providerRequestCount >= providerRequestCountMin : null;
  const overlapObserved = typeof providerConcurrencyMin === "number" ? providerMaxConcurrency >= providerConcurrencyMin : null;
  const concurrentObserved = mode === "concurrent-pressure"
    ? requestCountOk === true && overlapObserved === true
    : null;

  return {
    schemaVersion: "kova.agentProviderSimulation.v1",
    mode,
    expected,
    observedIssue: issue.kind,
    observedIssueSummary: issue.summary,
    containmentOk,
    recoveryOk,
    slowObserved,
    expectedFailureCount: expectedFailureTurns.length,
    expectedFailureObservedCount: expectedFailureTurns.filter((turn) => turn.expectedFailureObserved === true).length,
    successfulTurnCount: normalTurns.filter((turn) => turn.responseOk === true).length,
    protocolFailureObserved,
    disconnectObserved,
    finalGatewayState,
    healthFailures,
    healthFailureScope: "post-startup",
    healthFailureBreakdown,
    healthLimit,
    providerSlowMinMs,
    providerRequestCount,
    providerRequestCountMin,
    providerMaxConcurrency,
    providerConcurrencyMin,
    requestCountOk,
    overlapObserved,
    concurrentObserved
  };
}

export function checkProviderSimulation(violations, simulation) {
  if (!simulation.expected) {
    return;
  }
  if (simulation.mode === "slow" && simulation.slowObserved !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerSlowObserved",
      expected: `>= ${simulation.providerSlowMinMs ?? "configured delay"}ms provider work`,
      actual: simulation.observedIssueSummary,
      message: "mock provider slow mode did not produce observable slow provider work"
    });
  }
  if (simulation.mode === "timeout" && !["provider-timeout", "streaming-stall", "provider-aborted", "http-error"].includes(simulation.observedIssue)) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerTimeoutObserved",
      expected: "provider timeout or aborted request",
      actual: simulation.observedIssue,
      message: "mock provider timeout mode did not produce observable timeout/abort evidence"
    });
  }
  if (simulation.mode === "streaming-stall" && !["streaming-stall", "provider-aborted", "provider-timeout", "http-error"].includes(simulation.observedIssue)) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerStreamingStallObserved",
      expected: "streaming stall or aborted request",
      actual: simulation.observedIssue,
      message: "mock provider streaming-stall mode did not produce observable stall/abort evidence"
    });
  }
  if (simulation.mode === "malformed" && simulation.observedIssue !== "malformed-response") {
    violations.push({
      kind: "provider-simulation",
      metric: "providerMalformedObserved",
      expected: "malformed provider response",
      actual: simulation.observedIssue,
      message: "mock provider malformed mode did not produce malformed response evidence"
    });
  }
  if (simulation.mode === "protocol-failure" && simulation.protocolFailureObserved !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerProtocolFailureObserved",
      expected: "protocol-invalid provider response from protocol-failure fixture",
      actual: simulation.observedIssue,
      message: "mock provider protocol-failure mode did not prove the protocol-invalid provider response was exercised"
    });
  }
  if (simulation.mode === "error-then-recover" && simulation.recoveryOk !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerRecoveryOk",
      expected: "first request fails and later request succeeds",
      actual: simulation.recoveryOk,
      message: "mock provider error-then-recover mode did not prove agent recovery"
    });
  }
  if (simulation.mode === "disconnect-then-recover" && simulation.disconnectObserved !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerDisconnectObserved",
      expected: "provider disconnect evidence before recovery",
      actual: simulation.observedIssue,
      message: "mock provider disconnect-then-recover mode did not prove a provider disconnect"
    });
  }
  if (simulation.mode === "disconnect-then-recover" && simulation.recoveryOk !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerDisconnectRecoveryOk",
      expected: "disconnect request fails and later provider request succeeds",
      actual: simulation.recoveryOk,
      message: "mock provider disconnect-then-recover mode did not prove recovery after disconnect"
    });
  }
  if (simulation.mode === "concurrent-pressure" && simulation.concurrentObserved !== true) {
    violations.push({
      kind: "provider-simulation",
      metric: "providerConcurrentPressureObserved",
      expected: `>= ${simulation.providerRequestCountMin ?? "configured concurrency"} provider requests and max in-flight >= ${simulation.providerConcurrencyMin ?? "configured overlap"}`,
      actual: `requests=${simulation.providerRequestCount}, maxInFlight=${simulation.providerMaxConcurrency}`,
      message: "mock provider concurrent-pressure mode did not produce enough overlapping provider work"
    });
  }
  if (simulation.containmentOk !== true) {
    violations.push({
      kind: "provider-containment",
      metric: "providerFailureContainmentOk",
      expected: `gateway running and post-startup health failures <= ${simulation.healthLimit}`,
      actual: `gateway=${simulation.finalGatewayState ?? "unknown"} healthFailures=${simulation.healthFailures}`,
      message: `provider ${simulation.mode} failure was not contained; gateway=${simulation.finalGatewayState ?? "unknown"}, post-startup health failures=${simulation.healthFailures}`
    });
  }
}

export function buildAgentFailureFixerSummary(latencyDiagnosis, cleanupDiagnosis, providerSimulation, containment) {
  const items = [];
  if (providerSimulation?.expected === true && (providerSimulation.mode === "timeout" || providerSimulation.observedIssue === "provider-timeout")) {
    items.push({
      kind: "provider-timeout",
      summary: "Provider timed out; verify OpenClaw surfaces the timeout clearly, cancels the turn, and leaves the gateway responsive.",
      likelyOwner: "provider / agent timeout handling"
    });
  }
  if (providerSimulation?.expected === true && (providerSimulation.mode === "streaming-stall" || providerSimulation.observedIssue === "streaming-stall")) {
    items.push({
      kind: "streaming-stall",
      summary: "Provider stream stalled; verify OpenClaw applies stream idle timeouts and does not freeze gateway/TUI/dashboard.",
      likelyOwner: "provider streaming / agent turn cancellation"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.mode !== "protocol-failure" && (providerSimulation.mode === "malformed" || providerSimulation.observedIssue === "malformed-response")) {
    items.push({
      kind: "malformed-response",
      summary: "Provider returned malformed output; verify OpenClaw reports a clear provider parse error and keeps the session usable.",
      likelyOwner: "provider response parsing"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.mode === "protocol-failure") {
    items.push({
      kind: "provider-protocol-failure",
      summary: "Provider returned a protocol-invalid response; verify OpenClaw reports a clear provider contract error and keeps the session usable.",
      likelyOwner: "provider response contract handling"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.recoveryOk === true) {
    items.push({
      kind: "provider-recovered",
      summary: "Provider failed and later recovered; verify retry/recovery behavior is intentional and latency remains acceptable.",
      likelyOwner: "provider retry / agent recovery"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "provider-disconnect") {
    items.push({
      kind: "provider-disconnect",
      summary: providerSimulation.observedIssueSummary ?? "Provider disconnected before recovery; verify OpenClaw reports the interruption and leaves follow-up turns usable.",
      likelyOwner: "provider transport recovery"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "provider-error") {
    items.push({
      kind: "provider-error",
      summary: providerSimulation.observedIssueSummary ?? "Provider returned an explicit error; verify OpenClaw reports it clearly and keeps the session usable.",
      likelyOwner: "provider error handling / agent recovery"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "provider-aborted") {
    items.push({
      kind: "provider-aborted",
      summary: providerSimulation.observedIssueSummary ?? "Provider request was aborted; verify OpenClaw cancels cleanly and does not leave a hung turn.",
      likelyOwner: "provider cancellation / agent turn lifecycle"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "http-error") {
    items.push({
      kind: "provider-http-error",
      summary: providerSimulation.observedIssueSummary ?? "Provider returned an HTTP error; verify OpenClaw maps it to actionable user-facing guidance.",
      likelyOwner: "provider HTTP error mapping"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.observedIssue === "none") {
    items.push({
      kind: "provider-failure-not-observed",
      summary: `Mock provider mode ${providerSimulation.mode} did not produce the expected failure evidence; verify the scenario exercises the intended OpenClaw provider path.`,
      likelyOwner: "scenario/provider harness wiring"
    });
  }
  if (providerSimulation?.expected === true && providerSimulation.mode === "concurrent-pressure") {
    items.push({
      kind: "provider-concurrent-pressure",
      summary: `Concurrent provider pressure produced ${providerSimulation.providerRequestCount ?? "unknown"} provider request(s), max in-flight ${providerSimulation.providerMaxConcurrency ?? "unknown"}; verify OpenClaw keeps gateway and agent sessions responsive under overlapping turns.`,
      likelyOwner: "agent concurrency / provider scheduling"
    });
  }
  if (latencyDiagnosis?.kind === "cold-pre-provider-stall" || latencyDiagnosis?.kind === "pre-provider-stall") {
    items.push({
      kind: "pre-provider-stall",
      summary: latencyDiagnosis.summary,
      likelyOwner: latencyDiagnosis.likelyOwner
    });
  }
  if (latencyDiagnosis?.kind === "auth-failure") {
    items.push({
      kind: "auth-failure",
      summary: "Agent turn failed before provider work because model/provider auth was missing; verify OpenClaw reports credential setup guidance and keeps the gateway usable.",
      likelyOwner: latencyDiagnosis.likelyOwner
    });
  }
  if (cleanupDiagnosis?.kind === "slow-agent-cleanup") {
    items.push({
      kind: "slow-agent-cleanup",
      summary: cleanupDiagnosis.summary,
      likelyOwner: cleanupDiagnosis.likelyOwner
    });
  }
  if ((containment?.processLeakCount ?? 0) > 0) {
    const first = containment.leakedProcesses?.[0];
    items.push({
      kind: "leaked-child-process",
      summary: `Agent command left ${containment.processLeakCount} process(es) running after completion${first ? `; first leak ${first.role} pid ${first.pid}` : ""}.`,
      likelyOwner: "agent cleanup / plugin child process lifecycle"
    });
  }
  if (containment?.gatewayHealthy === false) {
    items.push({
      kind: "gateway-after-agent-unhealthy",
      summary: `Gateway was not healthy after agent command; gateway=${containment.finalGatewayState ?? "unknown"}, post-startup health failures=${containment.healthFailures}.`,
      likelyOwner: "gateway supervision / agent failure containment"
    });
  }
  if (containment?.statusWorks === false) {
    items.push({
      kind: "status-after-agent-failed",
      summary: "OpenClaw status command did not respond cleanly after the failed agent turn; verify failed turns do not degrade CLI/gateway control paths.",
      likelyOwner: "gateway control path / agent failure containment"
    });
  }
  if (containment?.dashboardResponsive === false) {
    items.push({
      kind: "dashboard-after-agent-failed",
      summary: "Dashboard did not stay responsive after the failed agent turn; verify gateway UI endpoints are isolated from agent/provider failures.",
      likelyOwner: "dashboard / gateway failure containment"
    });
  }
  if (containment?.tuiResponsive === false) {
    items.push({
      kind: "tui-after-agent-failed",
      summary: "TUI did not stay responsive after the failed agent turn; verify terminal input and gateway attach paths are isolated from provider failures.",
      likelyOwner: "TUI / gateway attach failure containment"
    });
  }
  return {
    schemaVersion: "kova.agentFailureFixerSummary.v1",
    count: items.length,
    items
  };
}

export function checkAgentTurnThresholds(violations, turns, selected, thresholds, record) {
  for (const turn of turns) {
    if (turn.missingProviderRequest === true && record.auth?.mode === "mock") {
      violations.push({
        kind: "provider",
        metric: "agentProviderRequestMissing",
        phaseId: turn.phaseId,
        expected: "provider request during agent command",
        actual: "none",
        message: `${turn.label} agent turn ran with mock auth but no mock provider request was captured`
      });
      continue;
    }
    checkTurnThreshold(violations, turn, "totalTurnMs", thresholds.agentTurnMs, `${turn.label} agent turn took ${turn.totalTurnMs}ms`);
    checkTurnThreshold(violations, turn, "preProviderMs", thresholds.preProviderMs, `${turn.label} agent spent ${turn.preProviderMs}ms before provider work`);
    if (turn.expectedFailure !== true) {
      checkTurnThreshold(violations, turn, "providerFinalMs", thresholds.providerFinalMs, `${turn.label} provider work took ${turn.providerFinalMs}ms`);
    }
    // Cleanup is source-span evidence: gate it when present, while absence remains
    // explicit null. Non-null malformed evidence still blocks in the helper.
    checkTurnThreshold(
      violations,
      turn,
      "cleanupMs",
      thresholds.agentCleanupMs,
      `${turn.label} agent cleanup took ${turn.cleanupMs}ms`,
      { optionalMeasurement: true }
    );
    if (typeof thresholds.preProviderDominanceRatio === "number" &&
      typeof turn.preProviderDominance === "number" &&
      turn.preProviderDominance > thresholds.preProviderDominanceRatio &&
      preProviderDominanceExceededAbsoluteGate(turn, thresholds)) {
      violations.push({
        kind: "agent-latency",
        metric: "preProviderDominanceRatio",
        phaseId: turn.phaseId,
        expected: `<= ${thresholds.preProviderDominanceRatio}`,
        actual: turn.preProviderDominance,
        message: `${turn.label} pre-provider work dominated agent turn (${Math.round(turn.preProviderDominance * 100)}% of ${turn.totalTurnMs}ms)`
      });
    }
  }

  checkTurnThreshold(violations, selected.coldAgentTurn, "totalTurnMs", thresholds.coldAgentTurnMs, `cold agent turn took ${selected.coldAgentTurn?.totalTurnMs}ms`);
  checkTurnThreshold(violations, selected.warmAgentTurn, "totalTurnMs", thresholds.warmAgentTurnMs, `warm agent turn took ${selected.warmAgentTurn?.totalTurnMs}ms`);
  checkTurnThreshold(violations, selected.coldAgentTurn, "preProviderMs", thresholds.coldPreProviderMs, `cold pre-provider latency was ${selected.coldAgentTurn?.preProviderMs}ms`);
  checkTurnThreshold(violations, selected.warmAgentTurn, "preProviderMs", thresholds.warmPreProviderMs, `warm pre-provider latency was ${selected.warmAgentTurn?.preProviderMs}ms`);

  const totalDelta = delta(selected.coldAgentTurn?.totalTurnMs, selected.warmAgentTurn?.totalTurnMs);
  if (typeof thresholds.coldWarmDeltaMs === "number" && typeof totalDelta === "number" && totalDelta > thresholds.coldWarmDeltaMs) {
    violations.push({
      kind: "agent-latency",
      metric: "coldWarmDeltaMs",
      expected: `<= ${thresholds.coldWarmDeltaMs}`,
      actual: totalDelta,
      message: `cold agent turn was ${totalDelta}ms slower than warm turn`
    });
  }

  if (selected.agentLatencyDiagnosis?.severity === "fail") {
    violations.push({
      kind: "agent-latency",
      metric: "agentLatencyDiagnosis",
      expected: "no cold pre-provider stall",
      actual: selected.agentLatencyDiagnosis.kind,
      message: selected.agentLatencyDiagnosis.summary
    });
  }
}

export function checkAgentTurnAggregateThresholds(violations, stats, thresholds) {
  checkAggregateThreshold(violations, stats.totalTurnMs.p95, "agentTurnP95Ms", thresholds.agentTurnP95Ms);
  checkAggregateThreshold(violations, stats.totalTurnMs.max, "agentTurnMaxMs", thresholds.agentTurnMaxMs);
  checkAggregateThreshold(violations, stats.preProviderMs.p95, "agentPreProviderP95Ms", thresholds.agentPreProviderP95Ms);
  checkAggregateThreshold(violations, stats.preProviderMs.max, "agentPreProviderMaxMs", thresholds.agentPreProviderMaxMs);
  checkAggregateThreshold(violations, stats.providerFinalMs.p95, "agentProviderFinalP95Ms", thresholds.agentProviderFinalP95Ms);
  checkAggregateThreshold(violations, stats.providerFinalMs.max, "agentProviderFinalMaxMs", thresholds.agentProviderFinalMaxMs);
  checkAggregateThreshold(
    violations,
    stats.cleanupMs.p95,
    "agentCleanupP95Ms",
    thresholds.agentCleanupP95Ms,
    { optionalMeasurement: true }
  );
  checkAggregateThreshold(
    violations,
    stats.cleanupMs.max,
    "agentCleanupMaxMs",
    thresholds.agentCleanupMaxMs,
    { optionalMeasurement: true }
  );
}

function preProviderDominanceExceededAbsoluteGate(turn, thresholds) {
  if (typeof thresholds.preProviderMs !== "number" || typeof turn.preProviderMs !== "number") {
    return true;
  }
  return turn.preProviderMs > thresholds.preProviderMs;
}

export function diagnoseAgentLatency({ coldAgentTurn, warmAgentTurn, providerTurn, thresholds, timelineSummary, authMode = null, expectedProviderMode = "normal", providerSimulation = null }) {
  if (!providerTurn) {
    return null;
  }
  if (providerTurn.missingProviderRequest === true) {
    if (providerTurn.expectedFailure === true && ["missing", "broken", "none", "skip"].includes(authMode)) {
      return {
        kind: "auth-failure",
        severity: "info",
        summary: `Agent turn failed before provider work because auth mode is ${authMode}.`,
        likelyOwner: "agent-runtime/auth"
      };
    }
    if (authMode === "live") {
      return {
        kind: "live-provider-timing-unavailable",
        severity: "info",
        summary: "Live provider request timing was not captured; use OpenClaw timeline spans or a deterministic mock provider lane for provider boundary attribution.",
        likelyOwner: "Kova/OpenClaw diagnostics integration"
      };
    }
    return {
      kind: "no-provider-request",
      severity: "fail",
      summary: "No provider request happened during the agent turn.",
      likelyOwner: "agent-runtime/auth/provider-routing"
    };
  }

  const providerIssue = classifyProviderIssue([providerTurn]);
  if (providerIssue.kind !== "none") {
    const expectedProviderFailure = providerTurn.expectedFailure === true || providerSimulation?.expected === true;
    return {
      kind: providerIssue.kind,
      severity: expectedProviderMode === "normal" && !expectedProviderFailure ? "fail" : "info",
      summary: providerSimulation?.observedIssueSummary ?? providerIssue.summary,
      likelyOwner: "provider"
    };
  }

  const preProviderThreshold = thresholds.preProviderMs ?? thresholds.coldPreProviderMs ?? 10000;
  const dominanceThreshold = thresholds.preProviderDominanceRatio ?? 0.8;
  const coldWarmDeltaThreshold = thresholds.coldWarmDeltaMs ?? 10000;
  const coldWarmDelta = delta(coldAgentTurn?.totalTurnMs, warmAgentTurn?.totalTurnMs);
  const providerFast = typeof providerTurn.providerFinalMs === "number" && providerTurn.providerFinalMs <= (thresholds.providerFinalMs ?? 3000);
  const preProviderDominant = typeof providerTurn.preProviderDominance === "number" && providerTurn.preProviderDominance > dominanceThreshold;
  const preProviderSlow = typeof providerTurn.preProviderMs === "number" && providerTurn.preProviderMs > preProviderThreshold;
  const coldImproved = typeof coldWarmDelta === "number" && coldWarmDelta > coldWarmDeltaThreshold;

  if (providerFast && preProviderSlow && preProviderDominant) {
    return {
      kind: coldImproved ? "cold-pre-provider-stall" : "pre-provider-stall",
      severity: "fail",
      summary: `${providerTurn.label} provider was fast (${providerTurn.providerFinalMs}ms), but OpenClaw spent ${providerTurn.preProviderMs}ms before provider work${coldImproved ? `; warm turn improved by ${coldWarmDelta}ms` : ""}.`,
      likelyOwner: "model catalog / channel plugin loading / runtime capabilities",
      supportingSpans: relevantAgentSpans(timelineSummary)
    };
  }

  if (typeof providerTurn.providerFinalMs === "number" && providerTurn.providerFinalMs > (thresholds.providerFinalMs ?? 3000)) {
    return {
      kind: "provider-slow",
      severity: "warn",
      summary: `Provider work took ${providerTurn.providerFinalMs}ms; investigate provider/mock-provider route before blaming OpenClaw pre-provider work.`,
      likelyOwner: "provider"
    };
  }

  return {
    kind: "agent-latency-attributed",
    severity: "info",
    summary: `${providerTurn.label} agent turn ${providerTurn.totalTurnMs ?? "unknown"}ms; pre-provider ${providerTurn.preProviderMs ?? "unknown"}ms; provider ${providerTurn.providerFinalMs ?? "unknown"}ms.`,
    likelyOwner: "OpenClaw"
  };
}

export function diagnoseAgentCleanup(turns, stats, thresholds) {
  const threshold = thresholds.agentCleanupMs ?? thresholds.agentCleanupMaxMs ?? null;
  const max = stats.cleanupMs.max;
  if (typeof threshold !== "number" || typeof max !== "number" || max <= threshold) {
    return null;
  }
  const slowest = turns
    .filter((turn) => typeof turn.cleanupMs === "number")
    .toSorted((left, right) => right.cleanupMs - left.cleanupMs)[0] ?? null;
  return {
    kind: "slow-agent-cleanup",
    severity: "fail",
    summary: `${slowest?.label ?? "agent"} cleanup took ${max}ms after provider work; investigate agent cleanup, MCP runtime shutdown, plugin child cleanup, or session persistence.`,
    likelyOwner: "agent cleanup / plugin child process lifecycle",
    maxCleanupMs: max,
    thresholdMs: threshold,
    phaseId: slowest?.phaseId ?? null
  };
}

function classifyProviderIssue(turns) {
  const errors = turns.flatMap((turn) => turn.providerErrors ?? []);
  const errorKinds = new Set(errors.map((error) => error.kind).filter(Boolean));
  if (errorKinds.has("provider-timeout")) {
    return { kind: "provider-timeout", summary: "Provider timed out before completing the agent turn." };
  }
  if (errorKinds.has("streaming-stall")) {
    return { kind: "streaming-stall", summary: "Provider stream stalled before completing the agent turn." };
  }
  if (errorKinds.has("malformed-response")) {
    return { kind: "malformed-response", summary: "Provider returned a malformed response." };
  }
  if (errorKinds.has("provider-disconnect")) {
    return { kind: "provider-disconnect", summary: "Provider disconnected before completing the agent turn." };
  }
  if (errorKinds.has("provider-error")) {
    return { kind: "provider-error", summary: "Provider returned an explicit error before recovery or failure handling." };
  }
  if (errorKinds.has("provider-aborted")) {
    return { kind: "provider-aborted", summary: "Provider request was aborted before a normal response completed." };
  }
  if (errors.some((error) => error.kind === "http" && typeof error.status === "number" && error.status >= 400)) {
    const first = errors.find((error) => error.kind === "http" && typeof error.status === "number" && error.status >= 400);
    return { kind: "http-error", summary: `Provider returned HTTP ${first.status}.` };
  }
  return { kind: "none", summary: "No provider failure evidence found." };
}

function hasSuccessfulProviderRequest(turn) {
  return (turn.providerStatuses ?? []).some((status) => Number(status.value) >= 200 && Number(status.value) < 300);
}

function hasProviderFailureEvidence(turn, expectedKind = null) {
  if (expectedKind) {
    return (turn.providerErrors ?? []).some((error) => error.kind === expectedKind);
  }
  return (turn.providerErrors ?? []).some((error) =>
    ["provider-error", "provider-disconnect", "provider-timeout", "streaming-stall", "malformed-response", "provider-aborted"].includes(error.kind) ||
    (error.kind === "http" && typeof error.status === "number" && error.status >= 400)
  );
}

function hasProtocolFailureRequest(requests) {
  return requests.some((request) =>
    request.mode === "protocol-failure" &&
    request.responseType === "malformed" &&
    typeof request.status === "number" &&
    request.status >= 200 &&
    request.status < 300
  );
}

function hasDisconnectFailureRequest(requests) {
  return requests.some((request) => isProviderFailureRequest(request, "disconnect-then-recover"));
}

function hasProviderFailureBeforeSuccessfulRequest(requests, mode) {
  let sawFailure = false;
  for (const request of requests
    .filter((item) => typeof item.receivedAtEpochMs === "number")
    .toSorted((left, right) => left.receivedAtEpochMs - right.receivedAtEpochMs)) {
    if (isProviderFailureRequest(request, mode)) {
      sawFailure = true;
      continue;
    }
    if (sawFailure && isSuccessfulProviderRequest(request)) {
      return true;
    }
  }
  return false;
}

function isProviderFailureRequest(request, mode) {
  if (mode === "disconnect-then-recover") {
    return request.mode === "disconnect-then-recover" && request.errorClass === "provider-disconnect";
  }
  if (mode === "error-then-recover") {
    return request.mode === "error-then-recover" && (
      request.errorClass === "provider-error" ||
      (typeof request.status === "number" && request.status >= 400)
    );
  }
  return false;
}

function isSuccessfulProviderRequest(request) {
  return typeof request.status === "number" && request.status >= 200 && request.status < 300;
}

function relevantAgentSpans(timelineSummary) {
  const names = [
    "agent.turn",
    "agent.prepare",
    "agent.runtimeCapabilities",
    "channel.capabilities",
    "channel.plugin.get",
    "channel.plugin.load",
    "models.catalog.gateway",
    "models.catalog.load",
    "models.discovery",
    "plugins.metadata.scan",
    "runtimeDeps.stage",
    "provider.request",
    "agent.cleanup"
  ];
  return names
    .map((name) => timelineSummary.keySpans?.[name])
    .filter(Boolean)
    .filter((span) => (span.count ?? 0) > 0 || (span.openCount ?? 0) > 0 || typeof span.maxDurationMs === "number")
    .map((span) => ({
      name: span.name,
      count: span.count,
      maxDurationMs: span.maxDurationMs,
      openCount: span.openCount
    }));
}

function agentTurnLabel(phaseId, index) {
  if (phaseId?.includes("cold")) {
    return "cold";
  }
  if (phaseId?.includes("warm")) {
    return "warm";
  }
  if (phaseId?.includes("gateway-session")) {
    return "gateway-session";
  }
  if (phaseId?.includes("gateway")) {
    return "gateway-rpc";
  }
  if (phaseId?.includes("tui")) {
    return "tui";
  }
  if (phaseId?.includes("openai")) {
    return "openai-compatible";
  }
  return `turn-${index}`;
}

function summarizeTurnResources(samples) {
  if (!samples) {
    return null;
  }
  return {
    sampleCount: samples.sampleCount ?? 0,
    peakTotalRssMb: samples.peakTotalRssMb ?? null,
    maxTotalCpuPercent: samples.maxTotalCpuPercent ?? null,
    topRolesByRss: samples.topRolesByRss ?? [],
    topRolesByCpu: samples.topRolesByCpu ?? []
  };
}

function extractAgentResponse(result) {
  if (result.status !== 0 || result.timedOut) {
    return { usable: false, text: null };
  }

  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  try {
    const parsed = JSON.parse(result.stdout);
    const finalText = findFirstString(parsed, [
      "finalAssistantVisibleText",
      "finalAssistantRawText",
      "finalText",
      "text",
      "reply"
    ]);
    if (typeof finalText === "string" && finalText.trim().length > 0 && finalText.trim() !== "NO_REPLY") {
      return { usable: true, text: finalText.trim() };
    }
  } catch {
    // Fall through to tolerant text checks. Some OpenClaw builds still emit
    // diagnostics alongside JSON in integration environments.
  }

  const payloadText = findPayloadText(text);
  if (typeof payloadText === "string" && payloadText.trim().length > 0 && payloadText.trim() !== "NO_REPLY") {
    return { usable: true, text: payloadText.trim() };
  }

  const match = text.match(/"finalAssistant(?:Raw|Visible)Text"\s*:\s*"([^"]+)"/);
  const finalText = match?.[1] ?? null;
  return {
    usable: typeof finalText === "string" && finalText.trim().length > 0 && finalText.trim() !== "NO_REPLY",
    text: finalText?.trim() ?? null
  };
}

function responseMatchesExpectedText(response, expectedText) {
  return textEquals(response.text, expectedText);
}

function textEquals(actual, expected) {
  return typeof actual === "string" && typeof expected === "string" && actual.trim() === expected.trim();
}

export function countMissingDependencyErrors(results) {
  let count = 0;
  const pattern = /cannot find module|missing dependenc|missing runtime dep|failed to load/i;
  for (const result of results) {
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    for (const line of text.split("\n")) {
      if (pattern.test(line)) {
        count += 1;
      }
    }
  }
  return count;
}
