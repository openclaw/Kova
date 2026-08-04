import {
  isAgentCliMessageCommand,
  measurementScopeForPhase
} from "../measurement-contract.mjs";

export const INSTRUMENTED_PERFORMANCE_REASON = "instrumented-performance-measurement";

const agentProfileMetricIds = new Set([
  "agentTurnMs",
  "agentTurnMedianMs",
  "agentTurnP95Ms",
  "agentTurnMaxMs",
  "coldAgentTurnMs",
  "warmAgentTurnMs",
  "agentColdWarmDeltaMs",
  "preProviderMs",
  "coldPreProviderMs",
  "warmPreProviderMs",
  "agentPreProviderMedianMs",
  "agentPreProviderP95Ms",
  "agentPreProviderMaxMs",
  "agentColdWarmPreProviderDeltaMs",
  "coldPreProviderAttributedMs",
  "warmPreProviderAttributedMs",
  "coldPreProviderUnattributedMs",
  "warmPreProviderUnattributedMs",
  "providerFinalMs",
  "coldProviderFinalMs",
  "warmProviderFinalMs",
  "agentProviderFinalMedianMs",
  "agentProviderFinalP95Ms",
  "agentProviderFinalMaxMs",
  "agentMetadataScanTotalMs",
  "agentMetadataScanMaxMs",
  "agentEventLoopMaxMs"
]);
const resourceMetricIds = new Set([
  "peakRssMb",
  "peakProcessRssMb",
  "cpuPercentMax",
  "maxCpuPercent",
  "rssGrowthMb",
  "gatewayRssGrowthMb",
  "resourcePeakCommandTreeRssMb",
  "resourcePeakGatewayRssMb",
  "resourcePeakTrackedRssMb",
  "resourceCpuPercentMaxTracked"
]);
const commandMetricMatchers = new Map([
  ["statusMs", isStatusCommand],
  ["pluginsListMs", (command) => command.includes(" -- plugins list")],
  ["pluginUpdateDryRunMs", (command) =>
    command.includes(" -- plugins update") && command.includes("--dry-run")],
  ["modelsListMs", (command) => command.includes(" -- models list")],
  ["coldReadyMs", isGatewayColdStartCommand],
  ["warmReadyMs", (command) => command.startsWith("ocm service restart ")],
  ["upgradeMs", (command) => command.startsWith("ocm upgrade ")],
  ["doctorFixMs", (command) =>
    command.includes("run-doctor-repair.mjs") || command.includes(" doctor --fix")]
]);
const measurementAliases = new Map([
  ["gatewayReadyMs", "coldReadyMs"],
  ["restartReadyMs", "warmReadyMs"],
  ["coldWarmDeltaMs", "agentColdWarmDeltaMs"],
  ["agentCleanupMs", "agentCleanupMaxMs"]
]);

export function profilingAffectsPerformance(profiling) {
  if (typeof profiling?.affectsPerformanceMeasurements === "boolean") {
    return profiling.affectsPerformanceMeasurements;
  }
  return profiling?.nodeProfile === true ||
    profiling?.deepProfile === true ||
    profiling?.heapSnapshot === true ||
    profiling?.diagnosticReport === true;
}

export function isInstrumentedPerformanceMetric(metric) {
  const role = roleMetric(metric);
  const normalized = normalizeMetric(metric);
  return (role !== null && resourceMetricIds.has(normalized)) ||
    resourceMetricIds.has(normalized) ||
    agentProfileMetricIds.has(normalized) ||
    commandMetricMatchers.has(normalized);
}

export function isResourcePerformanceMetric(metric) {
  return resourceMetricIds.has(normalizeMetric(metric));
}

export function commandProfilingAffectsPerformance(
  profiling,
  measurementScope,
  command = ""
) {
  return profilingAffectsPerformance(profiling) &&
    commandCanCarryProfilerEffects(measurementScope, command);
}

export function commandReceivesNodeProfiler(
  profiling,
  measurementScope,
  command = ""
) {
  return profiling?.nodeProfile === true &&
    commandCanCarryProfilerEffects(measurementScope, command);
}

