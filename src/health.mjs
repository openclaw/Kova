export const HEALTH_SCHEMA = "kova.health.v1";
export const HEALTH_SCOPES = ["readiness", "startup-sample", "post-ready", "final", "none", "unknown"];

const startupScopes = new Set(["readiness", "startup-sample"]);

export function buildHealthMeasurement(record, scenario = null) {
  const phaseContracts = new Map((scenario?.phases ?? []).map((phase) => [phase.id, phase]));
  const entries = [];
  for (const phase of record.phases ?? []) {
    entries.push({
      source: "phase",
      phaseId: phase.id ?? null,
      scope: normalizeHealthScope(phase.healthScope ?? phaseContracts.get(phase.id)?.healthScope),
      metrics: phase.metrics ?? null
    });
  }

  const finalEntry = {
    source: "final",
    phaseId: "final",
    scope: "final",
    metrics: record.finalMetrics ?? null
  };
  entries.push(finalEntry);

  const readiness = selectReadiness(entries);
  const startupSamples = summarizeScopedSamples(
    entries.filter((entry) => startupScopes.has(entry.scope)),
    "startup-sample",
    startupSamplesForEntry
  );
  const postReadySamples = summarizeScopedSamples(
    entries.filter((entry) => entry.scope === "post-ready"),
    "post-ready",
    postReadySamplesForEntry
  );
  const unknownSamples = summarizeScopedSamples(
    entries.filter((entry) => entry.scope === "unknown"),
    "unknown",
    postReadySamplesForEntry
  );
  const final = summarizeFinalHealth(finalEntry.metrics);
  const slowestSample = selectSlowestSample([startupSamples, postReadySamples, final]);

  return {
    schemaVersion: HEALTH_SCHEMA,
    readiness,
    startupSamples,
    postReadySamples,
    unknownSamples,
    final,
    slowestSample
  };
}

export function healthReadinessClassification(health) {
  if (!health?.readiness) {
    return null;
  }
  return {
    phaseId: health.readiness.phaseId,
    state: health.readiness.classification,
    severity: health.readiness.severity,
    reason: health.readiness.reason,
    thresholdMs: health.readiness.thresholdMs,
    deadlineMs: health.readiness.deadlineMs,
    listeningReadyAtMs: health.readiness.listeningReadyAtMs,
    healthReadyAtMs: health.readiness.healthReadyAtMs
  };
}

export function healthTotalFailures(health) {
  const counts = [
    health?.startupSamples?.failureCount,
    health?.postReadySamples?.failureCount,
    health?.unknownSamples?.failureCount,
    health?.final?.failureCount
  ];
  return counts.every(validFailureCount)
    ? counts.reduce((total, count) => total + count, 0)
    : null;
}

export function validHealthSummaryFailureCount(summary) {
  const count = summary?.count;
  const failureCount = summary?.failureCount;
  if (
    !Number.isInteger(count) ||
    count <= 0 ||
    !Number.isInteger(failureCount) ||
    failureCount < 0 ||
    failureCount > count
  ) {
    return null;
  }
  return failureCount;
}

export function validHealthSamples(samples) {
  return Array.isArray(samples) &&
    samples.length > 0 &&
    samples.every((sample) =>
      sample !== null &&
      typeof sample === "object" &&
      typeof sample.ok === "boolean" &&
      typeof sample.durationMs === "number" &&
      Number.isFinite(sample.durationMs) &&
      sample.durationMs >= 0
    );
}

export function measurementMetricValue(measurements, metric) {
  if (!measurements) {
    return null;
  }
  switch (metric) {
    case "readinessListeningMs":
      return measurements.health?.readiness?.listeningReadyAtMs ?? null;
    case "readinessHealthReadyMs":
      return measurements.health?.readiness?.healthReadyAtMs ?? null;
    case "startupHealthP95Ms":
      return measurements.health?.startupSamples?.p95Ms ?? null;
    case "postReadyHealthP95Ms":
      return measurements.health?.postReadySamples?.p95Ms ?? null;
    case "startupHealthFailures":
      return measurements.health?.startupSamples?.failureCount ?? null;
    case "postReadyHealthFailures":
      return measurements.health?.postReadySamples?.failureCount ?? null;
    case "finalHealthFailures":
      return measurements.health?.final?.failureCount ?? null;
    case "peakRssMb":
      return primaryRssValue(measurements);
    default:
      return measurements[metric] ?? null;
  }
}

