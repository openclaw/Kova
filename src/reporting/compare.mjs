import { measurementMetricValue } from "../health.mjs";
import { buildReportSummary } from "./report.mjs";

const defaultThresholds = {
  missingDependencyErrors: 0,
  pluginLoadFailures: 0,
  peakRssMb: 100,
  cpuPercentMax: 25,
  coldReadyMs: 5000,
  warmReadyMs: 3000,
  upgradeMs: 10000,
  statusMs: 1000,
  pluginsListMs: 1000,
  modelsListMs: 3000,
  agentTurnMs: 10000,
  coldAgentTurnMs: 10000,
  warmAgentTurnMs: 5000,
  agentColdWarmDeltaMs: 10000,
  coldPreProviderMs: 5000,
  warmPreProviderMs: 2500,
  agentMetadataScanCount: 5,
  agentMetadataScanTotalMs: 1000,
  agentEventLoopMaxMs: 250,
  agentSessionPollCount: 10,
  tcpConnectMaxMs: 250,
  readinessListeningMs: 3000,
  readinessHealthReadyMs: 5000,
  readinessFailures: 0,
  startupHealthFailures: 0,
  postReadyHealthFailures: 0,
  finalHealthFailures: 0,
  startupHealthP95Ms: 1000,
  postReadyHealthP95Ms: 1000,
  gatewayRestartCount: 0,
  providerTimeoutMentions: 0,
  eventLoopDelayMentions: 0,
  metadataScanMentions: 10,
  configNormalizationMentions: 10,
  pluginMetadataScanCount: 10,
  configNormalizationCount: 10,
  runtimeDepsStagingMs: 5000,
  eventLoopDelayMs: 250,
  providerModelTimingMs: 5000,
  diagnosticArtifactBytes: 25 * 1024 * 1024,
  heapSnapshotBytes: 50 * 1024 * 1024,
  resourcePeakCommandTreeRssMb: 100,
  resourcePeakGatewayRssMb: 100,
  resourcePeakTrackedRssMb: 100,
  resourceCpuPercentMaxTracked: 25,
  openclawTimelineParseErrors: 0,
  openclawSlowestSpanMs: 5000,
  openclawEventLoopMaxMs: 250,
  openclawProviderRequestMaxMs: 5000,
  openclawChildProcessFailedCount: 0,
  nodeProfileArtifactBytes: 100 * 1024 * 1024,
  nodeProfileTopFunctionMs: 5000
};

const COMPARE_METRICS = [
  "peakRssMb",
  "cpuPercentMax",
  "coldReadyMs",
  "warmReadyMs",
  "upgradeMs",
  "statusMs",
  "pluginsListMs",
  "modelsListMs",
  "agentTurnMs",
  "coldAgentTurnMs",
  "warmAgentTurnMs",
  "agentColdWarmDeltaMs",
  "coldPreProviderMs",
  "warmPreProviderMs",
  "agentColdWarmPreProviderDeltaMs",
  "coldPreProviderAttributedMs",
  "warmPreProviderAttributedMs",
  "coldPreProviderUnattributedMs",
  "warmPreProviderUnattributedMs",
  "coldPreProviderAttributionCoverage",
  "warmPreProviderAttributionCoverage",
  "coldProviderFinalMs",
  "warmProviderFinalMs",
  "agentMetadataScanCount",
  "agentMetadataScanTotalMs",
  "agentMetadataScanMaxMs",
  "agentEventLoopMaxMs",
  "agentEventLoopSampleCount",
  "agentSessionPollCount",
  "agentSessionPollErrorCount",
  "tcpConnectMaxMs",
  "readinessListeningMs",
  "readinessHealthReadyMs",
  "startupHealthP95Ms",
  "postReadyHealthP95Ms",
  "startupHealthFailures",
  "postReadyHealthFailures",
  "finalHealthFailures",
  "readinessFailures",
  "missingDependencyErrors",
  "pluginLoadFailures",
  "gatewayRestartCount",
  "metadataScanMentions",
  "configNormalizationMentions",
  "providerLoadMentions",
  "modelCatalogMentions",
  "providerTimeoutMentions",
  "eventLoopDelayMentions",
  "v8ReportCount",
  "heapSnapshotCount",
  "diagnosticArtifactBytes",
  "nodeCpuProfileCount",
  "nodeHeapProfileCount",
  "nodeTraceEventCount",
  "nodeProfileArtifactBytes",
  "nodeProfileTopFunctionMs",
  "heapSnapshotBytes",
  "resourceSampleCount",
  "resourcePeakTrackedRssMb",
  "resourceCpuPercentMaxTracked",
  "resourcePeakCommandTreeRssMb",
  "resourcePeakGatewayRssMb",
  "openclawTimelineEventCount",
  "openclawTimelineParseErrors",
  "openclawSlowestSpanMs",
  "openclawRepeatedSpanCount",
  "openclawEventLoopMaxMs",
  "openclawProviderRequestMaxMs",
  "openclawChildProcessFailedCount",
  "pluginMetadataScanCount",
  "configNormalizationCount",
  "runtimeDepsStagingMs",
  "eventLoopDelayMs",
  "providerModelTimingMs"
];

