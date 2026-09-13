import { allMetricObjects } from "./logs.mjs";
import { compactSampleProcess } from "./resources.mjs";

export function buildDiagnosticCorrelation({
  resourceSummary,
  timelineSummary,
  logSummary,
  nodeProfileTopFunction,
  nodeHeapTopFunction,
  eventLoopDelayMs,
  runtimeDepsStagingMs,
  providerModelTimingMs
}) {
  const findings = [];
  if (resourceSummary.peakCpuSample) {
    findings.push({
      kind: "cpu-peak",
      summary: `CPU peaked at ${resourceSummary.peakCpuSample.totalCpuPercent}% around ${resourceSummary.peakCpuSample.elapsedMs}ms`,
      elapsedMs: resourceSummary.peakCpuSample.elapsedMs,
      process: compactSampleProcess(resourceSummary.peakCpuSample.topProcess)
    });
  }
  if (resourceSummary.peakRssSample) {
    findings.push({
      kind: "rss-peak",
      summary: `RSS peaked at ${resourceSummary.peakRssSample.totalRssMb} MB around ${resourceSummary.peakRssSample.elapsedMs}ms`,
      elapsedMs: resourceSummary.peakRssSample.elapsedMs,
      process: compactSampleProcess(resourceSummary.peakRssSample.topProcess)
    });
  }
  if (nodeProfileTopFunction) {
    findings.push({
      kind: "cpu-function",
      summary: `Top sampled CPU function: ${nodeProfileTopFunction.functionName} ${nodeProfileTopFunction.selfMs}ms`,
      functionName: nodeProfileTopFunction.functionName,
      selfMs: nodeProfileTopFunction.selfMs,
      url: nodeProfileTopFunction.url
    });
  }
  if (nodeHeapTopFunction) {
    findings.push({
      kind: "heap-function",
      summary: `Top sampled heap allocation function: ${nodeHeapTopFunction.functionName} ${nodeHeapTopFunction.selfSizeMb} MB`,
      functionName: nodeHeapTopFunction.functionName,
      selfSizeMb: nodeHeapTopFunction.selfSizeMb,
      url: nodeHeapTopFunction.url
    });
  }
  if (timelineSummary.slowestSpanName) {
    findings.push({
      kind: "openclaw-span",
      summary: `Slowest OpenClaw span: ${timelineSummary.slowestSpanName} ${timelineSummary.slowestSpanMs}ms`,
      span: timelineSummary.slowestSpanName,
      durationMs: timelineSummary.slowestSpanMs
    });
  }
  if (timelineSummary.openSpans.length > 0) {
    const span = timelineSummary.openSpans[0];
    findings.push({
      kind: "openclaw-open-span",
      summary: `Open OpenClaw span: ${span.name}${span.ageMs !== null ? ` age ${span.ageMs}ms` : ""}`,
      span: span.name,
      ageMs: span.ageMs
    });
  }
  if (logSummary?.embeddedRuns?.topStages?.length > 0) {
    const stage = logSummary.embeddedRuns.topStages[0];
    findings.push({
      kind: "embedded-run-stage",
      summary: `Slowest embedded agent stage from logs: ${stage.name} ${stage.totalDurationMs}ms`,
      stage: stage.name,
      durationMs: stage.totalDurationMs,
      maxDurationMs: stage.maxDurationMs
    });
  }
  if ((logSummary?.livenessWarnings?.count ?? 0) > 0) {
    findings.push({
      kind: "liveness-warning",
      summary: `OpenClaw liveness warnings: ${logSummary.livenessWarnings.count}, max event-loop delay ${logSummary.livenessWarnings.maxEventLoopDelayMaxMs ?? "unknown"}ms`,
      count: logSummary.livenessWarnings.count,
      eventLoopDelayMaxMs: logSummary.livenessWarnings.maxEventLoopDelayMaxMs
    });
  }
  if (eventLoopDelayMs !== null) {
    findings.push({
      kind: "event-loop",
      summary: `Max structured event-loop delay: ${eventLoopDelayMs}ms`,
      durationMs: eventLoopDelayMs
    });
  }
  if (runtimeDepsStagingMs !== null) {
    findings.push({
      kind: "runtime-deps",
      summary: `Runtime dependency staging max: ${runtimeDepsStagingMs}ms`,
      durationMs: runtimeDepsStagingMs
    });
  }
  if (providerModelTimingMs !== null) {
    findings.push({
      kind: "provider-model",
      summary: `Provider/model timing max: ${providerModelTimingMs}ms`,
      durationMs: providerModelTimingMs
    });
  }
  return {
    schemaVersion: "kova.diagnosticCorrelation.v1",
    findingCount: findings.length,
    findings
  };
}

export function countDiagnosticMetric(record, key) {
  let observed = false;
  let count = 0;
  for (const metrics of allMetricObjects(record)) {
    if (metrics?.diagnostics) {
      observed = true;
    }
    const value = metrics?.diagnostics?.[key];
    if (typeof value === "number") {
      count = Math.max(count, value);
    }
  }
  return observed ? count : null;
}
