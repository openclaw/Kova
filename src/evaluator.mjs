import { summarizeAgentCliPreProviderAttributions } from "./collectors/agent-cli-attribution.mjs";
import { summarizeChannelWorkflowResources } from "./collectors/channel-workflow-resources.mjs";
import { summarizeGatewaySessionPreProviderAttributions } from "./collectors/gateway-session-turn-attribution.mjs";
import {
  buildAgentFailureFixerSummary,
  checkAgentFailureContainment,
  checkAgentTurnAggregateThresholds,
  checkAgentTurnCorrectness,
  checkAgentTurnThresholds,
  checkChannelModelTurnCases,
  checkGatewaySessionTransport,
  checkProviderSimulation,
  collectAgentTurns,
  collectSlowestProviderTurn,
  countMissingDependencyErrors,
  diagnoseAgentCleanup,
  diagnoseAgentLatency,
  evaluateAgentFailureContainment,
  evaluateProviderSimulation,
  maxTurnDuration,
  preferredPreProviderAttributionSummary,
  selectAgentTurn,
  summarizeAgentTurnDiagnostics,
  summarizeAgentTurnStats
} from "./evaluation/agent-turns.mjs";
import { buildDiagnosticCorrelation, countDiagnosticMetric } from "./evaluation/diagnostics.mjs";
import {
  collectIntentionalRestartSourcePids,
  collectTcpConnectMax,
  countGatewayRestarts,
  countListeningFailures,
  countReadinessFailures,
  recordExpectsGateway
} from "./evaluation/health.mjs";
import {
  collectLogSummary,
  collectNodeHeapTopFunction,
  collectNodeProfileTopFunction,
  collectOpenClawDiagnostics,
  collectRuntimeDepsLogEvidence,
  combineCommandAndLogCount,
  countDiagnosticReportMetric,
  countHeapSnapshotBytes,
  countLogMetric,
  countNodeProfileMetric,
  expectedPluginFailureLineIgnorer,
  hasSuccessfulLogCommandResult
} from "./evaluation/logs.mjs";
import { buildInstrumentedPerformanceAssessment, isSkippedPerformanceViolation } from "./evaluation/profiling.mjs";
import {
  collectResults,
  isColdReadyCommand,
  isDoctorFixCommand,
  isModelsListCommand,
  isPluginUpdateDryRunCommand,
  isPluginsListCommand,
  isStatusCommand,
  isUpgradeCommand,
  isWarmReadyCommand,
  summarizeMeasurementScopes
} from "./evaluation/records.mjs";
import { checkRequiredBooleanGate, checkRequiredMaxGate, checkRequiredMinGate } from "./evaluation/required-gates.mjs";
import {
  collectGatewayProcessResources,
  collectResourceSummary,
  compactSampleProcess,
  hasActivePrimaryResourceThreshold,
  resolveResourceGate,
  resourceBreakdownSuffix,
  resourceRssLabel
} from "./evaluation/resources.mjs";
import {
  collectBrowserAutomationEvidence,
  collectCronRuntimeEvidence,
  collectDirtyPluginEvidence,
  collectExecToolEvidence,
  collectMcpBridgeEvidence,
  collectMcpToolCallEvidence,
  collectMediaUnderstandingEvidence,
  collectNetworkOfflineEvidence,
  collectOfficialPluginEvidence,
  collectReleaseRecoveryEvidence,
  collectSoakEvidence,
  combineMcpLifecycleEvidence,
  officialPluginInstallFailureMessage
} from "./evaluation/scenario-evidence.mjs";
import { delta, hasAnyThreshold, maxDurationWhere, maxNullable } from "./evaluation/shared.mjs";
import { resolveThresholdPolicy } from "./evaluation/thresholds.mjs";
import {
  collectTimelineSummary,
  diagnosticSpanContractFor,
  missingTimelineSpans,
  requiredTimelineSpans,
  timelineRequirementFor
} from "./evaluation/timeline.mjs";
import {
  checkCpuThreshold,
  checkDuration,
  checkEvidenceThreshold,
  checkRoleThresholds
} from "./evaluation/violations.mjs";
import { buildHealthMeasurement, healthReadinessClassification } from "./health.mjs";
import { profilingAffectsPerformance } from "./performance/instrumentation.mjs";
import { RESOURCE_HEADLINE_CONTRACT, RESOURCE_MEASUREMENT_SCOPE } from "./performance/stats.mjs";

export { compactEvaluatedTimelineEvidence } from "./evaluation/timeline.mjs";

const DIRTY_PLUGIN_METRICS = [
  "dirtyPluginDetected",
  "dirtyPluginReported",
  "dirtyPluginChecksumPreserved",
  "doctorDestructiveChangeCount",
  "pluginsUsableWithDirtyState",
  "gatewaySurvivedDirtyPlugin"
];

const RELEASE_RECOVERY_METRICS = [
  "doctorFixSucceeded",
  "doctorUnrepairedFindingCount",
  "updateRetryVersionDrift",
  "rollbackAvailable",
  "rollbackSucceeded",
  "pluginsUsableAfterUpgrade",
  "pluginsUsableAfterRollback",
  "rollbackPreservedPluginData"
];

const CRON_RUNTIME_METRICS = [
  "cronRegisterMs",
  "cronRunMs",
  "cronRunCompleted",
  "cronTriggerAttributed"
];

const EXEC_TOOL_METRICS = [
  "execSafeCommandMs",
  "execSafeCommandSucceeded",
  "execDangerousCommandBlocked",
  "execOutputTruncated",
  "execTimeoutMs",
  "execProcessLeaks"
];

const MCP_LIFECYCLE_METRICS = [
  "mcpInitializeMs",
  "mcpToolsListMs",
  "mcpShutdownMs",
  "mcpToolCountMin",
  "mcpProcessLeaks"
];

const MCP_TOOL_CALL_METRICS = [
  "mcpToolsCallMs",
  "mcpToolCallSucceeded",
  "mcpToolCallErrorAttributed"
];