const RESOURCE_COMPARISON_METRICS = new Set([
  "peakRssMb",
  "cpuPercentMax",
  "resourceSampleCount",
  "resourcePeakCommandTreeRssMb",
  "resourcePeakGatewayRssMb",
  "resourcePeakTrackedRssMb",
  "resourceCpuPercentMaxTracked"
]);

export function compareReports(baseline, current, options = {}) {
  const thresholds = resolveThresholds(options.thresholds);
  const baselineSummary = buildReportSummary(baseline);
  const currentSummary = buildReportSummary(current);
  const baselineRecords = groupRecords(baseline.records ?? []);
  const currentRecords = groupRecords(current.records ?? []);
  const scenarios = [];
  let skippedMetricCount = 0;
  let resourceContractMismatchCount = 0;

  for (const [key, currentGroup] of currentRecords.entries()) {
    const baselineGroup = baselineRecords.get(key);
    const currentFirst = currentGroup[0] ?? {};
    if (!baselineGroup) {
      scenarios.push({
        key,
        scenario: currentFirst.scenario,
        state: currentFirst.state?.id ?? null,
        status: "NEW",
        currentStatus: groupWorstStatus(currentGroup),
        baselineStatus: null,
        baselineStatuses: {},
        currentStatuses: statusCounts(currentGroup),
        baselineSampleCount: 0,
        currentSampleCount: currentGroup.length,
        resourceComparison: {
          baseline: null,
          current: resourceIdentity(current, currentGroup),
          compatible: null
        },
        skippedMetrics: [],
        regressions: [],
        metrics: metricDeltas([], currentGroup, thresholds)
      });
      continue;
    }

    const regressions = [];
    const resourceComparison = compareResourceIdentity(
      resourceIdentity(baseline, baselineGroup),
      resourceIdentity(current, currentGroup)
    );
    const baselineStatus = groupWorstStatus(baselineGroup);
    const currentStatus = groupWorstStatus(currentGroup);
    if (statusRank(currentStatus) > statusRank(baselineStatus)) {
      regressions.push({
        kind: "status",
        metric: "status",
        baseline: baselineStatus,
        current: currentStatus,
        message: `status regressed from ${baselineStatus} to ${currentStatus}`
      });
    }

    regressions.push(...metricRegressions(baselineGroup, currentGroup, thresholds, {
      resourceComparable: resourceComparison.compatible
    }));

    const metrics = metricDeltas(baselineGroup, currentGroup, thresholds, {
      resourceComparable: resourceComparison.compatible
    });
    const skippedMetrics = Object.entries(metrics)
      .filter(([, metric]) => metric.comparable === false)
      .map(([metric]) => metric);
    if (!resourceComparison.compatible) {
      resourceContractMismatchCount += 1;
      skippedMetricCount += skippedMetrics.length;
    }

    scenarios.push({
      key,
      scenario: currentFirst.scenario,
      state: currentFirst.state?.id ?? null,
      status: regressions.length > 0 ? "REGRESSED" : "OK",
      currentStatus,
      baselineStatus,
      baselineStatuses: statusCounts(baselineGroup),
      currentStatuses: statusCounts(currentGroup),
      baselineSampleCount: baselineGroup.length,
      currentSampleCount: currentGroup.length,
      resourceComparison,
      skippedMetrics,
      regressions,
      metrics
    });
  }

  for (const [key, baselineGroup] of baselineRecords.entries()) {
    if (currentRecords.has(key)) {
      continue;
    }
    const baselineFirst = baselineGroup[0] ?? {};
    scenarios.push({
      key,
      scenario: baselineFirst.scenario,
      state: baselineFirst.state?.id ?? null,
      status: "MISSING",
      currentStatus: null,
      baselineStatus: groupWorstStatus(baselineGroup),
      baselineStatuses: statusCounts(baselineGroup),
      currentStatuses: {},
      baselineSampleCount: baselineGroup.length,
      currentSampleCount: 0,
      resourceComparison: {
        baseline: resourceIdentity(baseline, baselineGroup),
        current: null,
        compatible: null
      },
      skippedMetrics: [],
      regressions: [{
        kind: "coverage",
        metric: "scenario",
        baseline: "present",
        current: "missing",
        message: "scenario/state entry missing from current report"
      }],
      metrics: {}
    });
  }

  const scenarioRegressionCount = scenarios.reduce((count, scenario) => count + scenario.regressions.length, 0);
  const statusChanges = compareGroupStatuses(baselineSummary.groups, currentSummary.groups);
  const findingChanges = compareFindings(baselineSummary.findings, currentSummary.findings);
  const newBlockingFindingCount = findingChanges.new.filter(isBlockingFinding).length;
  const regressionCount = scenarioRegressionCount + statusChanges.regressions.length + newBlockingFindingCount;
  const sourceRelease = compareSourceReleaseDiagnostics(baseline, current);
  const sourceReleaseBlockingCount = sourceRelease?.blockingCount ?? 0;
  return {
    schemaVersion: "kova.compare.v1",
    generatedAt: new Date().toISOString(),
    baseline: reportSummary(baseline, baselineSummary),
    current: reportSummary(current, currentSummary),
    thresholds,
    sourceRelease,
    ok: regressionCount === 0 && sourceReleaseBlockingCount === 0,
    regressionCount,
    scenarioRegressionCount,
    skippedMetricCount,
    resourceContractMismatchCount,
    statusChanges,
    findingChanges,
    improvementCount: statusChanges.improvements.length + findingChanges.resolved.length,
    scenarios
  };
}