function primaryRssValue(measurements) {
  if (measurements.resourceGateKind === "role" || measurements.resourceGateKind === "tracked-total") {
    return measurements.peakRssMb ?? null;
  }

  // Compatibility for reports written before Kova recorded resourceGateKind.
  // Those reports stored tracked total RSS in peakRssMb even when gateway role
  // RSS was already available separately. Default old report reads to gateway
  // so report/compare output matches the current headline RSS contract.
  return measurements.resourceByRole?.gateway?.peakRssMb ??
    measurements.resourcePeakGatewayRssMb ??
    measurements.peakRssMb ??
    null;
}

function normalizeHealthScope(scope) {
  return typeof scope === "string" && HEALTH_SCOPES.includes(scope) ? scope : "unknown";
}

function selectReadiness(entries) {
  const scoped = entries
    .filter((entry) => startupScopes.has(entry.scope))
    .map((entry) => readinessValue(entry.metrics?.readiness, entry.phaseId))
    .filter(Boolean);
  const candidates = scoped.length > 0
    ? scoped
    : entries.map((entry) => readinessValue(entry.metrics?.readiness, entry.phaseId)).filter(Boolean);
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((left, right) => {
    const rankDelta = readinessRank(right.classification) - readinessRank(left.classification);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return (right.healthReadyAtMs ?? 0) - (left.healthReadyAtMs ?? 0);
  });
  return candidates[0];
}

function readinessValue(readiness, phaseId) {
  if (!readiness?.classification || !(readiness.deadlineMs > 0)) {
    return null;
  }
  return {
    phaseId,
    listeningReadyAtMs: readiness.listeningReadyAtMs,
    healthReadyAtMs: readiness.healthReadyAtMs,
    classification: readiness.classification.state,
    severity: readiness.classification.severity,
    reason: readiness.classification.reason,
    thresholdMs: readiness.thresholdMs,
    deadlineMs: readiness.deadlineMs,
    attempts: readiness.attempts ?? null
  };
}

function readinessRank(state) {
  if (state === "hard-failure") {
    return 4;
  }
  if (state === "unhealthy") {
    return 3;
  }
  if (state === "slow-startup") {
    return 2;
  }
  if (state === "ready") {
    return 1;
  }
  return 0;
}

function startupSamplesForEntry(entry) {
  const attempts = entry.metrics?.readiness?.healthAttempts;
  if (Array.isArray(attempts) && attempts.length > 0) {
    return attempts;
  }
  return entry.metrics?.healthSamples ?? [];
}

function postReadySamplesForEntry(entry) {
  return entry.metrics?.healthSamples ?? [];
}

function summarizeScopedSamples(entries, scope, sampleSelector) {
  const samples = [];
  for (const entry of entries) {
    for (const sample of sampleSelector(entry)) {
      samples.push({ ...sample, phaseId: entry.phaseId });
    }
  }
  if (samples.length > 0) {
    return summarizeSamples(samples, scope);
  }

  const summaries = entries
    .map((entry) => ({ phaseId: entry.phaseId, summary: entry.metrics?.healthSummary }))
    .filter((entry) => entry.summary);
  if (summaries.length === 0) {
    return emptyHealthSummary(scope);
  }

  let slowestPhaseId = null;
  let maxMs = null;
  for (const { phaseId, summary } of summaries) {
    if (typeof summary.maxMs === "number" && (maxMs === null || summary.maxMs > maxMs)) {
      maxMs = summary.maxMs;
      slowestPhaseId = phaseId;
    }
  }

  return {
    scope,
    count: sum(summaries, "count"),
    okCount: sum(summaries, "okCount"),
    failureCount: sum(summaries, "failureCount"),
    minMs: minNullable(...summaries.map(({ summary }) => summary.minMs)),
    p50Ms: maxNullable(...summaries.map(({ summary }) => summary.p50Ms)),
    p95Ms: maxNullable(...summaries.map(({ summary }) => summary.p95Ms)),
    maxMs,
    slowestPhaseId
  };
}