export function evaluateRecord(record, scenario, options = {}) {
  const originalStatus = record.status;
  const thresholdPolicy = resolveThresholdPolicy({
    profile: options.profile,
    surface: options.surface,
    scenario,
    nodeVersion: options.targetRuntime === undefined
      ? options.nodeVersion
      : options.targetRuntime?.nodeVersion ?? null
  });
  const thresholds = thresholdPolicy.thresholds;
  const roleThresholds = thresholdPolicy.roleThresholds;
  const violations = [];
  const targetRuntimeIssue = targetRuntimeEvidenceIssue(
    thresholdPolicy.report.runtimeCalibration,
    options.targetRuntime
  );
  if (targetRuntimeIssue !== null) {
    violations.push({
      kind: "evidence",
      metric: "targetRuntime.nodeVersion",
      expected: "Gateway runtime identity with matching OCM service PID and port",
      actual: targetRuntimeIssue,
      failureDomain: "kova-harness",
      message: `Gateway runtime identity was not trusted: ${targetRuntimeIssue}`
    });
  }
  const allResults = collectResults(record);
  const measurementScopeSummary = summarizeMeasurementScopes(record);
  const measuredResults = collectResults(record, { productOnly: true });
  const intervalCpu = measuredResults.some((result) => result.resourceSamples?.cpuMeasurementContract === "linux-process-interval-v1");
  const requireCpuContract = options.requireCpuContract === true || intervalCpu ||
    record.measurements?.resourceHeadlineContract !== undefined;
  const expectedCpuContract = process.platform === "linux" ? "linux-process-interval-v1" : "ps-process-cpu-v1";
  for (const result of measuredResults) {
    const samples = result.resourceSamples;
    if (samples?.cpuCoverageComplete === false || (requireCpuContract && (options.requireCpuContract === true || samples || result.resourceSampleExpected) &&
      (samples?.cpuCoverageComplete !== true || samples?.cpuMeasurementContract !== expectedCpuContract))) {
      violations.push({ kind: "evidence", metric: "resourceCpuCoverage", expected: "complete CPU interval evidence",
        actual: samples?.errors ?? "missing CPU measurement contract or coverage", failureDomain: "kova-harness",
        message: "Product CPU interval evidence is incomplete" });
    }
  }
  const gatewayProcessResources = collectGatewayProcessResources(record, { productOnly: true, intervalCpu });
  const resourceSummary = collectResourceSummary(measuredResults, { gatewayProcessResources });
  const channelWorkflowResources = summarizeChannelWorkflowResources(measuredResults);
  const peakTrackedRssMb = maxNullable(gatewayProcessResources?.peakRssMb, resourceSummary.peakTotalRssMb);
  const cpuPercentMaxTracked = maxNullable(gatewayProcessResources?.maxCpuPercent, resourceSummary.maxTotalCpuPercent);
  const resourceGate = resolveResourceGate(resourceSummary, options.surface, {
    peakTrackedRssMb,
    cpuPercentMaxTracked
  });
  const primaryResourceRole = resourceGate.primaryRole;
  const resourceGateKind = resourceGate.kind;
  const peakRssMb = resourceGate.peakRssMb;
  const cpuPercentMax = resourceGate.cpuPercentMax;
  const primaryRoleOwnsResourceGate =
    resourceGateKind === "role" && resourceGate.role === primaryResourceRole;
  const primaryRoleThresholds = primaryRoleOwnsResourceGate
    ? roleThresholds[primaryResourceRole] ?? {}
    : {};
  const peakRssThreshold = strictestPrimaryThreshold(
    thresholds.peakRssMb,
    primaryRoleThresholds.peakRssMb
  );
  const cpuPercentThreshold = strictestPrimaryThreshold(
    thresholds.cpuPercentMax,
    primaryRoleThresholds.maxCpuPercent
  );
  const commandMissingDependencyErrors = countMissingDependencyErrors(allResults);
  const missingDependencyErrors = combineCommandAndLogCount(
    commandMissingDependencyErrors,
    countLogMetric(record, "missingDependencyErrors", allResults),
    hasSuccessfulLogCommandResult(allResults)
  );
  const pluginLoadFailures = countLogMetric(record, "pluginLoadFailures", allResults, {
    ignoreLine: expectedPluginFailureLineIgnorer(scenario)
  });
  const metadataScanMentions = countLogMetric(record, "metadataScanMentions", allResults);
  const configNormalizationMentions = countLogMetric(record, "configNormalizationMentions", allResults);
  const gatewayRestartCount = countGatewayRestarts(record, allResults);
  const intentionalRestartSourcePids = collectIntentionalRestartSourcePids(record);
  const providerLoadMentions = countLogMetric(record, "providerLoadMentions", allResults);
  const modelCatalogMentions = countLogMetric(record, "modelCatalogMentions", allResults);
  const providerTimeoutMentions = countLogMetric(record, "providerTimeoutMentions", allResults);
  const eventLoopDelayMentions = countLogMetric(record, "eventLoopDelayMentions", allResults);
  const v8DiagnosticMentions = countLogMetric(record, "v8DiagnosticMentions", allResults);
  const v8ReportCount = countDiagnosticMetric(record, "v8ReportCount");
  const heapSnapshotCount = countDiagnosticMetric(record, "heapSnapshotCount");
  const diagnosticArtifactBytes = countDiagnosticMetric(record, "artifactBytes");
  const nodeCpuProfileCount = countNodeProfileMetric(record, "cpuProfileCount");
  const nodeHeapProfileCount = countNodeProfileMetric(record, "heapProfileCount");
  const nodeTraceEventCount = countNodeProfileMetric(record, "traceEventCount");
  const nodeProfileArtifactBytes = countNodeProfileMetric(record, "artifactBytes");
  const nodeProfileTopFunction = collectNodeProfileTopFunction(record);
  const nodeHeapTopFunction = collectNodeHeapTopFunction(record);
  const heapSnapshotBytes = countHeapSnapshotBytes(record);
  const diagnosticReportCount = countDiagnosticReportMetric(record, "fileCount");
  const diagnosticReportBytes = countDiagnosticReportMetric(record, "artifactBytes");
  const gatewayExpected = recordExpectsGateway(record);
  const openclawDiagnostics = collectOpenClawDiagnostics(record);
  const timelineSummary = collectTimelineSummary(record, { intentionalRestartSourcePids });
  const logSummary = collectLogSummary(record);
  const runtimeDepsLogEvidence = collectRuntimeDepsLogEvidence(record);
  const timelineRequirement = timelineRequirementFor(options);
  const requiredOpenSpans = requiredTimelineSpans(options);
  const openRequiredSpans = timelineSummary.openSpansAll.filter((span) => requiredOpenSpans.has(span.name));
  const missingRequiredSpans = missingTimelineSpans(timelineSummary, requiredOpenSpans);
  const diagnosticContract = diagnosticSpanContractFor(options);
  const runtimeDepsStagingMs = maxNullable(
    openclawDiagnostics.runtimeDepsStagingMs,
    timelineSummary.runtimeDepsStageMaxMs,
    runtimeDepsLogEvidence.installMaxMs,
    runtimeDepsLogEvidence.postbuildMaxMs
  );
  const eventLoopDelayMs = maxNullable(
    openclawDiagnostics.eventLoopDelayMs,
    timelineSummary.eventLoopMaxMs,
    logSummary.livenessWarnings.maxEventLoopDelayMaxMs
  );
  const providerModelTimingMs = maxNullable(openclawDiagnostics.providerModelTimingMs, timelineSummary.providerRequestMaxMs);
  const agentTurns = collectAgentTurns(record, record.providerEvidence, scenario, timelineSummary, logSummary);
  const coldAgentTurn = selectAgentTurn(agentTurns, "cold") ?? agentTurns[0] ?? null;
  const warmAgentTurn = selectAgentTurn(agentTurns, "warm") ?? agentTurns[1] ?? null;
  const providerTurn = collectSlowestProviderTurn(agentTurns);
  const agentTurnStats = summarizeAgentTurnStats(agentTurns);
  const agentTurnDiagnostics = summarizeAgentTurnDiagnostics(agentTurns);
  const gatewaySessionPreProviderAttribution = summarizeGatewaySessionPreProviderAttributions(agentTurns);
  const agentCliPreProviderAttribution = summarizeAgentCliPreProviderAttributions(agentTurns);
  const turnPreProviderAttribution = preferredPreProviderAttributionSummary(
    gatewaySessionPreProviderAttribution,
    agentCliPreProviderAttribution
  );
  const agentTurnMs = maxTurnDuration(agentTurns);
  const agentResponseOk = agentTurns.length === 0 ? null : agentTurns.every((turn) => turn.responseOk === true);
  const health = buildHealthMeasurement(record, scenario);
  const agentProviderSimulation = evaluateProviderSimulation({ turns: agentTurns, scenario, record, thresholds, health });
  const agentFailureContainment = evaluateAgentFailureContainment({ turns: agentTurns, record, thresholds, gatewayExpected, health });
  const agentCleanupDiagnosis = diagnoseAgentCleanup(agentTurns, agentTurnStats, thresholds);
  const agentLatencyDiagnosis = diagnoseAgentLatency({
    coldAgentTurn,
    warmAgentTurn,
    providerTurn,
    thresholds,
    timelineSummary,
    authMode: record.auth?.mode ?? null,
    expectedProviderMode: scenario.mockProvider?.mode ?? "normal",
    providerSimulation: agentProviderSimulation
  });
  const finalGatewayState = record.finalMetrics?.service?.gatewayState ?? null;
  const startupHealthP95Ms = health.startupSamples?.p95Ms ?? null;
  const postReadyHealthP95Ms = health.postReadySamples?.p95Ms ?? null;
  const startupHealthFailures = health.startupSamples?.failureCount ?? 0;
  const postReadyHealthFailures = health.postReadySamples?.failureCount ?? 0;
  const finalHealthFailures = health.final?.failureCount ?? null;
  const soakEvidence = collectSoakEvidence(allResults);
  const mcpBridgeEvidence = collectMcpBridgeEvidence(allResults);
  const cronRuntimeEvidence = collectCronRuntimeEvidence(allResults);
  const execToolEvidence = collectExecToolEvidence(allResults);
  const mcpToolCallEvidence = collectMcpToolCallEvidence(allResults);
  const mcpLifecycleEvidence = combineMcpLifecycleEvidence(mcpBridgeEvidence, mcpToolCallEvidence);
  const dirtyPluginEvidence = collectDirtyPluginEvidence(record);
  const releaseRecoveryEvidence = collectReleaseRecoveryEvidence(record);
  const browserAutomationEvidence = collectBrowserAutomationEvidence(allResults);
  const mediaUnderstandingEvidence = collectMediaUnderstandingEvidence(allResults);
  const networkOfflineEvidence = collectNetworkOfflineEvidence(allResults);
  const officialPluginEvidence = collectOfficialPluginEvidence(allResults);
  const listeningFailures = countListeningFailures(record);
  const tcpConnectMaxMs = collectTcpConnectMax(record);
  const readinessHealthReadyMs = health.readiness?.healthReadyAtMs ?? null;
  const readinessFailures = countReadinessFailures(record);
  const readinessClassification = healthReadinessClassification(health);
  const coldReadyMs = maxDurationWhere(allResults, isColdReadyCommand);
  const warmReadyMs = maxDurationWhere(allResults, isWarmReadyCommand);
  const upgradeMs = maxDurationWhere(allResults, isUpgradeCommand);
  const statusMs = maxDurationWhere(allResults, isStatusCommand);
  const pluginsListMs = maxDurationWhere(allResults, isPluginsListCommand);
  const pluginInstallMs = maxDurationWhere(allResults, (command) => command.includes("run-official-plugin-install.mjs") || command.includes(" -- plugins install"));
  const modelsListMs = maxDurationWhere(allResults, isModelsListCommand);
  const doctorFixMs = maxDurationWhere(allResults, isDoctorFixCommand);
  const rssGrowthMb = maxNullable(resourceSummary.maxTotalRssGrowthMb);
  const gatewayRssGrowthMb = maxNullable(resourceSummary.maxGatewayRssGrowthMb);

  checkDuration(violations, allResults, "statusMs", thresholds.statusMs, isStatusCommand);
  checkDuration(violations, allResults, "pluginsListMs", thresholds.pluginsListMs, isPluginsListCommand);
  checkDuration(violations, allResults, "pluginUpdateDryRunMs", thresholds.pluginUpdateDryRunMs, isPluginUpdateDryRunCommand);
  checkDuration(violations, allResults, "modelsListMs", thresholds.modelsListMs, isModelsListCommand);
  checkDuration(
    violations,
    allResults,
    "coldReadyMs",
    thresholds.coldReadyMs ?? thresholds.gatewayReadyMs,
    isColdReadyCommand
  );
  checkDuration(violations, allResults, "warmReadyMs", thresholds.warmReadyMs ?? thresholds.restartReadyMs, isWarmReadyCommand);
  checkDuration(violations, allResults, "upgradeMs", thresholds.upgradeMs, isUpgradeCommand);
  checkDuration(violations, allResults, "doctorFixMs", thresholds.doctorFixMs, isDoctorFixCommand);

  if (resourceGateKind === "role-missing" && hasActivePrimaryResourceThreshold(thresholds, roleThresholds, primaryResourceRole)) {
    violations.push({
      kind: "resource",
      metric: `resourceByRole.${primaryResourceRole}.missing`,
      role: primaryResourceRole,
      resourceGateKind,
      expected: "configured primary resource role observed in product samples",
      actual: "missing",
      attribution: resourceGate.attribution,
      message: `${primaryResourceRole} resource evidence was not captured; configured primary resource role has active resource thresholds${resourceBreakdownSuffix(resourceSummary, resourceGate)}`
    });
  }

  if (peakRssThreshold !== null && peakRssMb !== null && peakRssMb > peakRssThreshold) {
    violations.push({
      kind: "threshold",
      metric: "peakRssMb",
      role: resourceGate.role ?? null,
      resourceGateKind,
      attribution: resourceGate.attribution,
      expected: `<= ${peakRssThreshold}`,
      actual: peakRssMb,
      message: `${resourceRssLabel(primaryResourceRole, resourceGateKind)} ${peakRssMb} MB exceeded threshold ${peakRssThreshold} MB${resourceBreakdownSuffix(resourceSummary, resourceGate)}`
    });
  }

  checkCpuThreshold(violations, {
    kind: "threshold", metric: "cpuPercentMax", label: "max CPU", value: cpuPercentMax,
    lower: resourceGate.role ? resourceSummary.byRole[resourceGate.role]?.maxCpuPercentLower : resourceSummary.maxTotalCpuPercentLower,
    threshold: cpuPercentThreshold ?? undefined
  });
  checkRoleThresholds(violations, resourceSummary.byRole, roleThresholds, {
    skipPeakRssRoles:
      primaryRoleOwnsResourceGate && typeof thresholds.peakRssMb === "number"
        ? [primaryResourceRole]
        : [],
    skipMaxCpuRoles:
      primaryRoleOwnsResourceGate && typeof thresholds.cpuPercentMax === "number"
        ? [primaryResourceRole]
        : []
  });

  const allowedMissingDependencyErrors =
    typeof thresholds.missingDependencyErrors === "number" ? thresholds.missingDependencyErrors : 0;
  if (missingDependencyErrors > allowedMissingDependencyErrors) {
    violations.push({
      kind: "log",
      metric: "missingDependencyErrors",
      expected: `<= ${allowedMissingDependencyErrors}`,
      actual: missingDependencyErrors,
      message: `${missingDependencyErrors} missing dependency/plugin load error patterns found`
    });
  }

  if (typeof thresholds.pluginLoadFailures === "number" && pluginLoadFailures > thresholds.pluginLoadFailures) {
    violations.push({
      kind: "log",
      metric: "pluginLoadFailures",
      expected: `<= ${thresholds.pluginLoadFailures}`,
      actual: pluginLoadFailures,
      message: `${pluginLoadFailures} plugin load failure patterns found`
    });
  }

  if (gatewayExpected && finalGatewayState && finalGatewayState !== "running") {
    violations.push({
      kind: "gateway",
      metric: "finalGatewayState",
      expected: "running",
      actual: finalGatewayState,
      message: `final gateway state was ${finalGatewayState}`
    });
  }

  if (typeof thresholds.startupHealthFailures === "number" && startupHealthFailures > thresholds.startupHealthFailures) {
    violations.push({
      kind: "health",
      metric: "startupHealthFailures",
      expected: `<= ${thresholds.startupHealthFailures}`,
      actual: startupHealthFailures,
      message: `${startupHealthFailures} startup health check(s) failed, over threshold ${thresholds.startupHealthFailures}`
    });
  }

  if (typeof thresholds.postReadyHealthFailures === "number" && postReadyHealthFailures > thresholds.postReadyHealthFailures) {
    violations.push({
      kind: "health",
      metric: "postReadyHealthFailures",
      expected: `<= ${thresholds.postReadyHealthFailures}`,
      actual: postReadyHealthFailures,
      message: `${postReadyHealthFailures} post-ready liveness check(s) failed, over threshold ${thresholds.postReadyHealthFailures}`
    });
  }

  if (
    typeof thresholds.finalHealthFailures === "number" &&
    typeof finalHealthFailures === "number" &&
    finalHealthFailures > thresholds.finalHealthFailures
  ) {
    violations.push({
      kind: "health",
      metric: "finalHealthFailures",
      expected: `<= ${thresholds.finalHealthFailures}`,
      actual: finalHealthFailures,
      message: `${finalHealthFailures} final health check(s) failed, over threshold ${thresholds.finalHealthFailures}`
    });
  }

  if (typeof thresholds.startupHealthP95Ms === "number" && startupHealthP95Ms !== null && startupHealthP95Ms > thresholds.startupHealthP95Ms) {
    violations.push({
      kind: "health",
      metric: "startupHealthP95Ms",
      expected: `<= ${thresholds.startupHealthP95Ms}`,
      actual: startupHealthP95Ms,
      message: `startup health sample p95 ${startupHealthP95Ms}ms exceeded threshold ${thresholds.startupHealthP95Ms}ms`
    });
  }

  if (typeof thresholds.postReadyHealthP95Ms === "number" && postReadyHealthP95Ms !== null && postReadyHealthP95Ms > thresholds.postReadyHealthP95Ms) {
    violations.push({
      kind: "health",
      metric: "postReadyHealthP95Ms",
      expected: `<= ${thresholds.postReadyHealthP95Ms}`,
      actual: postReadyHealthP95Ms,
      message: `post-ready liveness p95 ${postReadyHealthP95Ms}ms exceeded threshold ${thresholds.postReadyHealthP95Ms}ms`
    });
  }

  if (typeof thresholds.soakMinDurationMs === "number" && soakEvidence.durationMs !== null && soakEvidence.durationMs < thresholds.soakMinDurationMs) {
    violations.push({
      kind: "soak",
      metric: "soakDurationMs",
      expected: `>= ${thresholds.soakMinDurationMs}`,
      actual: soakEvidence.durationMs,
      message: `soak loop ran for ${soakEvidence.durationMs}ms, below required duration ${thresholds.soakMinDurationMs}ms`
    });
  }

  if (typeof thresholds.soakCommandP95Ms === "number" && soakEvidence.commandP95Ms !== null && soakEvidence.commandP95Ms > thresholds.soakCommandP95Ms) {
    violations.push({
      kind: "soak",
      metric: "soakCommandP95Ms",
      expected: `<= ${thresholds.soakCommandP95Ms}`,
      actual: soakEvidence.commandP95Ms,
      message: `soak command p95 ${soakEvidence.commandP95Ms}ms exceeded threshold ${thresholds.soakCommandP95Ms}ms`
    });
  }

  if (typeof thresholds.soakCommandFailures === "number" && soakEvidence.commandFailures !== null && soakEvidence.commandFailures > thresholds.soakCommandFailures) {
    violations.push({
      kind: "soak",
      metric: "soakCommandFailures",
      expected: `<= ${thresholds.soakCommandFailures}`,
      actual: soakEvidence.commandFailures,
      message: `${soakEvidence.commandFailures} soak command(s) failed during repeated OpenClaw usage`
    });
  }

  if (typeof thresholds.soakHealthP95Ms === "number" && soakEvidence.healthP95Ms !== null && soakEvidence.healthP95Ms > thresholds.soakHealthP95Ms) {
    violations.push({
      kind: "soak",
      metric: "soakHealthP95Ms",
      expected: `<= ${thresholds.soakHealthP95Ms}`,
      actual: soakEvidence.healthP95Ms,
      message: `soak health p95 ${soakEvidence.healthP95Ms}ms exceeded threshold ${thresholds.soakHealthP95Ms}ms`
    });
  }

  if (typeof thresholds.soakHealthFailures === "number" && soakEvidence.healthFailures !== null && soakEvidence.healthFailures > thresholds.soakHealthFailures) {
    violations.push({
      kind: "soak",
      metric: "soakHealthFailures",
      expected: `<= ${thresholds.soakHealthFailures}`,
      actual: soakEvidence.healthFailures,
      message: `${soakEvidence.healthFailures} soak health check(s) failed during repeated OpenClaw usage`
    });
  }

  if (mcpLifecycleEvidence.available || hasAnyThreshold(thresholds, MCP_LIFECYCLE_METRICS)) {
    checkRequiredMaxGate(violations, "mcp", "mcpInitializeMs", mcpLifecycleEvidence.initializeMs, thresholds.mcpInitializeMs, "MCP initialize");
    checkRequiredMaxGate(violations, "mcp", "mcpToolsListMs", mcpLifecycleEvidence.toolsListMs, thresholds.mcpToolsListMs, "MCP tools/list");
    checkRequiredMaxGate(violations, "mcp", "mcpShutdownMs", mcpLifecycleEvidence.shutdownMs, thresholds.mcpShutdownMs, "MCP shutdown");
    checkRequiredMinGate(violations, "mcp", "mcpToolCountMin", mcpLifecycleEvidence.toolCount, thresholds.mcpToolCountMin, "MCP tool count");
    checkRequiredMaxGate(violations, "mcp", "mcpProcessLeaks", mcpLifecycleEvidence.processLeaks, thresholds.mcpProcessLeaks, "MCP bridge process leak count");
  }

  if (mcpBridgeEvidence.available) {
    if (mcpBridgeEvidence.errors.length > 0) {
      violations.push({
        kind: "mcp",
        metric: "mcpBridgeErrors",
        expected: "0",
        actual: mcpBridgeEvidence.errors.length,
        message: `MCP bridge smoke reported ${mcpBridgeEvidence.errors.length} error(s): ${mcpBridgeEvidence.errors[0]}`
      });
    }
  }

  if (cronRuntimeEvidence.available || hasAnyThreshold(thresholds, CRON_RUNTIME_METRICS)) {
    checkRequiredMaxGate(violations, "cron", "cronRegisterMs", cronRuntimeEvidence.cronRegisterMs, thresholds.cronRegisterMs, "Cron registration");
    checkRequiredMaxGate(violations, "cron", "cronRunMs", cronRuntimeEvidence.cronRunMs, thresholds.cronRunMs, "Cron run");
    checkRequiredBooleanGate(violations, "cron", "cronRunCompleted", cronRuntimeEvidence.cronRunCompleted, thresholds.cronRunCompleted, "Cron run did not complete");
    checkRequiredBooleanGate(violations, "cron", "cronTriggerAttributed", cronRuntimeEvidence.cronTriggerAttributed, thresholds.cronTriggerAttributed, "Cron run was not attributed to a cron trigger");
    if (cronRuntimeEvidence.errors.length > 0) {
      violations.push({
        kind: "cron",
        metric: "cronRuntimeErrors",
        expected: "0",
        actual: cronRuntimeEvidence.errors.length,
        message: `cron runtime smoke reported ${cronRuntimeEvidence.errors.length} error(s): ${cronRuntimeEvidence.errors[0]}`
      });
    }
  }

  if (execToolEvidence.available || hasAnyThreshold(thresholds, EXEC_TOOL_METRICS)) {
    checkRequiredMaxGate(violations, "exec", "execSafeCommandMs", execToolEvidence.safeCommandMs, thresholds.execSafeCommandMs, "Exec safe command");
    checkRequiredMaxGate(violations, "exec", "execTimeoutMs", execToolEvidence.timeoutMs, thresholds.execTimeoutMs, "Exec timeout containment");
    checkRequiredBooleanGate(violations, "exec", "execSafeCommandSucceeded", execToolEvidence.safeCommandSucceeded, thresholds.execSafeCommandSucceeded, "OpenClaw exec safe command did not succeed");
    checkRequiredBooleanGate(violations, "exec", "execDangerousCommandBlocked", execToolEvidence.dangerousCommandBlocked, thresholds.execDangerousCommandBlocked, "OpenClaw exec dangerous command was not blocked");
    checkRequiredBooleanGate(violations, "exec", "execOutputTruncated", execToolEvidence.outputTruncated, thresholds.execOutputTruncated, "Exec output was not bounded");
    checkRequiredMaxGate(violations, "exec", "execProcessLeaks", execToolEvidence.processLeaks, thresholds.execProcessLeaks, "Exec process leak count");
    if (execToolEvidence.dangerousPayloadExecuted === true) {
      violations.push({
        kind: "exec",
        metric: "execDangerousPayloadExecuted",
        expected: false,
        actual: true,
        message: "dangerous exec sentinel was removed; OpenClaw executed the blocked payload"
      });
    }
    if (execToolEvidence.errors.length > 0) {
      violations.push({
        kind: "exec",
        metric: "execToolErrors",
        expected: "0",
        actual: execToolEvidence.errors.length,
        message: `exec tool smoke reported ${execToolEvidence.errors.length} error(s): ${execToolEvidence.errors[0]}`
      });
    }
  }

  if (mcpToolCallEvidence.available || hasAnyThreshold(thresholds, MCP_TOOL_CALL_METRICS)) {
    checkRequiredMaxGate(violations, "mcp", "mcpToolsCallMs", mcpToolCallEvidence.toolsCallMs, thresholds.mcpToolsCallMs, "MCP tools/call");
    checkRequiredBooleanGate(violations, "mcp", "mcpToolCallSucceeded", mcpToolCallEvidence.safeToolSucceeded, thresholds.mcpToolCallSucceeded, "MCP tools/call did not return a successful safe tool result");
    checkRequiredBooleanGate(violations, "mcp", "mcpToolCallErrorAttributed", mcpToolCallEvidence.invalidToolErrorAttributed, thresholds.mcpToolCallErrorAttributed, "MCP invalid tool call was not attributed as a tool error");
    if (mcpToolCallEvidence.errors.length > 0) {
      violations.push({
        kind: "mcp",
        metric: "mcpToolCallErrors",
        expected: "0",
        actual: mcpToolCallEvidence.errors.length,
        message: `MCP tool-call smoke reported ${mcpToolCallEvidence.errors.length} error(s): ${mcpToolCallEvidence.errors[0]}`
      });
    }
  }

  if (dirtyPluginEvidence.available || hasAnyThreshold(thresholds, DIRTY_PLUGIN_METRICS)) {
    checkRequiredBooleanGate(violations, "plugins", "dirtyPluginDetected", dirtyPluginEvidence.dirtyPluginDetected, thresholds.dirtyPluginDetected, "Dirty plugin state was not detected");
    checkRequiredBooleanGate(violations, "plugins", "dirtyPluginReported", dirtyPluginEvidence.dirtyPluginReported, thresholds.dirtyPluginReported, "Dirty plugin state was not reported in plugin command evidence");
    checkRequiredBooleanGate(violations, "plugins", "dirtyPluginChecksumPreserved", dirtyPluginEvidence.dirtyPluginChecksumPreserved, thresholds.dirtyPluginChecksumPreserved, "Dirty plugin checksum evidence was not preserved");
    checkRequiredMaxGate(violations, "plugins", "doctorDestructiveChangeCount", dirtyPluginEvidence.doctorDestructiveChangeCount, thresholds.doctorDestructiveChangeCount, "Doctor destructive dirty-plugin change count");
    checkRequiredBooleanGate(violations, "plugins", "pluginsUsableWithDirtyState", dirtyPluginEvidence.pluginsUsableWithDirtyState, thresholds.pluginsUsableWithDirtyState, "Plugin commands were not usable with dirty plugin state");
    checkRequiredBooleanGate(violations, "plugins", "gatewaySurvivedDirtyPlugin", dirtyPluginEvidence.gatewaySurvivedDirtyPlugin, thresholds.gatewaySurvivedDirtyPlugin, "Gateway did not survive dirty plugin handling");
    if (dirtyPluginEvidence.errors.length > 0) {
      violations.push({
        kind: "plugins",
        metric: "dirtyPluginErrors",
        expected: "0",
        actual: dirtyPluginEvidence.errors.length,
        message: `dirty plugin verifier reported ${dirtyPluginEvidence.errors.length} error(s): ${dirtyPluginEvidence.errors[0]}`
      });
    }
  }

  if (releaseRecoveryEvidence.available || hasAnyThreshold(thresholds, RELEASE_RECOVERY_METRICS)) {
    checkRequiredBooleanGate(violations, "upgrade", "doctorFixSucceeded", releaseRecoveryEvidence.doctorFixSucceeded, thresholds.doctorFixSucceeded, "Doctor repair did not complete successfully");
    checkRequiredMaxGate(violations, "upgrade", "doctorUnrepairedFindingCount", releaseRecoveryEvidence.doctorUnrepairedFindingCount, thresholds.doctorUnrepairedFindingCount, "Doctor unrepaired finding count");
    checkRequiredMaxGate(violations, "upgrade", "updateRetryVersionDrift", releaseRecoveryEvidence.updateRetryVersionDrift, thresholds.updateRetryVersionDrift, "Update retry version drift");
    checkRequiredBooleanGate(violations, "upgrade", "rollbackAvailable", releaseRecoveryEvidence.rollbackAvailable, thresholds.rollbackAvailable, "Rollback snapshot was not available");
    checkRequiredBooleanGate(violations, "upgrade", "rollbackSucceeded", releaseRecoveryEvidence.rollbackSucceeded, thresholds.rollbackSucceeded, "Rollback did not succeed");
    checkRequiredBooleanGate(violations, "upgrade", "pluginsUsableAfterUpgrade", releaseRecoveryEvidence.pluginsUsableAfterUpgrade, thresholds.pluginsUsableAfterUpgrade, "Plugin commands were not usable after upgrade");
    checkRequiredBooleanGate(violations, "upgrade", "pluginsUsableAfterRollback", releaseRecoveryEvidence.pluginsUsableAfterRollback, thresholds.pluginsUsableAfterRollback, "Plugin commands were not usable after rollback");
    checkRequiredBooleanGate(violations, "upgrade", "rollbackPreservedPluginData", releaseRecoveryEvidence.rollbackPreservedPluginData, thresholds.rollbackPreservedPluginData, "Rollback did not preserve plugin fixture data");
    if (releaseRecoveryEvidence.errors.length > 0) {
      violations.push({
        kind: "upgrade",
        metric: "releaseRecoveryErrors",
        expected: "0",
        actual: releaseRecoveryEvidence.errors.length,
        message: `release recovery evidence reported ${releaseRecoveryEvidence.errors.length} error(s): ${releaseRecoveryEvidence.errors[0]}`
      });
    }
  }

  if (browserAutomationEvidence.available) {
    checkEvidenceThreshold(violations, "browser", "browserDoctorMs", browserAutomationEvidence.browserDoctorMs, thresholds.browserDoctorMs, "Browser doctor");
    checkEvidenceThreshold(violations, "browser", "browserStartMs", browserAutomationEvidence.browserStartMs, thresholds.browserStartMs, "Browser start");
    checkEvidenceThreshold(violations, "browser", "browserTabsMs", browserAutomationEvidence.browserTabsMs, thresholds.browserTabsMs, "Browser tabs");
    checkEvidenceThreshold(violations, "browser", "browserOpenMs", browserAutomationEvidence.browserOpenMs, thresholds.browserOpenMs, "Browser open");
    checkEvidenceThreshold(violations, "browser", "browserSnapshotMs", browserAutomationEvidence.browserSnapshotMs, thresholds.browserSnapshotMs, "Browser snapshot");
    checkEvidenceThreshold(violations, "browser", "browserStopMs", browserAutomationEvidence.browserStopMs, thresholds.browserStopMs, "Browser stop");

    if (typeof thresholds.browserTabCountMin === "number" && browserAutomationEvidence.browserTabCount !== null && browserAutomationEvidence.browserTabCount < thresholds.browserTabCountMin) {
      violations.push({
        kind: "browser",
        metric: "browserTabCountMin",
        expected: `>= ${thresholds.browserTabCountMin}`,
        actual: browserAutomationEvidence.browserTabCount,
        message: `Browser automation saw ${browserAutomationEvidence.browserTabCount} tab(s), below required ${thresholds.browserTabCountMin}`
      });
    }

    if (browserAutomationEvidence.browserSnapshotOk === false) {
      violations.push({
        kind: "browser",
        metric: "browserSnapshotOk",
        expected: true,
        actual: false,
        message: "Browser snapshot command did not complete successfully"
      });
    }

    const leakCount = browserAutomationEvidence.browserStopped === false ? 1 : 0;
    if (typeof thresholds.browserProcessLeaks === "number" && leakCount > thresholds.browserProcessLeaks) {
      violations.push({
        kind: "browser",
        metric: "browserProcessLeaks",
        expected: `<= ${thresholds.browserProcessLeaks}`,
        actual: leakCount,
        message: "Browser automation did not stop the managed browser profile cleanly"
      });
    }

    if (browserAutomationEvidence.errors.length > 0) {
      violations.push({
        kind: "browser",
        metric: "browserSmokeErrors",
        expected: "0",
        actual: browserAutomationEvidence.errors.length,
        message: `Browser automation smoke reported ${browserAutomationEvidence.errors.length} error(s): ${browserAutomationEvidence.errors[0]}`
      });
    }
  }

  if (mediaUnderstandingEvidence.available) {
    checkEvidenceThreshold(violations, "media-understanding", "mediaDescribeMs", mediaUnderstandingEvidence.mediaDescribeMs, thresholds.mediaDescribeMs, "Media understanding image describe");
    checkEvidenceThreshold(violations, "media-understanding", "mediaStatusAfterTimeoutMs", mediaUnderstandingEvidence.mediaStatusAfterTimeoutMs, thresholds.mediaStatusAfterTimeoutMs, "Post-media status");

    if (typeof thresholds.mediaTimeoutObserved === "number" && mediaUnderstandingEvidence.mediaTimeoutObserved !== true) {
      violations.push({
        kind: "media-understanding",
        metric: "mediaTimeoutObserved",
        expected: true,
        actual: mediaUnderstandingEvidence.mediaTimeoutObserved,
        message: "Media understanding provider timeout was not observed as a bounded command failure"
      });
    }

    if (mediaUnderstandingEvidence.mediaCommandTimedOut === true) {
      violations.push({
        kind: "media-understanding",
        metric: "mediaCommandTimedOut",
        expected: false,
        actual: true,
        message: "Media understanding command hit Kova's outer timeout instead of OpenClaw's provider timeout"
      });
    }

    if (mediaUnderstandingEvidence.gatewayStatusWorks === false) {
      violations.push({
        kind: "media-understanding",
        metric: "mediaGatewayStatusWorks",
        expected: true,
        actual: false,
        message: "Gateway status did not work after media understanding timeout"
      });
    }

    if (mediaUnderstandingEvidence.errors.length > 0) {
      violations.push({
        kind: "media-understanding",
        metric: "mediaUnderstandingErrors",
        expected: "0",
        actual: mediaUnderstandingEvidence.errors.length,
        message: `Media understanding timeout smoke reported ${mediaUnderstandingEvidence.errors.length} error(s): ${mediaUnderstandingEvidence.errors[0]}`
      });
    }
  }

  if (networkOfflineEvidence.available) {
    checkEvidenceThreshold(violations, "network-offline", "networkTurnMs", networkOfflineEvidence.networkTurnMs, thresholds.networkTurnMs, "Network offline agent turn");
    checkEvidenceThreshold(violations, "network-offline", "networkStatusAfterFailureMs", networkOfflineEvidence.networkStatusAfterFailureMs, thresholds.networkStatusAfterFailureMs, "Post-network status");

    if (typeof thresholds.networkFailureObserved === "number" && networkOfflineEvidence.networkFailureObserved !== true) {
      violations.push({
        kind: "network-offline",
        metric: "networkFailureObserved",
        expected: true,
        actual: networkOfflineEvidence.networkFailureObserved,
        message: "Network/provider failure was not observed as a bounded command failure"
      });
    }

    if (networkOfflineEvidence.networkCommandTimedOut === true) {
      violations.push({
        kind: "network-offline",
        metric: "networkCommandTimedOut",
        expected: false,
        actual: true,
        message: "Network offline command hit Kova's outer timeout instead of OpenClaw surfacing the provider failure"
      });
    }

    if (networkOfflineEvidence.gatewayStatusWorks === false) {
      violations.push({
        kind: "network-offline",
        metric: "networkGatewayStatusWorks",
        expected: true,
        actual: false,
        message: "Gateway status did not work after network/provider failure"
      });
    }

    if (networkOfflineEvidence.errors.length > 0) {
      violations.push({
        kind: "network-offline",
        metric: "networkOfflineErrors",
        expected: "0",
        actual: networkOfflineEvidence.errors.length,
        message: `Network offline smoke reported ${networkOfflineEvidence.errors.length} error(s): ${networkOfflineEvidence.errors[0]}`
      });
    }
  }

  if (officialPluginEvidence.available) {
    checkEvidenceThreshold(violations, "plugins", "pluginInstallMs", officialPluginEvidence.durationMs, thresholds.pluginInstallMs, "Official plugin install");
    if (typeof thresholds.officialPluginInstallOk === "number" && officialPluginEvidence.ok !== true) {
      violations.push({
        kind: "plugins",
        metric: "officialPluginInstallOk",
        expected: true,
        actual: false,
        message: officialPluginInstallFailureMessage(officialPluginEvidence)
      });
    }
    const securityBlockLimit = typeof thresholds.officialPluginSecurityBlocks === "number" ? thresholds.officialPluginSecurityBlocks : 0;
    const securityBlockExceeded = officialPluginEvidence.securityBlockCount > securityBlockLimit;
    if (securityBlockExceeded) {
      violations.push({
        kind: "plugins",
        metric: "officialPluginSecurityBlocks",
        expected: `<= ${securityBlockLimit}`,
        actual: officialPluginEvidence.securityBlockCount,
        message: `official plugin security scanner signal observed: ${officialPluginEvidence.securityEvidence ?? "unknown plugin"}`
      });
    }
  }

  if (typeof thresholds.providerRequestCountMin === "number") {
    const requestCount = record.providerEvidence?.requestCount ?? 0;
    if (requestCount < thresholds.providerRequestCountMin) {
      violations.push({
        kind: "provider",
        metric: "providerRequestCountMin",
        expected: `>= ${thresholds.providerRequestCountMin}`,
        actual: requestCount,
        message: `Provider saw ${requestCount} request(s), below required ${thresholds.providerRequestCountMin}`
      });
    }
  }

  if (typeof thresholds.rssGrowthMb === "number" && rssGrowthMb !== null && rssGrowthMb > thresholds.rssGrowthMb) {
    violations.push({
      kind: "soak",
      metric: "rssGrowthMb",
      expected: `<= ${thresholds.rssGrowthMb}`,
      actual: rssGrowthMb,
      message: `resource-sampled RSS grew by ${rssGrowthMb} MB, over threshold ${thresholds.rssGrowthMb} MB`
    });
  }

  if (typeof thresholds.gatewayRssGrowthMb === "number" && gatewayRssGrowthMb !== null && gatewayRssGrowthMb > thresholds.gatewayRssGrowthMb) {
    violations.push({
      kind: "soak",
      metric: "gatewayRssGrowthMb",
      expected: `<= ${thresholds.gatewayRssGrowthMb}`,
      actual: gatewayRssGrowthMb,
      message: `gateway RSS grew by ${gatewayRssGrowthMb} MB during sampled execution, over threshold ${thresholds.gatewayRssGrowthMb} MB`
    });
  }

  if (readinessClassification?.state === "hard-failure") {
    violations.push({
      kind: "gateway",
      metric: "readiness.classification",
      expected: "ready",
      actual: readinessClassification.state,
      message: `gateway hard failure: ${readinessClassification.reason}`
    });
  }

  if (readinessClassification?.state === "unhealthy") {
    violations.push({
      kind: "gateway",
      metric: "readiness.classification",
      expected: "ready",
      actual: readinessClassification.state,
      message: `gateway unhealthy: ${readinessClassification.reason}`
    });
  }

  if (readinessClassification?.state === "slow-startup") {
    violations.push({
      kind: "gateway",
      metric: "readiness.classification",
      expected: "ready within threshold",
      actual: readinessClassification.state,
      message: `gateway slow startup: ${readinessClassification.reason}`
    });
  }

  const gatewayReadyThreshold = thresholds.gatewayReadyMs ?? thresholds.coldReadyMs;
  if (
    readinessClassification?.state !== "slow-startup" &&
    typeof gatewayReadyThreshold === "number" &&
    readinessHealthReadyMs !== null &&
    readinessHealthReadyMs > gatewayReadyThreshold
  ) {
    violations.push({
      kind: "gateway",
      metric: "readinessHealthReadyMs",
      expected: `<= ${gatewayReadyThreshold}`,
      actual: readinessHealthReadyMs,
      message: `gateway health ready took ${readinessHealthReadyMs}ms, over threshold ${gatewayReadyThreshold}ms`
    });
  }

  if (typeof thresholds.gatewayRestarts === "number" && gatewayRestartCount > thresholds.gatewayRestarts) {
    violations.push({
      kind: "gateway",
      metric: "gatewayRestartCount",
      expected: `<= ${thresholds.gatewayRestarts}`,
      actual: gatewayRestartCount,
      message: `${gatewayRestartCount} gateway restart signals found`
    });
  }

  const allowedProviderTimeouts = typeof thresholds.providerTimeoutMentions === "number" ? thresholds.providerTimeoutMentions : 0;
  if (providerTimeoutMentions > allowedProviderTimeouts) {
    violations.push({
      kind: "provider",
      metric: "providerTimeoutMentions",
      expected: `<= ${allowedProviderTimeouts}`,
      actual: providerTimeoutMentions,
      message: `${providerTimeoutMentions} provider/model timeout signals found`
    });
  }

  const allowedEventLoopMentions = typeof thresholds.eventLoopDelayMentions === "number" ? thresholds.eventLoopDelayMentions : 0;
  if (eventLoopDelayMentions > allowedEventLoopMentions) {
    violations.push({
      kind: "performance",
      metric: "eventLoopDelayMentions",
      expected: `<= ${allowedEventLoopMentions}`,
      actual: eventLoopDelayMentions,
      message: `${eventLoopDelayMentions} event-loop delay signals found`
    });
  }

  if (typeof thresholds.eventLoopDelayMs === "number" && eventLoopDelayMs !== null && eventLoopDelayMs > thresholds.eventLoopDelayMs) {
    violations.push({
      kind: "performance",
      metric: "eventLoopDelayMs",
      expected: `<= ${thresholds.eventLoopDelayMs}`,
      actual: eventLoopDelayMs,
      message: `structured event-loop delay ${eventLoopDelayMs}ms exceeded threshold ${thresholds.eventLoopDelayMs}ms`
    });
  }

  if (typeof thresholds.runtimeDepsStagingMs === "number" && runtimeDepsStagingMs !== null && runtimeDepsStagingMs > thresholds.runtimeDepsStagingMs) {
    violations.push({
      kind: "plugins",
      metric: "runtimeDepsStagingMs",
      expected: `<= ${thresholds.runtimeDepsStagingMs}`,
      actual: runtimeDepsStagingMs,
      message: `runtime dependency staging took ${runtimeDepsStagingMs}ms, over threshold ${thresholds.runtimeDepsStagingMs}ms`
    });
  }

  if (
    typeof thresholds.warmRuntimeDepsRestageCount === "number" &&
    runtimeDepsLogEvidence.warmRestart.installCount !== null &&
    runtimeDepsLogEvidence.warmRestart.installCount > thresholds.warmRuntimeDepsRestageCount
  ) {
    violations.push({
      kind: "plugins",
      metric: "warmRuntimeDepsRestageCount",
      expected: `<= ${thresholds.warmRuntimeDepsRestageCount}`,
      actual: runtimeDepsLogEvidence.warmRestart.installCount,
      message: `warm restart reinstalled bundled runtime deps ${runtimeDepsLogEvidence.warmRestart.installCount} time(s); expected staged deps to be reused`
    });
  }

  if (
    typeof thresholds.warmRuntimeDepsStagingMs === "number" &&
    runtimeDepsLogEvidence.warmRestart.installMaxMs !== null &&
    runtimeDepsLogEvidence.warmRestart.installMaxMs > thresholds.warmRuntimeDepsStagingMs
  ) {
    violations.push({
      kind: "plugins",
      metric: "warmRuntimeDepsStagingMs",
      expected: `<= ${thresholds.warmRuntimeDepsStagingMs}`,
      actual: runtimeDepsLogEvidence.warmRestart.installMaxMs,
      message: `warm restart bundled runtime deps install took ${runtimeDepsLogEvidence.warmRestart.installMaxMs}ms, over threshold ${thresholds.warmRuntimeDepsStagingMs}ms`
    });
  }

  const allowedTimelineParseErrors = typeof thresholds.openclawTimelineParseErrors === "number" ? thresholds.openclawTimelineParseErrors : 0;
  if (timelineRequirement.required && !timelineSummary.available) {
    violations.push({
      kind: "diagnostics",
      metric: "openclawTimelineAvailable",
      expected: "available",
      actual: false,
      message: `OpenClaw diagnostics timeline was required for ${timelineRequirement.reason} but was not emitted`
    });
  }

  if (timelineSummary.available && timelineSummary.parseErrorCount > allowedTimelineParseErrors) {
    violations.push({
      kind: "diagnostics",
      metric: "openclawTimelineParseErrors",
      expected: `<= ${allowedTimelineParseErrors}`,
      actual: timelineSummary.parseErrorCount,
      message: `${timelineSummary.parseErrorCount} OpenClaw diagnostics timeline parse errors found`
    });
  }

  if (openRequiredSpans.length > 0) {
    const slowestOpen = openRequiredSpans[0];
    violations.push({
      kind: "diagnostics",
      metric: "openclawOpenRequiredSpanCount",
      expected: "0",
      actual: openRequiredSpans.length,
      message: `${openRequiredSpans.length} required OpenClaw diagnostics span(s) were left open; slowest ${slowestOpen.name}${slowestOpen.ageMs !== null ? ` age ${slowestOpen.ageMs}ms` : ""}`
    });
  }

  if (timelineSummary.available && missingRequiredSpans.length > 0 && diagnosticContract.enforceMissingSpans) {
    violations.push({
      kind: "diagnostics",
      metric: "openclawMissingRequiredSpanCount",
      expected: "0",
      actual: missingRequiredSpans.length,
      message: `${missingRequiredSpans.length} required OpenClaw diagnostics span(s) were not observed: ${missingRequiredSpans.slice(0, 5).join(", ")}`
    });
  }

  checkGatewaySessionTransport(violations, agentTurns, scenario);
  checkChannelModelTurnCases(violations, agentTurns);

  if (agentResponseOk === false) {
    violations.push({
      kind: "agent",
      metric: "agentResponseOk",
      expected: "true",
      actual: false,
      message: "agent message command finished without a usable assistant response"
    });
  }
  checkAgentTurnCorrectness(violations, agentTurns, scenario.agent?.expectedText ?? null);
  checkAgentTurnThresholds(violations, agentTurns, { coldAgentTurn, warmAgentTurn, providerTurn, agentLatencyDiagnosis }, thresholds, record);
  checkAgentTurnAggregateThresholds(violations, agentTurnStats, thresholds);
  checkProviderSimulation(violations, agentProviderSimulation);
  checkAgentFailureContainment(violations, agentFailureContainment);

  record.measurements = {
    peakRssMb,
    cpuPercentMax,
    measurementScopeSummary,
    resourceMeasurementScope: RESOURCE_MEASUREMENT_SCOPE,
    resourceHeadlineContract: RESOURCE_HEADLINE_CONTRACT,
    resourcePrimaryRole: primaryResourceRole,
    resourceGateKind,
    resourceGateReason: resourceGate.reason,
    resourceGateAttribution: resourceGate.attribution,
    resourcePeakTrackedRssMb: peakTrackedRssMb,
    resourceCpuPercentMaxTracked: cpuPercentMaxTracked,
    coldReadyMs,
    warmReadyMs,
    upgradeMs,
    statusMs,
    doctorFixMs,
    pluginsListMs,
    pluginInstallMs,
    modelsListMs,
    agentTurnMs,
    agentResponseOk,
    agentTurnCount: agentTurns.length,
    agentTurns,
    agentTurnStats,
    agentTurnMedianMs: agentTurnStats.totalTurnMs.median,
    agentTurnP95Ms: agentTurnStats.totalTurnMs.p95,
    agentTurnMaxMs: agentTurnStats.totalTurnMs.max,
    agentPreProviderMedianMs: agentTurnStats.preProviderMs.median,
    agentPreProviderP95Ms: agentTurnStats.preProviderMs.p95,
    agentPreProviderMaxMs: agentTurnStats.preProviderMs.max,
    agentProviderFinalMedianMs: agentTurnStats.providerFinalMs.median,
    agentProviderFinalP95Ms: agentTurnStats.providerFinalMs.p95,
    agentProviderFinalMaxMs: agentTurnStats.providerFinalMs.max,
    agentCleanupMedianMs: agentTurnStats.cleanupMs.median,
    agentCleanupP95Ms: agentTurnStats.cleanupMs.p95,
    agentCleanupMaxMs: agentTurnStats.cleanupMs.max,
    agentMetadataScanCount: agentTurnDiagnostics.metadataScanCount,
    agentMetadataScanTotalMs: agentTurnDiagnostics.metadataScanTotalMs,
    agentMetadataScanMaxMs: agentTurnDiagnostics.metadataScanMaxMs,
    agentEventLoopMaxMs: agentTurnDiagnostics.eventLoopMaxMs,
    agentEventLoopSampleCount: agentTurnDiagnostics.eventLoopSampleCount,
    agentSessionPollCount: agentTurnDiagnostics.sessionPollCount,
    agentSessionPollErrorCount: agentTurnDiagnostics.sessionPollErrorCount,
    gatewaySessionPreProviderAttribution,
    agentCliPreProviderAttribution,
    coldPreProviderAttributedMs: turnPreProviderAttribution.cold.knownAttributedMs.median,
    warmPreProviderAttributedMs: turnPreProviderAttribution.warm.knownAttributedMs.median,
    coldPreProviderUnattributedMs: turnPreProviderAttribution.cold.unattributedMs.median,
    warmPreProviderUnattributedMs: turnPreProviderAttribution.warm.unattributedMs.median,
    coldPreProviderAttributionCoverage: turnPreProviderAttribution.cold.coverageRatio.median,
    warmPreProviderAttributionCoverage: turnPreProviderAttribution.warm.coverageRatio.median,
    coldAgentTurnMs: coldAgentTurn?.totalTurnMs ?? null,
    warmAgentTurnMs: warmAgentTurn?.totalTurnMs ?? null,
    agentColdWarmDeltaMs: delta(coldAgentTurn?.totalTurnMs, warmAgentTurn?.totalTurnMs),
    coldPreProviderMs: coldAgentTurn?.preProviderMs ?? null,
    warmPreProviderMs: warmAgentTurn?.preProviderMs ?? null,
    agentColdWarmPreProviderDeltaMs: delta(coldAgentTurn?.preProviderMs, warmAgentTurn?.preProviderMs),
    coldProviderFinalMs: coldAgentTurn?.providerFinalMs ?? null,
    warmProviderFinalMs: warmAgentTurn?.providerFinalMs ?? null,
    coldFirstByteLatencyMs: coldAgentTurn?.firstByteLatencyMs ?? null,
    warmFirstByteLatencyMs: warmAgentTurn?.firstByteLatencyMs ?? null,
    agentLatencyDiagnosis,
    agentCleanupDiagnosis,
    agentProviderSimulation,
    agentFailureContainment,
    agentProcessLeakCount: agentFailureContainment.processLeakCount,
    agentLeakedProcesses: agentFailureContainment.leakedProcesses,
    agentFailureFixerSummary: buildAgentFailureFixerSummary(agentLatencyDiagnosis, agentCleanupDiagnosis, agentProviderSimulation, agentFailureContainment),
    agentProviderMode: agentProviderSimulation.mode,
    agentProviderIssue: agentProviderSimulation.observedIssue,
    agentProviderContainmentOk: agentProviderSimulation.containmentOk,
    agentProviderRecoveryOk: agentProviderSimulation.recoveryOk,
    providerRequestCount: record.providerEvidence?.requestCount ?? null,
    providerFirstRequestAt: record.providerEvidence?.firstRequestStartAt ?? null,
    providerLastResponseAt: record.providerEvidence?.lastResponseEndAt ?? null,
    providerDurationMs: record.providerEvidence?.providerDurationMs ?? null,
    providerFirstByteLatencyMs: record.providerEvidence?.firstByteLatencyMs ?? null,
    providerFirstChunkLatencyMs: record.providerEvidence?.firstChunkLatencyMs ?? null,
    agentPreProviderMs: providerTurn?.preProviderMs ?? null,
    agentProviderFinalMs: providerTurn?.providerFinalMs ?? null,
    agentPostProviderMs: providerTurn?.postProviderMs ?? null,
    agentPreProviderDominance: providerTurn?.preProviderDominates ?? null,
    agentProviderRequestCount: providerTurn?.requestCount ?? null,
    agentProviderRequestMissing: providerTurn?.missingProviderRequest ?? null,
    agentProviderAttribution: providerTurn,
    health,
    tcpConnectMaxMs,
    missingDependencyErrors,
    finalGatewayState,
    soakEvidence,
    mcpBridgeEvidence,
    mcpLifecycleEvidence,
    cronRuntimeEvidence,
    execToolEvidence,
    mcpToolCallEvidence,
    dirtyPluginEvidence,
    releaseRecoveryEvidence,
    cronStatusMs: cronRuntimeEvidence.cronStatusMs,
    cronRegisterMs: cronRuntimeEvidence.cronRegisterMs,
    cronRunMs: cronRuntimeEvidence.cronRunMs,
    cronRunCompleted: cronRuntimeEvidence.cronRunCompleted,
    cronTriggerAttributed: cronRuntimeEvidence.cronTriggerAttributed,
    execSafeCommandMs: execToolEvidence.safeCommandMs,
    execSafeCommandSucceeded: execToolEvidence.safeCommandSucceeded,
    execDangerousCommandBlocked: execToolEvidence.dangerousCommandBlocked,
    execDangerousPayloadExecuted: execToolEvidence.dangerousPayloadExecuted,
    execOutputTruncated: execToolEvidence.outputTruncated,
    execTimeoutMs: execToolEvidence.timeoutMs,
    execProcessLeaks: execToolEvidence.processLeaks,
    mcpToolsCallMs: mcpToolCallEvidence.toolsCallMs,
    mcpInvalidToolsCallMs: mcpToolCallEvidence.invalidToolsCallMs,
    mcpToolCallSucceeded: mcpToolCallEvidence.safeToolSucceeded,
    mcpSafeToolName: mcpToolCallEvidence.safeToolName,
    mcpToolCallErrorAttributed: mcpToolCallEvidence.invalidToolErrorAttributed,
    dirtyPluginDetected: dirtyPluginEvidence.dirtyPluginDetected,
    dirtyPluginReported: dirtyPluginEvidence.dirtyPluginReported,
    dirtyPluginChecksumPreserved: dirtyPluginEvidence.dirtyPluginChecksumPreserved,
    doctorDestructiveChangeCount: dirtyPluginEvidence.doctorDestructiveChangeCount,
    pluginsUsableWithDirtyState: dirtyPluginEvidence.pluginsUsableWithDirtyState,
    gatewaySurvivedDirtyPlugin: dirtyPluginEvidence.gatewaySurvivedDirtyPlugin,
    doctorFixSucceeded: releaseRecoveryEvidence.doctorFixSucceeded,
    doctorUnrepairedFindingCount: releaseRecoveryEvidence.doctorUnrepairedFindingCount,
    updateRetryVersionDrift: releaseRecoveryEvidence.updateRetryVersionDrift,
    rollbackAvailable: releaseRecoveryEvidence.rollbackAvailable,
    rollbackSucceeded: releaseRecoveryEvidence.rollbackSucceeded,
    pluginsUsableAfterUpgrade: releaseRecoveryEvidence.pluginsUsableAfterUpgrade,
    pluginsUsableAfterRollback: releaseRecoveryEvidence.pluginsUsableAfterRollback,
    rollbackPreservedPluginData: releaseRecoveryEvidence.rollbackPreservedPluginData,
    mcpInitializeMs: mcpLifecycleEvidence.initializeMs,
    mcpToolsListMs: mcpLifecycleEvidence.toolsListMs,
    mcpShutdownMs: mcpLifecycleEvidence.shutdownMs,
    mcpToolCount: mcpLifecycleEvidence.toolCount,
    mcpToolNames: mcpLifecycleEvidence.toolNames,
    mcpProcessExited: mcpLifecycleEvidence.processExited,
    mcpProcessLeaks: mcpLifecycleEvidence.processLeaks,
    mcpErrors: [...mcpBridgeEvidence.errors, ...mcpToolCallEvidence.errors],
    browserAutomationEvidence,
    browserDoctorMs: browserAutomationEvidence.browserDoctorMs,
    browserStartMs: browserAutomationEvidence.browserStartMs,
    browserTabsMs: browserAutomationEvidence.browserTabsMs,
    browserOpenMs: browserAutomationEvidence.browserOpenMs,
    browserSnapshotMs: browserAutomationEvidence.browserSnapshotMs,
    browserStopMs: browserAutomationEvidence.browserStopMs,
    browserTabCount: browserAutomationEvidence.browserTabCount,
    browserSnapshotOk: browserAutomationEvidence.browserSnapshotOk,
    browserStopped: browserAutomationEvidence.browserStopped,
    browserProcessLeaks: browserAutomationEvidence.available ? (browserAutomationEvidence.browserStopped === false ? 1 : 0) : null,
    browserErrors: browserAutomationEvidence.errors,
    mediaUnderstandingEvidence,
    mediaDescribeMs: mediaUnderstandingEvidence.mediaDescribeMs,
    mediaTimeoutObserved: mediaUnderstandingEvidence.mediaTimeoutObserved,
    mediaCommandTimedOut: mediaUnderstandingEvidence.mediaCommandTimedOut,
    mediaStatusAfterTimeoutMs: mediaUnderstandingEvidence.mediaStatusAfterTimeoutMs,
    mediaGatewayStatusWorks: mediaUnderstandingEvidence.gatewayStatusWorks,
    mediaErrors: mediaUnderstandingEvidence.errors,
    networkOfflineEvidence,
    officialPluginEvidence,
    officialPluginInstallOk: officialPluginEvidence.available ? officialPluginEvidence.ok : null,
    officialPluginSecurityBlocks: officialPluginEvidence.available ? officialPluginEvidence.securityBlockCount : null,
    officialPluginInstallMs: officialPluginEvidence.available ? officialPluginEvidence.durationMs : null,
    networkTurnMs: networkOfflineEvidence.networkTurnMs,
    networkFailureObserved: networkOfflineEvidence.networkFailureObserved,
    networkCommandTimedOut: networkOfflineEvidence.networkCommandTimedOut,
    networkStatusAfterFailureMs: networkOfflineEvidence.networkStatusAfterFailureMs,
    networkGatewayStatusWorks: networkOfflineEvidence.gatewayStatusWorks,
    networkErrors: networkOfflineEvidence.errors,
    soakDurationMs: soakEvidence.durationMs,
    soakIterations: soakEvidence.iterations,
    soakCommandP95Ms: soakEvidence.commandP95Ms,
    soakCommandMaxMs: soakEvidence.commandMaxMs,
    soakHealthP95Ms: soakEvidence.healthP95Ms,
    soakHealthMaxMs: soakEvidence.healthMaxMs,
    soakHealthFailures: soakEvidence.healthFailures,
    soakCommandFailures: soakEvidence.commandFailures,
    rssGrowthMb,
    gatewayRssGrowthMb,
    listeningFailures,
    readinessFailures,
    gatewayRestartCount,
    pluginLoadFailures,
    metadataScanMentions,
    configNormalizationMentions,
    providerLoadMentions,
    modelCatalogMentions,
    providerTimeoutMentions,
    eventLoopDelayMentions,
    v8DiagnosticMentions,
    v8ReportCount,
    heapSnapshotCount,
    diagnosticArtifactBytes,
    nodeCpuProfileCount,
    nodeHeapProfileCount,
    nodeTraceEventCount,
    nodeProfileArtifactBytes,
    nodeProfileTopFunction: nodeProfileTopFunction?.functionName ?? null,
    nodeProfileTopFunctionMs: nodeProfileTopFunction?.selfMs ?? null,
    nodeProfileTopFunctionUrl: nodeProfileTopFunction?.url ?? null,
    nodeHeapTopFunction: nodeHeapTopFunction?.functionName ?? null,
    nodeHeapTopFunctionMb: nodeHeapTopFunction?.selfSizeMb ?? null,
    nodeHeapTopFunctionUrl: nodeHeapTopFunction?.url ?? null,
    heapSnapshotBytes,
    diagnosticReportCount,
    diagnosticReportBytes,
    profilingEnabled: record.profiling?.enabled === true,
    profilingResourceInterpretation: record.profiling?.interpretation ?? null,
    profilingBaselineEligible: record.profiling?.baselineEligible ?? null,
    profilingAffectsPerformanceMeasurements: profilingAffectsPerformance(record.profiling),
    profilingAffectsResourceMeasurements: record.profiling?.affectsResourceMeasurements === true,
    resourceSampleCount: resourceSummary.sampleCount,
    resourceSampleArtifacts: resourceSummary.artifacts,
    resourcePeakCommandTreeRssMb: resourceSummary.peakCommandTreeRssMb,
    resourcePeakGatewayRssMb: resourceSummary.peakGatewayRssMb,
    resourceByRole: resourceSummary.byRole,
    resourceTopRolesByRss: resourceSummary.topRolesByRss,
    resourceTopRolesByCpu: resourceSummary.topRolesByCpu,
    resourcePeakRssAtMs: resourceSummary.peakRssSample?.elapsedMs ?? null,
    resourcePeakCpuAtMs: resourceSummary.peakCpuSample?.elapsedMs ?? null,
    resourcePeakRssProcess: compactSampleProcess(resourceSummary.peakRssSample?.topProcess),
    resourcePeakCpuProcess: compactSampleProcess(resourceSummary.peakCpuSample?.topProcess),
    resourceTrend: resourceSummary.trend,
    resourceTopByRss: resourceSummary.topByRss,
    resourceTopByCpu: resourceSummary.topByCpu,
    channelWorkflowResources,
    channelWorkflowResourceTopByGatewayRss: channelWorkflowResources.topByGatewayRss,
    channelWorkflowResourceTopByTrackedRss: channelWorkflowResources.topByTrackedRss,
    openclawTimelineAvailable: timelineSummary.available,
    openclawTimelineArtifacts: timelineSummary.timelineArtifacts,
    openclawTimelineEventCount: timelineSummary.eventCount,
    openclawTimelineParseErrors: timelineSummary.parseErrorCount,
    openclawSlowestSpanName: timelineSummary.slowestSpanName,
    openclawSlowestSpanMs: timelineSummary.slowestSpanMs,
    openclawRepeatedSpanCount: timelineSummary.repeatedSpanCount,
    openclawOpenSpanCount: timelineSummary.openSpanCount,
    openclawOpenRequiredSpanCount: openRequiredSpans.length,
    openclawMissingRequiredSpanCount: missingRequiredSpans.length,
    openclawMissingRequiredSpans: missingRequiredSpans,
    openclawMissingRequiredSpanSeverity: diagnosticContract.missingSpanSeverity,
    openclawDiagnosticsContract: diagnosticContract,
    openclawOpenSpans: timelineSummary.openSpans,
    openclawInterruptedRestartSpanCount: timelineSummary.interruptedRestartSpanCount,
    openclawInterruptedRestartSpans: timelineSummary.interruptedRestartSpans,
    openclawTerminalGatewayPid: timelineSummary.terminalGatewayPid,
    openclawKeySpans: timelineSummary.keySpans,
    openclawEventLoopMaxMs: timelineSummary.eventLoopMaxMs,
    openclawLogEventLoopMaxMs: logSummary.livenessWarnings.maxEventLoopDelayMaxMs,
    openclawLivenessWarningCount: logSummary.livenessWarnings.count,
    embeddedRunTraceCount: logSummary.embeddedRuns.eventCount,
    embeddedRunStartupTraceCount: logSummary.embeddedRuns.startupCount,
    embeddedRunPrepTraceCount: logSummary.embeddedRuns.prepCount,
    embeddedRunTraceMaxMs: logSummary.embeddedRuns.totalMaxMs,
    embeddedRunTopStages: logSummary.embeddedRuns.topStages,
    openclawProviderRequestMaxMs: timelineSummary.providerRequestMaxMs,
    openclawChildProcessFailedCount: timelineSummary.childProcessFailedCount,
    runtimeDepsStagingPluginId: timelineSummary.runtimeDepsStagePluginId,
    runtimeDepsLogEvidence,
    runtimeDepsInstallCount: runtimeDepsLogEvidence.installCount,
    runtimeDepsInstallMaxMs: runtimeDepsLogEvidence.installMaxMs,
    runtimeDepsPostbuildMaxMs: runtimeDepsLogEvidence.postbuildMaxMs,
    coldRuntimeDepsInstallCount: runtimeDepsLogEvidence.coldStart.installCount,
    coldRuntimeDepsStagingMs: runtimeDepsLogEvidence.coldStart.installMaxMs,
    warmRuntimeDepsRestageCount: runtimeDepsLogEvidence.warmRestart.installCount,
    warmRuntimeDepsStagingMs: runtimeDepsLogEvidence.warmRestart.installMaxMs,
    runtimeDepsWarmReuseOk: runtimeDepsLogEvidence.warmRestart.installCount === null
      ? null
      : runtimeDepsLogEvidence.warmRestart.installCount === 0,
    pluginMetadataScanCount: openclawDiagnostics.pluginMetadataScanCount,
    configNormalizationCount: openclawDiagnostics.configNormalizationCount,
    runtimeDepsStagingMs,
    eventLoopDelayMs,
    providerModelTimingMs,
    diagnosticCorrelation: buildDiagnosticCorrelation({
      resourceSummary,
      timelineSummary,
      logSummary,
      nodeProfileTopFunction,
      nodeHeapTopFunction,
      eventLoopDelayMs,
      runtimeDepsStagingMs,
      providerModelTimingMs
    })
  };
  record.thresholdPolicy = thresholdPolicy.report;
  const performanceAssessment = buildInstrumentedPerformanceAssessment({
    record,
    thresholds,
    roleThresholds,
    violations
  });
  const effectiveViolations = performanceAssessment
    ? violations.filter((violation) => !isSkippedPerformanceViolation(record, violation))
    : violations;
  if (performanceAssessment) {
    record.performanceThresholdAssessment = performanceAssessment;
    record.measurements.performanceThresholdSkippedCount =
      performanceAssessment.skippedCount;
  } else {
    delete record.performanceThresholdAssessment;
    delete record.measurements.performanceThresholdSkippedCount;
  }

  if (effectiveViolations.length > 0) {
    if (originalStatus === "PASS") {
      const targetViolation = effectiveViolations.some(
        (violation) => violation.failureDomain !== "kova-harness"
      );
      record.status = targetViolation ? "FAIL" : "BLOCKED";
    }
    record.violations = effectiveViolations;
  } else {
    delete record.violations;
  }

  return record;
}