export function renderCompareFixerSummary(comparison) {
  const lines = [
    "Kova OpenClaw Regression Summary",
    "",
    `Baseline: ${comparison.baseline.runId ?? "unknown"} (${comparison.baseline.target ?? "unknown"})`,
    `Current: ${comparison.current.runId ?? "unknown"} (${comparison.current.target ?? "unknown"})`,
    `Result: ${comparison.ok ? "OK" : "REGRESSED"}`,
    ""
  ];

  appendResourceComparisonSummary(lines, comparison);
  if (comparison.ok) {
    lines.push("No blocking regressions were detected.");
    return lines.join("\n");
  }

  if (comparison.sourceRelease && comparison.sourceRelease.blockingCount > 0) {
    lines.push("Source/release diagnostic comparison:");
    for (const finding of comparison.sourceRelease.findings.filter((item) => item.severity === "blocking")) {
      lines.push(`- ${finding.message}`);
    }
    lines.push("");
  }

  if (comparison.statusChanges?.regressions?.length > 0) {
    lines.push("Status regressions:");
    for (const change of comparison.statusChanges.regressions) {
      lines.push(`- ${change.key}: ${change.baselineLabel} -> ${change.currentLabel}`);
    }
    lines.push("");
  }

  if (comparison.findingChanges?.new?.some(isBlockingFinding)) {
    lines.push("New findings:");
    for (const finding of comparison.findingChanges.new.filter(isBlockingFinding).slice(0, 8)) {
      lines.push(`- ${finding.scenario ?? "run"}${finding.state ? `/${finding.state}` : ""}: ${finding.summary}`);
    }
    lines.push("");
  }

  for (const scenario of comparison.scenarios.filter((item) => item.regressions.length > 0)) {
    lines.push(`Scenario: ${scenario.key}`);
    lines.push(`Status: ${scenario.baselineStatus ?? "missing"} -> ${scenario.currentStatus ?? "missing"}`);
    lines.push("Fixer notes:");
    for (const regression of scenario.regressions) {
      lines.push(`- ${regression.message}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function renderCompareSummary(comparison) {
  const lines = [
    `Baseline: ${comparison.baseline.runId ?? "unknown"} (${comparison.baseline.target ?? "unknown"})`,
    `Current: ${comparison.current.runId ?? "unknown"} (${comparison.current.target ?? "unknown"})`,
    `Result: ${comparison.ok ? "OK" : "REGRESSED"}`,
    `Regressions: ${comparison.regressionCount}`,
    `Improvements: ${comparison.improvementCount ?? 0}`,
    `Resource contract mismatches: ${comparison.resourceContractMismatchCount ?? 0}`,
    `Skipped resource metrics: ${comparison.skippedMetricCount ?? 0}`,
    "",
    "Status changes:"
  ];

  for (const change of comparison.statusChanges?.changes ?? []) {
    lines.push(`- ${change.direction.toUpperCase()} ${change.key}: ${change.baselineLabel} -> ${change.currentLabel}`);
  }
  if ((comparison.statusChanges?.changes ?? []).length === 0) {
    lines.push("- none");
  }

  if (comparison.findingChanges) {
    lines.push("");
    lines.push("Findings:");
    if (comparison.findingChanges.new.length === 0 && comparison.findingChanges.resolved.length === 0) {
      lines.push("- no finding changes");
    }
    for (const finding of comparison.findingChanges.new.slice(0, 8)) {
      lines.push(`- NEW ${finding.severity.toUpperCase()} ${finding.scenario ?? "run"}${finding.state ? `/${finding.state}` : ""}: ${finding.summary}`);
    }
    for (const finding of comparison.findingChanges.resolved.slice(0, 8)) {
      lines.push(`- RESOLVED ${finding.severity.toUpperCase()} ${finding.scenario ?? "run"}${finding.state ? `/${finding.state}` : ""}: ${finding.summary}`);
    }
  }

  if ((comparison.resourceContractMismatchCount ?? 0) > 0) {
    lines.push("");
    lines.push("Resource comparisons:");
    for (const scenario of resourceContractMismatches(comparison)) {
      lines.push(`- ${scenario.key}: ${formatResourceIdentity(scenario.resourceComparison.baseline)} -> ${formatResourceIdentity(scenario.resourceComparison.current)}`);
      lines.push(`  skipped: ${scenario.skippedMetrics.join(", ") || "none"}`);
    }
  }

  lines.push("");
  lines.push("Metric regressions:");
  const regressedScenarios = comparison.scenarios.filter((item) => item.regressions.length > 0);
  if (regressedScenarios.length === 0) {
    lines.push("- none");
  }
  for (const scenario of regressedScenarios) {
    lines.push(`- ${scenario.status} ${scenario.key}`);
    for (const regression of scenario.regressions) {
      lines.push(`  ${regression.message}`);
    }
  }

  if (comparison.sourceRelease) {
    lines.push("");
    lines.push("Source/release diagnostics:");
    lines.push(`- Status: ${comparison.sourceRelease.ok ? "OK" : "NEEDS_WORK"}`);
    lines.push(`- Pairs: ${comparison.sourceRelease.pairCount}`);
    lines.push(`- Blocking: ${comparison.sourceRelease.blockingCount}`);
    for (const finding of comparison.sourceRelease.findings.slice(0, 8)) {
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.key ?? "comparison"}: ${finding.message}`);
    }
  }

  return lines.join("\n");
}

