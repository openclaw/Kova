export function buildPreProviderAttribution({
  schemaVersion,
  label,
  phaseId,
  activeStartedAtEpochMs,
  activeFinishedAtEpochMs,
  attribution,
  timelineSummary,
  isAttributedSpanName,
  missingEventsError
}) {
  const artifacts = timelineArtifacts(timelineSummary);
  const events = attributionEvents(timelineSummary);
  const providerBoundaryEpochMs = numberOrNull(attribution?.firstProviderRequestAtEpochMs);
  const windowStartEpochMs = numberOrNull(activeStartedAtEpochMs ?? attribution?.commandStartedAtEpochMs);
  const activeEndEpochMs = numberOrNull(activeFinishedAtEpochMs ?? attribution?.commandFinishedAtEpochMs);
  const windowEndEpochMs = providerBoundaryEpochMs;
  const preProviderMs = numberOrNull(attribution?.preProviderMs) ??
    durationBetween(windowStartEpochMs, windowEndEpochMs);
  const base = {
    schemaVersion,
    available: false,
    label: label ?? null,
    phaseId: phaseId ?? null,
    timelineAvailable: timelineSummary?.available === true,
    timelineArtifacts: artifacts,
    eventCount: events.length,
    window: {
      startEpochMs: windowStartEpochMs,
      startAt: isoOrNull(windowStartEpochMs),
      endEpochMs: windowEndEpochMs,
      endAt: isoOrNull(windowEndEpochMs),
      durationMs: preProviderMs
    },
    activeWindow: {
      startEpochMs: windowStartEpochMs,
      startAt: isoOrNull(windowStartEpochMs),
      endEpochMs: activeEndEpochMs,
      endAt: isoOrNull(activeEndEpochMs),
      durationMs: durationBetween(windowStartEpochMs, activeEndEpochMs)
    },
    providerBoundary: {
      firstRequestAtEpochMs: providerBoundaryEpochMs,
      firstRequestAt: isoOrNull(providerBoundaryEpochMs),
      source: providerBoundaryEpochMs === null ? null : "provider-evidence"
    },
    provider: summarizeProviderEvents(events, providerBoundaryEpochMs, activeEndEpochMs, attribution),
    spanSummaries: [],
    knownAttributedMs: null,
    unattributedMs: preProviderMs,
    coverageRatio: null,
    error: null
  };

  if (timelineSummary?.available !== true) {
    return {
      ...base,
      error: "OpenClaw diagnostics timeline unavailable"
    };
  }
  if (events.length === 0) {
    return {
      ...base,
      error: missingEventsError ?? "timeline contains no pre-provider attribution events"
    };
  }
  if (windowStartEpochMs === null || windowEndEpochMs === null || preProviderMs === null || windowEndEpochMs < windowStartEpochMs) {
    return {
      ...base,
      error: "pre-provider window boundary unavailable"
    };
  }

  const intervals = attributedSpanIntervals(events, isAttributedSpanName)
    .map((span) => clipSpanToWindow(span, windowStartEpochMs, windowEndEpochMs))
    .filter(Boolean);
  const spanSummaries = summarizeAttributedSpans(intervals);
  const knownAttributedMs = round(unionDuration(intervals));
  const unattributedMs = round(Math.max(0, preProviderMs - knownAttributedMs));

  return {
    ...base,
    available: true,
    spanSummaries,
    knownAttributedMs,
    unattributedMs,
    coverageRatio: preProviderMs > 0 ? round(knownAttributedMs / preProviderMs) : null,
    error: null
  };
}

export function summarizePreProviderAttributions({ schemaVersion, turns, fieldName }) {
  const entries = (turns ?? [])
    .map((turn) => turn?.[fieldName])
    .filter(Boolean);
  const cold = summarizeLabeledAttribution(entries, "cold");
  const warm = summarizeLabeledAttribution(entries, "warm");
  return {
    schemaVersion,
    available: entries.some((entry) => entry.available === true),
    count: entries.length,
    cold,
    warm,
    spanMedians: summarizeSpanMedians(entries),
    timelineArtifacts: unique(entries.flatMap((entry) => entry.timelineArtifacts ?? []))
  };
}