function commandCanCarryProfilerEffects(measurementScope, command) {
  if (measurementScope !== "product") {
    return false;
  }
  // Persistent service commands must not pass profiler flags into the managed
  // gateway, and their measurements remain independent of bounded captures.
  const text = String(command ?? "");
  return !(
    /\bocm\s+service\s+(?:install|start|restart)\b/.test(text) ||
    (
      /\bocm\s+start\b/.test(text) &&
      !/(?:^|\s)--no-service(?:\s|$)/.test(text)
    )
  );
}

export function commandMatchesPerformanceMetric(metric, command = "") {
  const matcher = commandMetricMatchers.get(measurementMetricForThreshold(metric));
  return matcher ? matcher(String(command)) : false;
}

export function measurementMetricForThreshold(metric) {
  const normalized = normalizeMetric(metric);
  return measurementAliases.get(normalized) ?? normalized;
}

export function performanceProfilesComparable(baselineRecords, currentRecords) {
  const baseline = profilingSignatures(baselineRecords);
  const current = profilingSignatures(currentRecords);
  return baseline.size === 1 &&
    current.size === 1 &&
    [...baseline][0] === [...current][0];
}

export function instrumentedPerformanceThresholdAffected(record, {
  metric,
  role = null,
  actual = null,
  command = null
}) {
  if (!profilingAffectsPerformance(record?.profiling)) {
    return false;
  }
  const parsedRole = role ?? roleMetric(metric);
  const normalized = measurementMetricForThreshold(metric);

  if (parsedRole && resourceMetricIds.has(normalized)) {
    return resourceRoleMetricUsesCommandTree(record, parsedRole, normalized, actual);
  }
  if (resourceMetricIds.has(normalized)) {
    return resourceMetricAffected(record, normalized, actual);
  }
  if (agentProfileMetricIds.has(normalized)) {
    return recordHasProfiledAgentProcess(record);
  }
  const matcher = commandMetricMatchers.get(normalized);
  if (matcher) {
    return profiledProductResults(record).some((result) =>
      (command ? result.command === command : true) &&
      commandMatchesPerformanceMetric(normalized, result.command) &&
      sameMeasurement(result.durationMs, actual)
    );
  }
  return false;
}

export function instrumentedPerformanceMetricSkipped(records, metric) {
  const instrumented = (records ?? []).filter((record) =>
    profilingAffectsPerformance(record?.profiling)
  );
  if (instrumented.length === 0) {
    return false;
  }
  return instrumented.some((record) =>
    assessmentSkipsMetric(record, metric) ||
    instrumentedPerformanceThresholdAffected(record, {
      metric,
      actual: measurementValue(record, metric)
    })
  );
}

function assessmentSkipsMetric(record, metric) {
  const normalized = measurementMetricForThreshold(metric);
  return (record.performanceThresholdAssessment?.skipped ?? []).some((assessment) =>
    assessment.metric === metric ||
    assessment.measurementMetric === normalized
  );
}

function resourceMetricAffected(record, metric, actual) {
  if (metric === "gatewayRssGrowthMb") {
    return false;
  }
  if (metric === "resourcePeakGatewayRssMb") {
    return resourceRoleMetricUsesCommandTree(record, "gateway", "peakRssMb", actual);
  }
  if (metric === "resourcePeakCommandTreeRssMb") {
    return profiledProductResults(record).some((result) =>
      sameMeasurement(result.resourceSamples?.peakCommandTreeRssMb, actual)
    );
  }
  if (metric === "resourcePeakTrackedRssMb") {
    return profiledProductResults(record).some((result) =>
      sameMeasurement(result.resourceSamples?.peakTotalRssMb, actual)
    );
  }
  if (metric === "resourceCpuPercentMaxTracked") {
    return profiledProductResults(record).some((result) =>
      sameMeasurement(result.resourceSamples?.maxTotalCpuPercent, actual)
    );
  }
  if (metric === "rssGrowthMb") {
    return profiledProductResults(record).some((result) =>
      sameMeasurement(result.resourceSamples?.trend?.totalRssGrowthMb, actual)
    );
  }

  const role = record.measurements?.resourceGateKind === "role"
    ? record.measurements?.resourcePrimaryRole
    : null;
  if (role) {
    return resourceRoleMetricUsesCommandTree(record, role, metric, actual);
  }
  const sampleKey = metric === "cpuPercentMax"
    ? "maxTotalCpuPercent"
    : "peakTotalRssMb";
  return profiledProductResults(record).some((result) =>
    sameMeasurement(result.resourceSamples?.[sampleKey], actual)
  );
}