function indexRecords(records) {
  const index = new Map();
  for (const record of records) {
    index.set(recordKey(record), record);
  }
  return index;
}

function groupRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = recordKey(record);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(record);
  }
  return groups;
}

function recordKey(record) {
  return `${record.scenario}:${record.state?.id ?? "none"}`;
}

function groupWorstStatus(records = []) {
  let worst = "PASS";
  for (const record of records) {
    if (statusRank(record.status) > statusRank(worst)) {
      worst = record.status;
    }
  }
  return worst;
}

function statusCounts(records = []) {
  const counts = {};
  for (const record of records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  }
  return counts;
}

function reportSummary(report, summary) {
  return {
    runId: report.runId ?? null,
    mode: report.mode ?? null,
    profile: report.profile?.id ?? null,
    target: report.target ?? null,
    targetKind: targetKind(report.target),
    generatedAt: report.generatedAt ?? null,
    statuses: report.summary?.statuses ?? {},
    decision: summary.decision,
    findingCount: summary.findings.length,
    groupCount: summary.groups.length,
    sampleCount: summary.samples.length,
    resourceMeasurementScope: report.performance?.resourceMeasurementScope ?? null,
    resourceHeadlineContract: report.performance?.resourceHeadlineContract ?? null
  };
}

function appendResourceComparisonSummary(lines, comparison) {
  const mismatches = resourceContractMismatches(comparison);
  if (mismatches.length === 0) {
    return;
  }
  lines.push(`Resource contract mismatches: ${comparison.resourceContractMismatchCount ?? mismatches.length}`);
  lines.push(`Skipped resource metrics: ${comparison.skippedMetricCount ?? 0}`);
  for (const scenario of mismatches.slice(0, 6)) {
    lines.push(`- ${scenario.key}: ${formatResourceIdentity(scenario.resourceComparison.baseline)} -> ${formatResourceIdentity(scenario.resourceComparison.current)}; skipped ${scenario.skippedMetrics.join(", ") || "none"}`);
  }
  if (mismatches.length > 6) {
    lines.push(`- ${mismatches.length - 6} more resource contract mismatches`);
  }
  lines.push("");
}