function targetRuntimeEvidenceIssue(runtimeCalibration, targetRuntime) {
  if ((runtimeCalibration ?? []).length === 0 || targetRuntime === undefined) {
    return null;
  }
  if (
    !targetRuntime ||
    !["ok", "compatibility-fallback"].includes(targetRuntime.collectionStatus)
  ) {
    return targetRuntime?.collectionStatus ?? "missing";
  }
  if (
    typeof targetRuntime.nodeVersion !== "string" ||
    !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(targetRuntime.nodeVersion)
  ) {
    return "invalid-node-version";
  }
  if (
    !Number.isSafeInteger(targetRuntime.gatewayPid) ||
    targetRuntime.gatewayPid <= 0 ||
    !Number.isSafeInteger(targetRuntime.expectedGatewayPid) ||
    targetRuntime.expectedGatewayPid <= 0 ||
    !Number.isSafeInteger(targetRuntime.gatewayPort) ||
    targetRuntime.gatewayPort <= 0 ||
    !Number.isSafeInteger(targetRuntime.expectedGatewayPort) ||
    targetRuntime.expectedGatewayPort <= 0
  ) {
    return "invalid-gateway-identity";
  }
  if (
    targetRuntime.gatewayPid !== targetRuntime.expectedGatewayPid ||
    targetRuntime.gatewayPort !== targetRuntime.expectedGatewayPort
  ) {
    return "identity-mismatch";
  }
  return null;
}

function strictestPrimaryThreshold(headlineThreshold, roleThreshold) {
  if (typeof headlineThreshold !== "number") {
    return null;
  }
  return typeof roleThreshold === "number"
    ? Math.min(headlineThreshold, roleThreshold)
    : headlineThreshold;
}
