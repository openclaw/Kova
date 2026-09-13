import { maxNullable } from "./shared.mjs";

export function timelineRequirementFor(options) {
  const targetKind = options.targetPlan?.kind ?? null;
  const profileDiagnostics = options.profile?.diagnostics ?? {};
  const requiredForTargetKinds = profileDiagnostics.timelineRequiredForTargetKinds ?? [];
  if (profileDiagnostics.timelineRequired === true && (requiredForTargetKinds.length === 0 || requiredForTargetKinds.includes(targetKind))) {
    return {
      required: true,
      reason: `profile '${options.profile?.id ?? "unknown"}' on target kind '${targetKind ?? "unknown"}'`
    };
  }
  if (options.surface?.diagnostics?.timelineRequiredForSourceBuild === true && targetKind === "local-build" && profileDiagnostics.timelineRequired === true) {
    return {
      required: true,
      reason: `surface '${options.surface.id}' source-build diagnostics`
    };
  }
  return { required: false, reason: null };
}

export function requiredTimelineSpans(options) {
  return new Set([
    ...(options.surface?.diagnostics?.expectedSpans ?? []),
    ...(options.profile?.diagnostics?.requiredKeySpans ?? [])
  ]);
}

export function diagnosticSpanContractFor(options) {
  const targetKind = options.targetPlan?.kind ?? null;
  const profileDiagnostics = options.profile?.diagnostics ?? {};
  const spanMode = options.surface?.diagnostics?.missingExpectedSpanSeverity ??
    profileDiagnostics.missingExpectedSpanSeverity ??
    "diagnostic-gap";
  const hardRequiredSpans = Array.isArray(profileDiagnostics.requiredKeySpans) && profileDiagnostics.requiredKeySpans.length > 0;
  const enforceMissingSpans = spanMode === "fail" || hardRequiredSpans;
  const missingSpanSeverity = enforceMissingSpans ? "fail" : spanMode === "warn" ? "warning" : "diagnostic-gap";
  return {
    schemaVersion: "kova.diagnosticsContract.v1",
    targetKind,
    expectedSpanCount: requiredTimelineSpans(options).size,
    missingSpanSeverity,
    enforceMissingSpans,
    reason: enforceMissingSpans
      ? "diagnostics span contract is explicitly enforced"
      : "missing expected spans reduce diagnostic attribution but do not by themselves fail the user path"
  };
}

export function missingTimelineSpans(timelineSummary, requiredSpans) {
  return [...requiredSpans].filter((name) => !timelineSpanObserved(timelineSummary, name));
}

function timelineSpanObserved(timelineSummary, name) {
  const exact = timelineSummary.keySpans?.[name] ?? timelineSummary.spanTotals?.[name];
  if ((exact?.count ?? 0) > 0 || (exact?.openCount ?? 0) > 0) {
    return true;
  }
  if ((timelineSummary.openSpans ?? []).some((span) => span.name === name)) {
    return true;
  }
  if (name === "gateway.chat_send" || name === "auto_reply" || name === "reply" || name === "models.catalog") {
    return Object.entries(timelineSummary.spanTotals ?? {}).some(([spanName, summary]) =>
      spanName === name || (spanName.startsWith(`${name}.`) && (summary.count ?? 0) > 0)
    );
  }
  return false;
}

export function compactEvaluatedTimelineEvidence(record) {
  const timelines = recordTimelines(record);
  const currentTimeline = timelines.findLast((timeline) => timeline.available) ?? null;
  let attributionTimeline = null;
  let attributionEventCount = -1;
  for (const timeline of timelines) {
    const eventCount = timeline.eventCount ?? timeline.events?.length ?? 0;
    if (eventCount >= attributionEventCount && Array.isArray(timeline.events)) {
      attributionTimeline = timeline;
      attributionEventCount = eventCount;
    }
  }

  const retained = new Set([currentTimeline, attributionTimeline].filter(Boolean));
  for (const timeline of timelines) {
    delete timeline.openSpansAll;
    if (retained.has(timeline)) {
      continue;
    }
    delete timeline.events;
    delete timeline.turnAttributionEvents;
  }
}