function resourceContractMismatches(comparison) {
  return (comparison.scenarios ?? []).filter((scenario) => scenario.resourceComparison?.compatible === false);
}

function formatResourceIdentity(identity) {
  if (!identity) {
    return "missing";
  }
  const value = `${identity.measurementScope ?? "unknown-scope"}/${identity.headlineContract ?? "unknown-contract"}`;
  return identity.mixed ? `${value} (mixed)` : value;
}

function resourceIdentity(report, records = []) {
  const variants = records.length > 0
    ? records.map((record) => resourceIdentityForRecord(report, record))
    : [resourceIdentityForRecord(report, null)];
  const unique = new Map(variants.map((identity) => [resourceIdentityKey(identity), identity]));
  if (unique.size === 1) {
    return variants[0];
  }
  const scopes = new Set(variants.map((identity) => identity.measurementScope));
  const contracts = new Set(variants.map((identity) => identity.headlineContract));
  return {
    measurementScope: scopes.size === 1 ? variants[0].measurementScope : null,
    headlineContract: contracts.size === 1 ? variants[0].headlineContract : null,
    mixed: true,
    variants: [...unique.values()]
  };
}

function resourceIdentityForRecord(report, record) {
  const state = record?.state?.id ?? null;
  const surface = record?.surface ?? null;
  const group = (report.performance?.groups ?? []).find((candidate) =>
    candidate.scenario === record?.scenario &&
    (candidate.state ?? null) === state &&
    (candidate.surface ?? null) === surface
  );
  return {
    measurementScope:
      record?.measurements?.resourceMeasurementScope ??
      group?.resourceMeasurementScope ??
      report.performance?.resourceMeasurementScope ??
      null,
    headlineContract:
      record?.measurements?.resourceHeadlineContract ??
      group?.resourceHeadlineContract ??
      report.performance?.resourceHeadlineContract ??
      null
  };
}

function resourceIdentityKey(identity) {
  return `${identity.measurementScope ?? "<missing>"}\u0000${identity.headlineContract ?? "<missing>"}`;
}

function compareResourceIdentity(baseline, current) {
  const scopeCompatible =
    !baseline.mixed &&
    !current.mixed &&
    typeof baseline.measurementScope === "string" &&
    baseline.measurementScope === current.measurementScope;
  const headlineContractCompatible =
    !baseline.mixed &&
    !current.mixed &&
    typeof baseline.headlineContract === "string" &&
    baseline.headlineContract === current.headlineContract;
  return {
    baseline,
    current,
    scopeCompatible,
    headlineContractCompatible,
    compatible: scopeCompatible && headlineContractCompatible
  };
}

function compareGroupStatuses(baselineGroups = [], currentGroups = []) {
  const baselineByKey = new Map(baselineGroups.map((group) => [group.key, group]));
  const currentByKey = new Map(currentGroups.map((group) => [group.key, group]));
  const changes = [];
  for (const [key, currentGroup] of currentByKey.entries()) {
    const baselineGroup = baselineByKey.get(key);
    if (!baselineGroup) {
      continue;
    }
    const baselineWorst = worstGroupStatus(baselineGroup.statuses);
    const currentWorst = worstGroupStatus(currentGroup.statuses);
    if (baselineWorst.rank === currentWorst.rank && statusCountsText(baselineGroup.statuses) === statusCountsText(currentGroup.statuses)) {
      continue;
    }
    const direction = currentWorst.rank > baselineWorst.rank
      ? "regressed"
      : currentWorst.rank < baselineWorst.rank
        ? "improved"
        : "changed";
    changes.push({
      key,
      scenario: currentGroup.scenario ?? baselineGroup.scenario ?? null,
      state: currentGroup.state ?? baselineGroup.state ?? null,
      direction,
      baseline: baselineGroup.statuses ?? {},
      current: currentGroup.statuses ?? {},
      baselineLabel: statusCountsText(baselineGroup.statuses),
      currentLabel: statusCountsText(currentGroup.statuses)
    });
  }
  return {
    changes,
    improvements: changes.filter((change) => change.direction === "improved"),
    regressions: changes.filter((change) => change.direction === "regressed")
  };
}