export function preProviderMarkdownRows({ title, turns, fieldName }) {
  const attributions = (turns ?? [])
    .map((turn) => turn?.[fieldName])
    .filter(Boolean);
  if (attributions.length === 0) {
    return [];
  }

  const lines = [
    `- ${title}:`,
    "",
    "  | turn | pre-provider | known | unattributed | provider | timeline |",
    "  |---|---:|---:|---:|---:|---|"
  ];
  for (const item of attributions) {
    const timeline = item.timelineArtifacts?.[0] ?? (item.timelineAvailable ? "available" : "missing");
    lines.push(
      `  | ${item.label ?? "turn"} | ${formatMs(item.window?.durationMs)} | ${formatMs(item.knownAttributedMs)} | ${formatMs(item.unattributedMs)} | ${formatMs(item.provider?.totalDurationMs)} | ${timeline} |`
    );
  }

  const spanRows = attributions.flatMap((item) =>
    (item.spanSummaries ?? []).slice(0, 6).map((span) => ({ turn: item.label ?? "turn", ...span }))
  );
  if (spanRows.length > 0) {
    lines.push("");
    lines.push("  | turn | span | count | errors | clipped | max |");
    lines.push("  |---|---|---:|---:|---:|---:|");
    for (const span of spanRows.slice(0, 12)) {
      lines.push(
        `  | ${span.turn} | \`${span.name}\` | ${span.count} | ${span.errorCount} | ${formatMs(span.totalClippedDurationMs)} | ${formatMs(span.maxClippedDurationMs)} |`
      );
    }
  }
  return lines;
}

export function attributedSpanIntervals(events, isAttributedSpanName) {
  const startsById = new Map();
  const intervals = [];

  for (const event of events ?? []) {
    if (event?.type === "span.start" && isAttributedSpanName(event.name)) {
      const key = spanKey(event);
      if (key) {
        startsById.set(key, event);
      }
      continue;
    }
    if ((event?.type === "span.end" || event?.type === "span.error") && isAttributedSpanName(event.name)) {
      const terminal = spanIntervalFromTerminal(event, startsById.get(spanKey(event)));
      if (terminal) {
        intervals.push(terminal);
      }
    }
  }

  return intervals;
}

function spanIntervalFromTerminal(event, startEvent) {
  const endEpochMs = eventEpochMs(event);
  const durationMs = numberOrNull(event.durationMs) ?? durationBetween(eventEpochMs(startEvent), endEpochMs);
  const startEpochMs = eventEpochMs(startEvent) ??
    (endEpochMs !== null && durationMs !== null ? endEpochMs - durationMs : null);
  if (startEpochMs === null || endEpochMs === null || endEpochMs < startEpochMs) {
    return null;
  }
  return {
    name: event.name,
    type: event.type,
    startEpochMs,
    endEpochMs,
    durationMs: round(endEpochMs - startEpochMs),
    rawDurationMs: durationMs,
    spanId: event.spanId ?? null,
    phase: event.phase ?? startEvent?.phase ?? null,
    errorName: event.errorName ?? null,
    errorMessage: event.errorMessage ?? null
  };
}

function clipSpanToWindow(span, windowStartEpochMs, windowEndEpochMs) {
  const startEpochMs = Math.max(span.startEpochMs, windowStartEpochMs);
  const endEpochMs = Math.min(span.endEpochMs, windowEndEpochMs);
  if (endEpochMs <= startEpochMs) {
    return null;
  }
  return {
    ...span,
    clippedStartEpochMs: startEpochMs,
    clippedEndEpochMs: endEpochMs,
    clippedDurationMs: round(endEpochMs - startEpochMs)
  };
}

function summarizeAttributedSpans(intervals) {
  const byName = new Map();
  for (const interval of intervals) {
    const current = byName.get(interval.name) ?? {
      name: interval.name,
      count: 0,
      errorCount: 0,
      totalClippedDurationMs: 0,
      maxClippedDurationMs: null,
      totalRawDurationMs: 0,
      maxRawDurationMs: null
    };
    current.count += 1;
    if (interval.type === "span.error") {
      current.errorCount += 1;
    }
    current.totalClippedDurationMs = round(current.totalClippedDurationMs + interval.clippedDurationMs);
    current.maxClippedDurationMs = maxNullable(current.maxClippedDurationMs, interval.clippedDurationMs);
    if (typeof interval.rawDurationMs === "number") {
      current.totalRawDurationMs = round(current.totalRawDurationMs + interval.rawDurationMs);
      current.maxRawDurationMs = maxNullable(current.maxRawDurationMs, interval.rawDurationMs);
    }
    byName.set(interval.name, current);
  }
  return [...byName.values()].toSorted((left, right) =>
    (right.totalClippedDurationMs - left.totalClippedDurationMs) ||
    left.name.localeCompare(right.name)
  );
}

