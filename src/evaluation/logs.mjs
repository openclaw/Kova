import { countProviderTimeoutMentions, summarizeRuntimeDepsLogs } from "../collectors/logs.mjs";
import { maxNullable, roundNumber } from "./shared.mjs";

const LOG_METRIC_PATTERNS = {
  missingDependencyErrors: /cannot find (module|package)|missing dependenc|missing runtime dep/i,
  pluginLoadFailures: /\[plugins\].*failed to load|plugin.*failed to load|\[plugins\].*failed during register|plugin.*failed during register|\[plugins\].*plugin service failed|plugin service failed/i,
  metadataScanMentions: /collectBundledPluginMetadata|bundled plugin metadata|manifest read|readdirSync/i,
  configNormalizationMentions: /config normal/i,
  gatewayRestartMentions: /gateway.*restart|restart.*gateway|service restart|restarting/i,
  providerLoadMentions: /provider.*load|load.*provider|provider registry|auth provider/i,
  modelCatalogMentions: /model catalog|models list|loading models|available models/i,
  eventLoopDelayMentions: /event loop|event-loop|blocked loop|loop delay/i,
  v8DiagnosticMentions: /v8|diagnostic report|heapsnapshot|heap snapshot/i
};

export function countLogMetric(record, key, results = [], options = {}) {
  let observed = false;
  let count = 0;
  for (const phase of record.phases ?? []) {
    const value = phase.metrics?.logs?.[key];
    if (typeof value === "number") {
      observed = true;
      count = Math.max(count, value);
    }
  }

  const finalValue = record.finalMetrics?.logs?.[key];
  if (typeof finalValue === "number") {
    observed = true;
    count = Math.max(count, finalValue);
  }

  const commandLogMetric = countExplicitLogCommandMetric(results, key, options);
  if (commandLogMetric.observed || commandLogMetric.count > 0) {
    observed = true;
    count = Math.max(count, commandLogMetric.count);
  }
  return observed ? count : null;
}

export function combineCommandAndLogCount(commandCount, logCount, logCommandObserved) {
  if (typeof logCount === "number") {
    return commandCount + logCount;
  }
  if (commandCount > 0) {
    return commandCount;
  }
  return logCommandObserved ? 0 : null;
}

function countExplicitLogCommandMetric(results, key, options = {}) {
  const pattern = LOG_METRIC_PATTERNS[key];
  const providerTimeoutMetric = key === "providerTimeoutMentions";
  if (!pattern && !providerTimeoutMetric) {
    return { observed: false, count: 0 };
  }
  let observed = false;
  let count = 0;
  for (const result of results) {
    if (!isLogCommandResult(result)) {
      continue;
    }
    if (result.status === 0) {
      observed = true;
    }
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const matchCount = providerTimeoutMetric
      ? countProviderTimeoutMentions(text)
      : countPattern(text, pattern, { ignoreLine: options.ignoreLine });
    if (matchCount > 0) {
      observed = true;
      count += matchCount;
    }
  }
  return { observed, count };
}

export function expectedPluginFailureLineIgnorer(scenario) {
  const markers = (scenario?.expectedPluginFailureMarkers ?? [])
    .filter((marker) => typeof marker === "string" && marker.length > 0);
  if (markers.length === 0) {
    return null;
  }
  return (line) => markers.some((marker) => String(line ?? "").includes(marker));
}

export function hasSuccessfulLogCommandResult(results) {
  return results.some((result) => isLogCommandResult(result) && result.status === 0);
}

function isLogCommandResult(result) {
  return /^ocm\s+logs\s+/.test(result?.command ?? "");
}

function countPattern(text, pattern, { ignoreLine = null } = {}) {
  let count = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (pattern.test(line) && !(typeof ignoreLine === "function" && ignoreLine(line))) {
      count += 1;
    }
  }
  return count;
}

export function countHeapSnapshotBytes(record) {
  let observed = false;
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    if (metrics?.heapSnapshot) {
      observed = true;
    }
    const value = metrics?.heapSnapshot?.artifactBytes;
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return observed ? count : null;
}

export function countNodeProfileMetric(record, key) {
  let observed = false;
  let count = 0;
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.nodeProfiles) {
      observed = true;
    }
    const value = phase.metrics?.nodeProfiles?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }

  const finalValue = record.finalMetrics?.nodeProfiles?.[key];
  if (record.finalMetrics?.nodeProfiles) {
    observed = true;
  }
  if (typeof finalValue === "number") {
    count = Math.max(count, finalValue);
  }
  return observed ? count : null;
}

export function collectNodeProfileTopFunction(record) {
  let top = null;
  for (const metrics of allMetricObjects(record)) {
    const candidate = metrics?.nodeProfiles?.cpuProfileSummary?.topFunctions?.[0];
    if (!candidate || typeof candidate.selfMs !== "number") {
      continue;
    }
    if (!top || candidate.selfMs > top.selfMs) {
      top = candidate;
    }
  }
  return top;
}