function compareFindings(baselineFindings = [], currentFindings = []) {
  const baselineByKey = new Map(baselineFindings.map((finding) => [findingKey(finding), finding]));
  const currentByKey = new Map(currentFindings.map((finding) => [findingKey(finding), finding]));
  return {
    new: [...currentByKey.entries()]
      .filter(([key]) => !baselineByKey.has(key))
      .map(([, finding]) => finding),
    resolved: [...baselineByKey.entries()]
      .filter(([key]) => !currentByKey.has(key))
      .map(([, finding]) => finding),
    unchangedCount: [...currentByKey.keys()].filter((key) => baselineByKey.has(key)).length
  };
}

function worstGroupStatus(statuses = {}) {
  let worst = { status: "PASS", rank: 0 };
  for (const [status, count] of Object.entries(statuses)) {
    if (!count) {
      continue;
    }
    const rank = statusRank(status);
    if (rank > worst.rank) {
      worst = { status, rank };
    }
  }
  return worst;
}

function statusCountsText(statuses = {}) {
  return Object.entries(statuses).map(([status, count]) => `${status}:${count}`).join(", ") || "none";
}

function findingKey(finding) {
  return [
    finding.severity ?? "unknown",
    finding.kind ?? "finding",
    finding.scenario ?? "run",
    finding.state ?? "none",
    finding.metric ?? "none",
    finding.command ?? (finding.metric ? "metric" : finding.id ?? "none")
  ].join("|");
}

function isBlockingFinding(finding) {
  return ["blocking", "blocked", "fail"].includes(finding?.severity);
}

function compareSourceReleaseDiagnostics(leftReport, rightReport) {
  const leftLane = targetLane(leftReport.target);
  const rightLane = targetLane(rightReport.target);
  if (!leftLane || !rightLane || leftLane === rightLane) {
    return null;
  }

  const sourceReport = leftLane === "source-build" ? leftReport : rightReport;
  const releaseReport = leftLane === "release-runtime" ? leftReport : rightReport;
  const sourceRecords = indexRecords(sourceReport.records ?? []);
  const releaseRecords = indexRecords(releaseReport.records ?? []);
  const keys = [...sourceRecords.keys()].filter((key) => releaseRecords.has(key)).sort();
  const findings = [];
  const pairs = [];

  if (keys.length === 0) {
    findings.push({
      severity: "blocking",
      key: null,
      message: "source-build and release-runtime reports have no shared scenario/state records, so diagnostic parity cannot be evaluated"
    });
  }

  for (const key of keys) {
    const source = sourceRecords.get(key);
    const release = releaseRecords.get(key);
    const pair = sourceReleasePair(key, source, release);
    pairs.push(pair);
    if (!pair.source.timelineAvailable) {
      findings.push({
        severity: "blocking",
        key,
        message: `${key} source-build report did not include OpenClaw timeline diagnostics`
      });
    }
    if (!pair.release.timelineAvailable) {
      findings.push({
        severity: "info",
        key,
        message: `${key} release-runtime report has no timeline; use outside-in timings for released packages`
      });
    }
    if (typeof pair.source.agentPreProviderMs === "number" && typeof pair.release.agentPreProviderMs === "number") {
      const delta = pair.release.agentPreProviderMs - pair.source.agentPreProviderMs;
      if (delta > defaultThresholds.coldPreProviderMs) {
        findings.push({
          severity: "warning",
          key,
          message: `${key} release pre-provider latency exceeded source-build by ${delta}ms (${pair.source.agentPreProviderMs}ms -> ${pair.release.agentPreProviderMs}ms)`
        });
      }
    }
  }

  const blockingCount = findings.filter((finding) => finding.severity === "blocking").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const infoCount = findings.filter((finding) => finding.severity === "info").length;
  return {
    schemaVersion: "kova.sourceReleaseComparison.v1",
    sourceTarget: sourceReport.target ?? null,
    releaseTarget: releaseReport.target ?? null,
    ok: blockingCount === 0,
    pairCount: pairs.length,
    blockingCount,
    warningCount,
    infoCount,
    pairs,
    findings
  };
}