export function collectTimelineSummary(record, { intentionalRestartSourcePids = new Set() } = {}) {
  const timelines = recordTimelines(record);

  const available = timelines.some((timeline) => timeline.available);
  // A rotated final timeline owns terminal span state; the most complete
  // snapshot retains attribution history from before the rotation.
  const currentTimeline = timelines.findLast((timeline) => timeline.available) ?? null;
  let attributionTimeline = null;
  let attributionEventCount = -1;
  for (const timeline of timelines) {
    const eventCount = timeline.eventCount ?? timeline.events?.length ?? 0;
    if (eventCount >= attributionEventCount && Array.isArray(timeline.events)) {
      attributionTimeline = timeline;
      attributionEventCount = eventCount;
    }
  }
  let eventCount = 0;
  let parseErrorCount = 0;
  let slowestSpan = null;
  let eventLoopMaxMs = null;
  let providerRequestMaxMs = null;
  let childProcessFailedCount = 0;
  let repeatedSpanCount = 0;
  let runtimeDepsStageMaxMs = null;
  let slowestRuntimeDepsPlugin = null;
  const terminalGatewayPid = currentTimeline?.terminalGatewayPid ?? null;
  const rawOpenSpans = currentTimeline?.openSpansAll ?? currentTimeline?.openSpans ?? [];
  const interruptedRestartSpans = terminalGatewayPid !== null
    ? rawOpenSpans.filter((span) =>
      span.pid !== null &&
      span.pid !== terminalGatewayPid &&
      intentionalRestartSourcePids.has(span.pid)
    )
    : [];
  const interruptedRestartSpanSet = new Set(interruptedRestartSpans);
  const latestOpenSpansAll = rawOpenSpans.filter((span) => !interruptedRestartSpanSet.has(span));
  const latestOpenSpanCount = latestOpenSpansAll.length;
  const latestOpenSpans = latestOpenSpansAll
    .toSorted((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1))
    .slice(0, 25);
  const events = attributionTimeline?.events ?? [];
  const turnAttributionEvents = Array.isArray(attributionTimeline?.turnAttributionEvents)
    ? attributionTimeline.turnAttributionEvents
    : [];
  const artifacts = new Set();
  const keySpans = {};
  const spanTotals = {};

  for (const timeline of timelines) {
    for (const artifact of timeline.artifacts ?? []) {
      artifacts.add(artifact);
    }
    eventCount = Math.max(eventCount, timeline.eventCount ?? 0);
    parseErrorCount = Math.max(parseErrorCount, timeline.parseErrorCount ?? 0);
    childProcessFailedCount = Math.max(childProcessFailedCount, timeline.childProcesses?.failedCount ?? 0);
    repeatedSpanCount = Math.max(repeatedSpanCount, timeline.repeatedSpans?.length ?? 0);
    mergeKeySpans(keySpans, timeline.keySpans ?? {}, {
      current: timeline === currentTimeline
    });
    mergeSpanTotals(spanTotals, timeline.spanTotals ?? {});
    eventLoopMaxMs = maxNullable(eventLoopMaxMs, timeline.eventLoop?.maxMs);
    providerRequestMaxMs = maxNullable(providerRequestMaxMs, timeline.providers?.maxDurationMs);
    runtimeDepsStageMaxMs = maxNullable(
      runtimeDepsStageMaxMs,
      timeline.runtimeDeps?.maxDurationMs ?? timeline.spanTotals?.["runtimeDeps.stage"]?.maxDurationMs
    );

    const runtimeDepsCandidate = timeline.runtimeDeps?.slowest;
    if (runtimeDepsCandidate && typeof runtimeDepsCandidate.durationMs === "number") {
      if (!slowestRuntimeDepsPlugin || runtimeDepsCandidate.durationMs > slowestRuntimeDepsPlugin.durationMs) {
        slowestRuntimeDepsPlugin = runtimeDepsCandidate;
      }
    }

    const candidate = timeline.slowestSpans?.[0];
    if (candidate && typeof candidate.durationMs === "number") {
      if (!slowestSpan || candidate.durationMs > slowestSpan.durationMs) {
        slowestSpan = candidate;
      }
    }
  }

  replaceKeySpanOpenState(keySpans, latestOpenSpansAll);

  return {
    available,
    eventCount,
    parseErrorCount,
    slowestSpanName: slowestSpan?.name ?? null,
    slowestSpanMs: slowestSpan?.durationMs ?? null,
    repeatedSpanCount,
    openSpanCount: latestOpenSpanCount,
    openSpans: latestOpenSpans,
    openSpansAll: latestOpenSpansAll,
    interruptedRestartSpanCount: interruptedRestartSpans.length,
    interruptedRestartSpans: interruptedRestartSpans.slice(0, 25),
    terminalGatewayPid,
    artifacts: [...artifacts],
    timelineArtifacts: [...artifacts],
    events,
    turnAttributionEvents,
    keySpans,
    spanTotals,
    eventLoopMaxMs,
    providerRequestMaxMs,
    childProcessFailedCount,
    runtimeDepsStageMaxMs,
    runtimeDepsStagePluginId: slowestRuntimeDepsPlugin?.pluginId ?? null
  };
}

