import { commandResultPassed } from "../measurement-contract.mjs";
import { countLogMetric } from "./logs.mjs";
import { collectResults, isColdReadyCommand, isWarmReadyCommand } from "./records.mjs";

function countHealthFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    count += phase.metrics?.healthSummary?.failureCount ?? healthFailureCount([phase.metrics?.health]);
  }

  count += record.finalMetrics?.healthSummary?.failureCount ?? healthFailureCount([record.finalMetrics?.health]);
  return count;
}

export function countPostStartupHealthFailures(record, health = null) {
  if (health?.schemaVersion === "kova.health.v1") {
    const breakdown = postStartupHealthFailureBreakdown(health);
    return breakdown.postReady + breakdown.unknown + breakdown.final;
  }
  return countHealthFailures(record);
}

export function postStartupHealthFailureBreakdown(health) {
  return {
    startup: health?.startupSamples?.failureCount ?? 0,
    postReady: health?.postReadySamples?.failureCount ?? 0,
    unknown: health?.unknownSamples?.failureCount ?? 0,
    final: health?.final?.failureCount ?? 0
  };
}

export function countListeningFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.readiness && phase.metrics.readiness.listeningReady === false && phase.metrics.readiness.deadlineMs > 0) {
      count += 1;
    }
  }
  if (record.finalMetrics?.readiness && record.finalMetrics.readiness.listeningReady === false && record.finalMetrics.readiness.deadlineMs > 0) {
    count += 1;
  }
  return count;
}

export function countReadinessFailures(record) {
  let count = 0;
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.readiness && phase.metrics.readiness.ready === false && phase.metrics.readiness.deadlineMs > 0) {
      count += 1;
    }
  }
  if (record.finalMetrics?.readiness && record.finalMetrics.readiness.ready === false && record.finalMetrics.readiness.deadlineMs > 0) {
    count += 1;
  }
  return count;
}

export function collectTcpConnectMax(record) {
  const durations = [];
  for (const phase of record.phases ?? []) {
    const duration = phase.metrics?.listening?.durationMs;
    if (typeof duration === "number") {
      durations.push(duration);
    }
  }
  const finalDuration = record.finalMetrics?.listening?.durationMs;
  if (typeof finalDuration === "number") {
    durations.push(finalDuration);
  }
  return durations.length === 0 ? null : Math.max(...durations);
}

export function countGatewayRestarts(record, results = collectResults(record)) {
  const commandRestarts = results.filter((result) => result.command.startsWith("ocm service restart ")).length;
  const logRestarts = countLogMetric(record, "gatewayRestartMentions", results);
  if (typeof logRestarts === "number") {
    return commandRestarts + logRestarts;
  }
  return commandRestarts > 0 ? commandRestarts : null;
}

export function collectIntentionalRestartSourcePids(record) {
  const sourcePids = new Set();
  let previousTimeline = null;
  let restartPending = false;

  for (const phase of record.phases ?? []) {
    restartPending ||= (phase.results ?? []).some((result) =>
      result.command?.startsWith("ocm service restart ") && commandResultPassed(result)
    );
    const timeline = phase.metrics?.timeline;
    if (!timeline?.available) {
      continue;
    }
    const gatewayPids = timeline.gatewayPids ?? [];
    const transitionIsAdjacent = previousTimeline?.terminalGatewayPid !== null &&
      previousTimeline?.terminalGatewayPid !== undefined &&
      gatewayPids.at(-2) === previousTimeline.terminalGatewayPid &&
      gatewayPids.at(-1) === timeline.terminalGatewayPid;
    if (restartPending && transitionIsAdjacent) {
      sourcePids.add(previousTimeline.terminalGatewayPid);
    }
    restartPending = false;
    previousTimeline = timeline;
  }

  const finalTimeline = record.finalMetrics?.timeline;
  if (restartPending && finalTimeline?.available && finalTimeline !== previousTimeline) {
    const gatewayPids = finalTimeline.gatewayPids ?? [];
    if (previousTimeline?.terminalGatewayPid !== null &&
      previousTimeline?.terminalGatewayPid !== undefined &&
      gatewayPids.at(-2) === previousTimeline.terminalGatewayPid &&
      gatewayPids.at(-1) === finalTimeline.terminalGatewayPid) {
      sourcePids.add(previousTimeline.terminalGatewayPid);
    }
  }

  return sourcePids;
}

function healthFailureCount(samples) {
  return samples.filter((sample) => sample && !sample.ok).length;
}

export function recordExpectsGateway(record) {
  return collectResults(record).some((result) => {
    const command = result.command ?? "";
    if (isColdReadyCommand(command) || isWarmReadyCommand(command)) {
      return true;
    }
    return false;
  });
}