function sourceReleasePair(key, source, release) {
  return {
    key,
    scenario: source.scenario ?? release.scenario ?? null,
    state: source.state?.id ?? release.state?.id ?? null,
    surface: source.surface ?? release.surface ?? source.measurements?.surface ?? release.measurements?.surface ?? null,
    source: diagnosticRecordSummary(source),
    release: diagnosticRecordSummary(release)
  };
}

function diagnosticRecordSummary(record) {
  const measurements = record?.measurements ?? {};
  return {
    status: record?.status ?? null,
    timelineAvailable: measurements.openclawTimelineAvailable === true,
    timelineEventCount: measurements.openclawTimelineEventCount ?? null,
    slowestSpanName: measurements.openclawSlowestSpanName ?? null,
    slowestSpanMs: measurements.openclawSlowestSpanMs ?? null,
    openRequiredSpanCount: measurements.openclawOpenRequiredSpanCount ?? null,
    agentTurnMs: measurements.agentTurnMs ?? measurements.coldAgentTurnMs ?? null,
    agentPreProviderMs: measurements.agentPreProviderMs ?? measurements.coldPreProviderMs ?? null,
    providerFinalMs: measurements.agentProviderFinalMs ?? measurements.coldProviderFinalMs ?? null,
    agentMetadataScanCount: measurements.agentMetadataScanCount ?? null,
    agentMetadataScanTotalMs: measurements.agentMetadataScanTotalMs ?? null,
    agentEventLoopMaxMs: measurements.agentEventLoopMaxMs ?? null,
    agentSessionPollCount: measurements.agentSessionPollCount ?? null,
    runtimeDepsStagingMs: measurements.runtimeDepsStagingMs ?? null,
    readinessHealthReadyMs: measurementMetricValue(measurements, "readinessHealthReadyMs"),
    startupHealthP95Ms: measurementMetricValue(measurements, "startupHealthP95Ms"),
    postReadyHealthP95Ms: measurementMetricValue(measurements, "postReadyHealthP95Ms"),
    peakRssMb: measurementMetricValue(measurements, "peakRssMb")
  };
}

function targetLane(target) {
  const kind = targetKind(target);
  if (kind === "local-build") {
    return "source-build";
  }
  if (["npm", "release", "runtime"].includes(kind)) {
    return "release-runtime";
  }
  return null;
}

function targetKind(target) {
  if (typeof target !== "string" || !target.includes(":")) {
    return null;
  }
  return target.split(":", 1)[0];
}

function statusRank(status) {
  const ranks = {
    PASS: 0,
    "DRY-RUN": 0,
    SKIPPED: 1,
    INCOMPLETE: 2,
    FAIL: 3,
    BLOCKED: 4
  };
  return ranks[status] ?? 3;
}

function metricRegressions(baselineRecords, currentRecords, thresholds, options = {}) {
  const regressions = [];
  const metricIds = compareMetricIdsForGroups(baselineRecords, currentRecords);
  for (const [metric, tolerance] of Object.entries(thresholds)) {
    if (!metricIds.includes(metric)) {
      continue;
    }
    if (options.resourceComparable === false && isResourceComparisonMetric(metric)) {
      continue;
    }
    const baseline = summarizeMetricRecords(baselineRecords, metric);
    const current = summarizeMetricRecords(currentRecords, metric);
    if (usesRepeatedMaxOnly(baseline, current, tolerance)) {
      addIncreaseRegression(regressions, baseline, current, `${metric}.max`, tolerance, "max");
    } else {
      addIncreaseRegression(regressions, baseline, current, metric, tolerance, "median");
    }
    if (!usesRepeatedMaxOnly(baseline, current, tolerance) && (baseline.count > 1 || current.count > 1)) {
      addIncreaseRegression(regressions, baseline, current, `${metric}.max`, tolerance, "max");
      if (baseline.p95 !== null || current.p95 !== null) {
        addIncreaseRegression(regressions, baseline, current, `${metric}.p95`, tolerance, "p95");
      }
    }
  }
  return regressions;
}

function usesRepeatedMaxOnly(baseline, current, tolerance) {
  return tolerance === 0 && ((baseline?.count ?? 0) > 1 || (current?.count ?? 0) > 1);
}

function addIncreaseRegression(regressions, baseline, current, metric, tolerance, stat) {
  const baselineValue = baseline?.[stat] ?? null;
  const currentValue = current?.[stat] ?? null;
  if (typeof baselineValue !== "number" || typeof currentValue !== "number") {
    return;
  }

  const delta = currentValue - baselineValue;
  if (delta <= tolerance) {
    return;
  }

  regressions.push({
    kind: "metric",
    metric,
    stat,
    baseline: baselineValue,
    current: currentValue,
    delta,
    tolerance,
    message: `${metric} increased by ${roundDelta(delta)} (${baselineValue} -> ${currentValue}), over tolerance ${tolerance}`
  });
}