function summarizeProviderEvents(events, providerBoundaryEpochMs, activeFinishedAtEpochMs, attribution) {
  const providerEvents = (events ?? [])
    .filter((event) => event?.type === "provider.request" || event?.name === "provider.request")
    .map((event) => {
      const startEpochMs = numberOrNull(event.receivedAtEpochMs) ?? eventEpochMs(event);
      const durationMs = numberOrNull(event.durationMs);
      const endEpochMs = numberOrNull(event.respondedAtEpochMs) ??
        (startEpochMs !== null && durationMs !== null ? startEpochMs + durationMs : null);
      return { event, startEpochMs, endEpochMs, durationMs: durationMs ?? durationBetween(startEpochMs, endEpochMs) };
    })
    .filter((event) =>
      event.startEpochMs !== null &&
      (providerBoundaryEpochMs === null || event.startEpochMs >= providerBoundaryEpochMs) &&
      (activeFinishedAtEpochMs === null || event.startEpochMs <= activeFinishedAtEpochMs)
    );
  const durations = providerEvents.map((event) => event.durationMs).filter(isNumber);
  return {
    requestCount: providerEvents.length,
    timelineTotalDurationMs: round(durations.reduce((sum, value) => sum + value, 0)),
    timelineMaxDurationMs: durations.length > 0 ? Math.max(...durations) : null,
    totalDurationMs: numberOrNull(attribution?.providerFinalMs) ??
      round(durations.reduce((sum, value) => sum + value, 0)),
    firstByteLatencyMs: numberOrNull(attribution?.firstByteLatencyMs),
    firstChunkLatencyMs: numberOrNull(attribution?.firstChunkLatencyMs)
  };
}

function summarizeLabeledAttribution(entries, label) {
  const values = entries.filter((entry) => entry.label === label);
  return {
    count: values.length,
    preProviderMs: summarizeValues(values.map((entry) => entry.window?.durationMs)),
    knownAttributedMs: summarizeValues(values.map((entry) => entry.knownAttributedMs)),
    unattributedMs: summarizeValues(values.map((entry) => entry.unattributedMs)),
    coverageRatio: summarizeValues(values.map((entry) => entry.coverageRatio))
  };
}

function summarizeSpanMedians(entries) {
  const byName = new Map();
  for (const entry of entries) {
    for (const span of entry.spanSummaries ?? []) {
      const current = byName.get(span.name) ?? [];
      current.push(span.totalClippedDurationMs);
      byName.set(span.name, current);
    }
  }
  return [...byName.entries()]
    .map(([name, values]) => ({
      name,
      medianClippedDurationMs: summarizeValues(values).median,
      sampleCount: values.length
    }))
    .toSorted((left, right) => (right.medianClippedDurationMs ?? 0) - (left.medianClippedDurationMs ?? 0));
}

function summarizeValues(values) {
  const sorted = values.filter(isNumber).toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, median: null, min: null, max: null };
  }
  return {
    count: sorted.length,
    median: round(percentile(sorted, 50)),
    min: round(sorted[0]),
    max: round(sorted.at(-1))
  };
}

function unionDuration(intervals) {
  const sorted = intervals
    .filter((interval) => isNumber(interval.clippedStartEpochMs) && isNumber(interval.clippedEndEpochMs))
    .toSorted((left, right) => left.clippedStartEpochMs - right.clippedStartEpochMs);
  let total = 0;
  let currentStart = null;
  let currentEnd = null;
  for (const interval of sorted) {
    if (currentStart === null) {
      currentStart = interval.clippedStartEpochMs;
      currentEnd = interval.clippedEndEpochMs;
      continue;
    }
    if (interval.clippedStartEpochMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.clippedEndEpochMs);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = interval.clippedStartEpochMs;
    currentEnd = interval.clippedEndEpochMs;
  }
  if (currentStart !== null) {
    total += currentEnd - currentStart;
  }
  return total;
}

function attributionEvents(timelineSummary) {
  return Array.isArray(timelineSummary?.turnAttributionEvents) && timelineSummary.turnAttributionEvents.length > 0
    ? timelineSummary.turnAttributionEvents
    : (Array.isArray(timelineSummary?.events) ? timelineSummary.events : []);
}

function timelineArtifacts(timelineSummary) {
  return unique([
    ...(timelineSummary?.artifacts ?? []),
    ...(timelineSummary?.timelineArtifacts ?? [])
  ].filter(Boolean));
}

function spanKey(event) {
  return event?.spanId === undefined || event?.spanId === null || String(event.spanId).length === 0
    ? null
    : String(event.spanId);
}

function eventEpochMs(event) {
  const direct = numberOrNull(event?.timestampEpochMs ?? event?.timeEpochMs);
  if (direct !== null) {
    return direct;
  }
  const parsed = Date.parse(event?.timestamp ?? event?.time ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function durationBetween(startEpochMs, endEpochMs) {
  return isNumber(startEpochMs) && isNumber(endEpochMs) && endEpochMs >= startEpochMs
    ? round(endEpochMs - startEpochMs)
    : null;
}

function percentile(sortedValues, percentileValue) {
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
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function maxNullable(left, right) {
  if (!isNumber(right)) {
    return left;
  }
  return isNumber(left) ? Math.max(left, right) : right;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? round(number) : null;
}

function isoOrNull(epochMs) {
  return isNumber(epochMs) ? new Date(epochMs).toISOString() : null;
}

function formatMs(value) {
  return isNumber(value) ? `${value} ms` : "unknown";
}

function unique(values) {
  return [...new Set(values)];
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