function resourceRoleMetricUsesCommandTree(record, role, metric, actual) {
  const summary = record.measurements?.resourceByRole?.[role];
  const cpuMetric = metric === "cpuPercentMax" || metric === "maxCpuPercent";
  const process = cpuMetric
    ? summary?.peakCpuProcess
    : summary?.peakRssProcess;
  const value = cpuMetric
    ? summary?.maxCpuPercent
    : metric === "peakProcessRssMb"
      ? summary?.peakRssProcess?.rssMb
      : summary?.peakRssMb;
  return sameMeasurement(value, actual) &&
    process?.roles?.includes("command-tree") === true;
}

function recordHasProfiledAgentProcess(record) {
  return profiledProductResults(record).some((result) => {
    if (isAgentCliMessageCommand(result.command)) {
      return true;
    }
    return ["agent-process", "agent-cli"].some((role) => {
      const summary = result.resourceSamples?.byRole?.[role];
      return summary?.peakRssProcess?.roles?.includes("command-tree") === true ||
        summary?.peakCpuProcess?.roles?.includes("command-tree") === true;
    });
  });
}

function profiledProductResults(record) {
  const results = [];
  for (const phase of record.phases ?? []) {
    const measurementScope = measurementScopeForPhase(phase);
    for (const result of phase.results ?? []) {
      if (
        commandProfilingAffectsPerformance(
          record.profiling,
          measurementScope,
          result.command
        )
      ) {
        results.push(result);
      }
    }
  }
  return results;
}

function measurementValue(record, metric) {
  const role = roleMetric(metric);
  const normalized = measurementMetricForThreshold(metric);
  if (role) {
    const summary = record.measurements?.resourceByRole?.[role];
    if (normalized === "peakProcessRssMb") {
      return summary?.peakRssProcess?.rssMb ?? null;
    }
    return summary?.[normalized] ?? null;
  }
  return record.measurements?.[normalized] ?? null;
}

function sameMeasurement(candidate, expected) {
  return Number.isFinite(candidate) &&
    (!Number.isFinite(expected) || candidate === expected);
}

function profilingSignatures(records) {
  return new Set((records ?? []).map((record) => profilingSignature(record?.profiling)));
}

function profilingSignature(profiling) {
  if (!profilingAffectsPerformance(profiling)) {
    return "normal";
  }
  return [
    "instrumented",
    profiling?.deepProfile === true ? "deep" : "standard",
    profiling?.nodeProfile === true ? "node" : "no-node",
    profiling?.heapSnapshot === true ? "heap" : "no-heap",
    profiling?.diagnosticReport === true ? "report" : "no-report"
  ].join(":");
}

function normalizeMetric(metric) {
  return String(metric ?? "")
    .replace(/^resourceByRole\.[^.]+\./, "")
    .replace(/\.(?:median|max|p95)$/, "");
}

function roleMetric(metric) {
  return String(metric ?? "").match(/^resourceByRole\.([^.]+)\./)?.[1] ?? null;
}

function isGatewayColdStartCommand(command) {
  return command.startsWith("ocm service start ") ||
    (
      command.startsWith("ocm start ") &&
      !/(?:^|\s)--no-service(?:\s|$)/.test(command)
    );
}

function isStatusCommand(command) {
  return (
    /\s--\sstatus\b|@\S+\s+--\s+status\b/.test(command) ||
    command.includes(" -- status") ||
    /\s--\s+gateway\s+status\b/.test(command) ||
    /@\S+\s+--\s+gateway\s+status\b/.test(command)
  );
}