function metricDeltas(baselineRecords, currentRecords, thresholds = {}, options = {}) {
  const metrics = {};
  for (const metric of compareMetricIdsForGroups(baselineRecords, currentRecords)) {
    const baseline = summarizeMetricRecords(baselineRecords, metric);
    const current = summarizeMetricRecords(currentRecords, metric);
    const tolerance = typeof thresholds[metric] === "number" ? thresholds[metric] : null;
    const comparable = options.resourceComparable !== false || !isResourceComparisonMetric(metric);
    const repeatedMaxOnly = tolerance !== null && usesRepeatedMaxOnly(baseline, current, tolerance);
    if (!repeatedMaxOnly) {
      addMetricDelta(metrics, metric, baseline, current, "median", tolerance, comparable);
    }
    if (baseline.count > 1 || current.count > 1) {
      addMetricDelta(metrics, `${metric}.max`, baseline, current, "max", tolerance, comparable);
      if (!repeatedMaxOnly && (baseline.p95 !== null || current.p95 !== null)) {
        addMetricDelta(metrics, `${metric}.p95`, baseline, current, "p95", tolerance, comparable);
      }
    }
  }
  return metrics;
}

function compareMetricIdsForGroups(baselineRecords, currentRecords) {
  const records = [...(baselineRecords ?? []), ...(currentRecords ?? [])];
  return COMPARE_METRICS.filter((metric) => {
    if (metric !== "resourcePeakGatewayRssMb") {
      return true;
    }
    return !metricSeriesEquivalent(records, "peakRssMb", "resourcePeakGatewayRssMb");
  });
}

function metricSeriesEquivalent(records, leftMetric, rightMetric) {
  const pairs = [];
  for (const record of records ?? []) {
    const measurements = record.measurements ?? {};
    const left = measurementMetricValue(measurements, leftMetric);
    const right = measurementMetricValue(measurements, rightMetric);
    if (typeof left !== "number" && typeof right !== "number") {
      continue;
    }
    if (typeof left !== "number" || typeof right !== "number") {
      return false;
    }
    pairs.push([left, right]);
  }
  return pairs.length > 0 && pairs.every(([left, right]) => left === right);
}

function addMetricDelta(metrics, id, baseline, current, stat, tolerance = null, comparable = true) {
  const baselineValue = baseline?.[stat] ?? null;
  const currentValue = current?.[stat] ?? null;
  metrics[id] = {
    stat,
    baseline: baselineValue,
    current: currentValue,
    comparable,
    delta: comparable && typeof baselineValue === "number" && typeof currentValue === "number" ? currentValue - baselineValue : null,
    tolerance,
    baselineStats: compactMetricStats(baseline),
    currentStats: compactMetricStats(current)
  };
}

function isResourceComparisonMetric(metric) {
  return RESOURCE_COMPARISON_METRICS.has(String(metric).replace(/\.(?:median|max|p95)$/, ""));
}

function summarizeMetricRecords(records = [], metric) {
  const values = records
    .map((record) => measurementMetricValue(record.measurements ?? {}, metric))
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return { count: 0, median: null, p95: null, max: null, min: null };
  }
  return {
    count: values.length,
    min: values[0],
    median: quantile(values, 0.5),
    p95: values.length > 1 ? quantile(values, 0.95) : null,
    max: values[values.length - 1]
  };
}

function compactMetricStats(stats) {
  return {
    count: stats?.count ?? 0,
    min: stats?.min ?? null,
    median: stats?.median ?? null,
    p95: stats?.p95 ?? null,
    max: stats?.max ?? null
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) {
    return null;
  }
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  if (next === undefined) {
    return sorted[base];
  }
  return roundMetric(sorted[base] + rest * (next - sorted[base]));
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function roundDelta(value) {
  return Math.round(value * 100) / 100;
}

function resolveThresholds(raw) {
  if (!raw) {
    return { ...defaultThresholds };
  }
  const overrides = raw.metrics && typeof raw.metrics === "object" ? raw.metrics : raw;
  const thresholds = { ...defaultThresholds };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      thresholds[key] = value;
    }
  }
  return thresholds;
}