function summarizeSamples(samples, scope) {
  const durations = samples
    .map((sample) => sample.durationMs)
    .filter((duration) => typeof duration === "number")
    .sort((left, right) => left - right);
  let slowestPhaseId = null;
  let slowestMs = null;
  for (const sample of samples) {
    if (typeof sample.durationMs === "number" && (slowestMs === null || sample.durationMs > slowestMs)) {
      slowestMs = sample.durationMs;
      slowestPhaseId = sample.phaseId ?? null;
    }
  }

  return {
    scope,
    count: samples.length,
    okCount: samples.filter((sample) => sample.ok === true).length,
    failureCount: samples.filter((sample) => sample.ok !== true).length,
    minMs: durations.at(0) ?? null,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) ?? null,
    slowestPhaseId
  };
}

function emptyHealthSummary(scope) {
  return {
    scope,
    count: 0,
    okCount: 0,
    failureCount: 0,
    minMs: null,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    slowestPhaseId: null
  };
}

function summarizeFinalHealth(metrics) {
  const samples = validHealthSamples(metrics?.healthSamples) ? metrics.healthSamples : [];
  const summary = samples.length > 0 ? summarizeSamples(samples.map((sample) => ({ ...sample, phaseId: "final" })), "final") : null;
  const singleSampleFailureCount = typeof metrics?.health?.ok === "boolean"
    ? healthFailureCount([metrics.health])
    : null;
  const aggregateFailureCount = validHealthSummaryFailureCount(metrics?.healthSummary);
  const measuredFailureCount = summary?.failureCount ??
    aggregateFailureCount ??
    singleSampleFailureCount;
  const collectionError = metrics?.error ?? null;
  const gatewayState = metrics?.service?.gatewayState ?? null;
  const evidenceComplete = metrics !== null &&
    metrics !== undefined &&
    collectionError == null &&
    typeof gatewayState === "string" &&
    measuredFailureCount !== null;
  const failureCount = evidenceComplete ? measuredFailureCount : null;
  const maxMs = summary?.maxMs ?? metrics?.healthSummary?.maxMs ?? metrics?.health?.durationMs ?? null;
  const p95Ms = summary?.p95Ms ?? metrics?.healthSummary?.p95Ms ?? null;
  const ok = evidenceComplete ? gatewayState === "running" && failureCount === 0 : null;
  return {
    scope: "final",
    gatewayState,
    ok,
    collectionError: collectionError ?? null,
    healthOk: metrics?.health?.ok ?? null,
    failureCount,
    p95Ms,
    maxMs,
    slowestPhaseId: maxMs === null ? null : "final"
  };
}

function selectSlowestSample(summaries) {
  let slowest = null;
  for (const summary of summaries) {
    if (!summary || typeof summary.maxMs !== "number") {
      continue;
    }
    if (!slowest || summary.maxMs > slowest.durationMs) {
      slowest = {
        scope: summary.scope,
        phaseId: summary.slowestPhaseId ?? null,
        durationMs: summary.maxMs
      };
    }
  }
  return slowest;
}

function healthFailureCount(samples) {
  return samples.filter((sample) => sample && sample.ok === false).length;
}

function validFailureCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function sum(entries, key) {
  return entries.reduce((total, entry) => total + (entry.summary?.[key] ?? 0), 0);
}

function maxNullable(...values) {
  const numeric = values.filter((value) => typeof value === "number");
  return numeric.length === 0 ? null : Math.max(...numeric);
}

function minNullable(...values) {
  const numeric = values.filter((value) => typeof value === "number");
  return numeric.length === 0 ? null : Math.min(...numeric);
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const index = Math.ceil(values.length * percentileValue) - 1;
  return values[Math.min(Math.max(index, 0), values.length - 1)];
}