export function collectNodeHeapTopFunction(record) {
  let top = null;
  for (const metrics of allMetricObjects(record)) {
    const candidate = metrics?.nodeProfiles?.heapProfileSummary?.topFunctions?.[0];
    if (!candidate || typeof candidate.selfSizeMb !== "number") {
      continue;
    }
    if (!top || candidate.selfSizeMb > top.selfSizeMb) {
      top = candidate;
    }
  }
  return top;
}

export function countDiagnosticReportMetric(record, key) {
  let observed = false;
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    if (metrics?.diagnosticReport) {
      observed = true;
    }
    const value = metrics?.diagnosticReport?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return observed ? count : null;
}

export function collectLogSummary(record) {
  const embeddedRuns = {
    schemaVersion: "kova.embeddedRunTraceSummary.v1",
    available: false,
    eventCount: 0,
    startupCount: 0,
    prepCount: 0,
    totalMaxMs: null,
    stageTotals: {},
    topStages: [],
    events: []
  };
  const livenessWarnings = {
    schemaVersion: "kova.livenessWarningSummary.v1",
    available: false,
    count: 0,
    maxEventLoopDelayP99Ms: null,
    maxEventLoopDelayMaxMs: null,
    maxEventLoopUtilization: null,
    maxCpuCoreRatio: null,
    events: []
  };

  for (const metrics of allMetricObjects(record)) {
    mergeEmbeddedRuns(embeddedRuns, metrics?.logs?.embeddedRuns);
    mergeLivenessWarnings(livenessWarnings, metrics?.logs?.livenessWarnings);
  }

  embeddedRuns.available = embeddedRuns.eventCount > 0;
  embeddedRuns.topStages = Object.values(embeddedRuns.stageTotals)
    .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || left.name.localeCompare(right.name))
    .slice(0, 12);
  livenessWarnings.available = livenessWarnings.count > 0;

  return {
    schemaVersion: "kova.logSummary.v1",
    embeddedRuns,
    livenessWarnings
  };
}

function mergeEmbeddedRuns(target, source) {
  if (!source) {
    return;
  }
  target.eventCount += source.eventCount ?? 0;
  target.startupCount += source.startupCount ?? 0;
  target.prepCount += source.prepCount ?? 0;
  target.totalMaxMs = maxNullable(target.totalMaxMs, source.totalMaxMs);
  target.events = [...target.events, ...(source.events ?? [])].slice(-40);
  for (const [name, summary] of Object.entries(source.stageTotals ?? {})) {
    const current = target.stageTotals[name] ?? {
      name,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      maxOffsetMs: null,
      traceKinds: []
    };
    current.count += summary.count ?? 0;
    current.totalDurationMs = roundNumber(current.totalDurationMs + (summary.totalDurationMs ?? 0));
    current.maxDurationMs = maxNullable(current.maxDurationMs, summary.maxDurationMs);
    current.maxOffsetMs = maxNullable(current.maxOffsetMs, summary.maxOffsetMs);
    current.traceKinds = [...new Set([...current.traceKinds, ...(summary.traceKinds ?? [])])].sort();
    target.stageTotals[name] = current;
  }
}

function mergeLivenessWarnings(target, source) {
  if (!source) {
    return;
  }
  target.count += source.count ?? 0;
  target.maxEventLoopDelayP99Ms = maxNullable(target.maxEventLoopDelayP99Ms, source.maxEventLoopDelayP99Ms);
  target.maxEventLoopDelayMaxMs = maxNullable(target.maxEventLoopDelayMaxMs, source.maxEventLoopDelayMaxMs);
  target.maxEventLoopUtilization = maxNullable(target.maxEventLoopUtilization, source.maxEventLoopUtilization);
  target.maxCpuCoreRatio = maxNullable(target.maxCpuCoreRatio, source.maxCpuCoreRatio);
  target.events = [...target.events, ...(source.events ?? [])].slice(-40);
}

export function collectOpenClawDiagnostics(record) {
  const values = {
    pluginMetadataScanCount: null,
    configNormalizationCount: null,
    runtimeDepsStagingMs: null,
    eventLoopDelayMs: null,
    providerModelTimingMs: null
  };

  for (const metrics of allMetricObjects(record)) {
    const diagnostics = metrics?.openclawDiagnostics;
    if (!diagnostics) {
      continue;
    }
    values.pluginMetadataScanCount = maxNullable(values.pluginMetadataScanCount, diagnostics.pluginMetadataScanCount);
    values.configNormalizationCount = maxNullable(values.configNormalizationCount, diagnostics.configNormalizationCount);
    values.runtimeDepsStagingMs = maxNullable(values.runtimeDepsStagingMs, diagnostics.runtimeDepsStagingMs);
    values.eventLoopDelayMs = maxNullable(values.eventLoopDelayMs, diagnostics.eventLoopDelayMs);
    values.providerModelTimingMs = maxNullable(values.providerModelTimingMs, diagnostics.providerModelTimingMs);
  }

  return values;
}