function replaceKeySpanOpenState(keySpans, openSpans) {
  for (const [name, summary] of Object.entries(keySpans)) {
    const open = openSpans.filter((span) => keyTimelineSpanMatches(name, span.name));
    summary.openCount = open.length;
    summary.open = open.slice(0, 5);
  }
}

function keyTimelineSpanMatches(keyName, spanName) {
  if (keyName === "gateway.chat_send" || keyName === "auto_reply" || keyName === "reply") {
    return spanName === keyName || spanName.startsWith(`${keyName}.`);
  }
  return spanName === keyName;
}

function recordTimelines(record) {
  const timelines = [];
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.timeline) {
      timelines.push(phase.metrics.timeline);
    }
  }
  if (record.finalMetrics?.timeline) {
    timelines.push(record.finalMetrics.timeline);
  }
  return timelines;
}

function mergeSpanTotals(target, source) {
  for (const [name, summary] of Object.entries(source)) {
    const existing = target[name] ?? {
      name,
      count: 0,
      errorCount: 0,
      openCount: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      slowest: null
    };
    existing.count = Math.max(existing.count, summary.count ?? 0);
    existing.errorCount = Math.max(existing.errorCount, summary.errorCount ?? 0);
    existing.openCount = Math.max(existing.openCount, summary.openCount ?? 0);
    existing.totalDurationMs = Math.max(existing.totalDurationMs, summary.totalDurationMs ?? 0);
    existing.maxDurationMs = maxNullable(existing.maxDurationMs, summary.maxDurationMs);
    if (summary.slowest?.durationMs !== undefined &&
      (!existing.slowest || summary.slowest.durationMs > existing.slowest.durationMs)) {
      existing.slowest = summary.slowest;
    }
    target[name] = existing;
  }
}

function mergeKeySpans(target, source, { current = false } = {}) {
  for (const [name, summary] of Object.entries(source)) {
    const existing = target[name] ?? {
      name,
      count: 0,
      errorCount: 0,
      openCount: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      slowest: null,
      open: []
    };
    existing.count = Math.max(existing.count, summary.count ?? 0);
    existing.errorCount = Math.max(existing.errorCount, summary.errorCount ?? 0);
    existing.totalDurationMs = Math.max(existing.totalDurationMs, summary.totalDurationMs ?? 0);
    existing.maxDurationMs = maxNullable(existing.maxDurationMs, summary.maxDurationMs);
    if (summary.slowest?.durationMs !== undefined &&
      (!existing.slowest || summary.slowest.durationMs > existing.slowest.durationMs)) {
      existing.slowest = summary.slowest;
    }
    if (current) {
      existing.openCount = summary.openCount ?? summary.open?.length ?? 0;
      existing.open = [...(summary.open ?? [])].slice(0, 5);
    }
    target[name] = existing;
  }
}