export function collectRuntimeDepsLogEvidence(record) {
  const phases = (record.phases ?? []).map((phase) => ({
    id: phase.id,
    summary: summarizeRuntimeDepsPhase(phase)
  }));
  const cold = selectRuntimeDepsPhase(phases, ["cold-start", "provision", "start", "gateway"]);
  const warm = selectRuntimeDepsPhase(phases, ["warm-restart", "restart"]);
  const coldStart = compactRuntimeDepsPhase(cold);
  const warmRestart = compactRuntimeDepsWarmPhase(warm, cold);
  const allSummaries = [
    ...phases.map((phase) => phase.summary),
    ...allMetricObjects(record).map((metrics) => metrics.logs?.runtimeDeps).filter(Boolean)
  ];

  return {
    schemaVersion: "kova.runtimeDepsEvidence.v1",
    available: allSummaries.some((summary) => (summary?.eventCount ?? 0) > 0),
    installCount: maxNullable(...allSummaries.map((summary) => summary?.installCount)),
    installMaxMs: maxNullable(...allSummaries.map((summary) => summary?.installMaxMs)),
    postbuildCount: maxNullable(...allSummaries.map((summary) => summary?.postbuildCount)),
    postbuildMaxMs: maxNullable(...allSummaries.map((summary) => summary?.postbuildMaxMs)),
    pluginIds: [...new Set(allSummaries.flatMap((summary) => summary?.pluginIds ?? []))].sort(),
    coldStart,
    warmRestart,
    phases: phases.map((phase) => ({
      id: phase.id,
      eventCount: phase.summary.eventCount,
      stageCount: phase.summary.stageCount,
      installCount: phase.summary.installCount,
      installMaxMs: phase.summary.installMaxMs,
      postbuildCount: phase.summary.postbuildCount,
      postbuildMaxMs: phase.summary.postbuildMaxMs,
      pluginIds: phase.summary.pluginIds
    }))
  };
}

function summarizeRuntimeDepsPhase(phase) {
  const texts = [];
  for (const result of phase?.results ?? []) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (/runtime dep|runtime dependency|runtime-deps|bundled runtime deps/i.test(output)) {
      texts.push(output);
    }
  }
  const summary = summarizeRuntimeDepsLogs(texts.join("\n"));
  if (summary.eventCount > 0 || !phase?.metrics?.logs?.runtimeDeps) {
    return summary;
  }
  return phase.metrics.logs.runtimeDeps;
}

function selectRuntimeDepsPhase(phases, ids) {
  return phases.find((phase) => ids.includes(phase.id))?.summary ?? null;
}

function compactRuntimeDepsPhase(summary) {
  if (!summary) {
    return {
      eventCount: null,
      installCount: null,
      installMaxMs: null,
      postbuildCount: null,
      postbuildMaxMs: null,
      pluginIds: []
    };
  }
  return {
    eventCount: summary.eventCount ?? 0,
    installCount: summary.installCount ?? 0,
    installMaxMs: summary.installMaxMs ?? null,
    postbuildCount: summary.postbuildCount ?? 0,
    postbuildMaxMs: summary.postbuildMaxMs ?? null,
    pluginIds: summary.pluginIds ?? []
  };
}

function compactRuntimeDepsWarmPhase(warm, cold) {
  if (!warm) {
    return compactRuntimeDepsPhase(null);
  }
  const warmInstallCount = incrementalCount(warm.installCount, cold?.installCount);
  return {
    eventCount: incrementalCount(warm.eventCount, cold?.eventCount),
    installCount: warmInstallCount,
    installMaxMs: warmInstallCount > 0 ? (warm.installMaxMs ?? null) : null,
    postbuildCount: incrementalCount(warm.postbuildCount, cold?.postbuildCount),
    postbuildMaxMs: incrementalCount(warm.postbuildCount, cold?.postbuildCount) > 0 ? (warm.postbuildMaxMs ?? null) : null,
    pluginIds: warmInstallCount > 0 ? (warm.pluginIds ?? []) : []
  };
}

function incrementalCount(current, previous) {
  if (typeof current !== "number") {
    return null;
  }
  if (typeof previous !== "number") {
    return current;
  }
  return current >= previous ? current - previous : current;
}

export function allMetricObjects(record) {
  return [
    ...(record.phases ?? []).map((phase) => phase.metrics).filter(Boolean),
    record.finalMetrics,
    record.failureDiagnostics
  ].filter(Boolean);
}
