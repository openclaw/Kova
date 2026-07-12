import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = "openclaw.diagnostics.v1";
export const TIMELINE_COLLECTOR_SCHEMA = "kova.timelineCollector.v1";
export const KEY_OPENCLAW_SPANS = [
  "gateway.startup",
  "gateway.ready",
  "gateway.chat_send",
  "config.normalize",
  "plugins.metadata.scan",
  "runtimeDeps.stage",
  "providers.load",
  "models.catalog",
  "models.catalog.gateway",
  "models.catalog.load",
  "models.discovery",
  "channel.capabilities",
  "channel.plugin.get",
  "channel.plugin.load",
  "agent.prepare",
  "agent.turn",
  "agent.cleanup",
  "auto_reply",
  "reply"
];

export async function collectTimelineMetrics(artifactDir) {
  const startedAt = Date.now();
  const timelinePath = artifactDir ? join(artifactDir, "openclaw", "timeline.jsonl") : null;
  if (!timelinePath) {
    return {
      schemaVersion: TIMELINE_COLLECTOR_SCHEMA,
      commandStatus: 0,
      statusLabel: "INFO",
      durationMs: 0,
      available: false,
      error: "artifact directory unavailable",
      artifacts: []
    };
  }

  const timeline = await loadTimeline(timelinePath);
  return {
    schemaVersion: TIMELINE_COLLECTOR_SCHEMA,
    commandStatus: 0,
    statusLabel: timeline.available ? "PASS" : "INFO",
    durationMs: Date.now() - startedAt,
    available: timeline.available,
    eventCount: timeline.eventCount,
    parseErrorCount: timeline.parseErrorCount,
    spanCount: timeline.spanCount,
    slowestSpans: timeline.slowestSpans,
    spanTotals: timeline.spanTotals,
    repeatedSpans: timeline.repeatedSpans,
    openSpans: timeline.openSpans,
    openSpansAll: timeline.openSpansAll,
    gatewayPids: timeline.gatewayPids,
    terminalGatewayPid: timeline.terminalGatewayPid,
    keySpans: timeline.keySpans,
    runtimeDeps: timeline.runtimeDeps,
    eventLoop: timeline.eventLoop,
    providers: timeline.providers,
    childProcesses: timeline.childProcesses,
    turnAttributionEvents: timeline.turnAttributionEvents,
    events: timeline.events,
    artifacts: timeline.available ? [timelinePath] : [],
    error: timeline.available ? null : (timeline.error ?? (timeline.missing ? "OpenClaw timeline not emitted" : null))
  };
}

export async function loadTimeline(path) {
  try {
    const text = await readFile(path, "utf8");
    return {
      ...parseTimelineText(text),
      path
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyTimeline({ path, missing: true });
    }
    return emptyTimeline({ path, error: error.message });
  }
}

export function parseTimelineText(text) {
  const events = [];
  const parseErrors = [];

  for (const [index, rawLine] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      if (!isObject(event)) {
        parseErrors.push({ line: index + 1, error: "event is not an object" });
        continue;
      }
      events.push(normalizeEvent(event, index + 1));
    } catch (error) {
      parseErrors.push({ line: index + 1, error: error.message });
    }
  }

  return summarizeTimeline(events, parseErrors);
}

export function summarizeTimeline(events, parseErrors = []) {
  const spanStarts = events.filter((event) => event.type === "span.start");
  const spanEvents = events.filter((event) => event.type === "span.end" || event.type === "span.error");
  const eventLoopSamples = events.filter((event) => event.type === "eventLoop.sample");
  const providerRequests = events.filter((event) => event.type === "provider.request");
  const childProcesses = events.filter((event) => event.type === "childProcess.exit");
  const spanTotals = summarizeSpans(spanEvents);
  const openSpansAll = summarizeOpenSpans(events);
  const openSpans = openSpansAll.slice(0, 25);
  const gatewayPids = gatewayProcessPids(events);
  const runtimeDeps = summarizeRuntimeDeps(spanEvents);
  const slowestSpans = spanEvents
    .filter((event) => typeof event.durationMs === "number")
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .slice(0, 10)
    .map(compactTimedEvent);

  return {
    available: events.length > 0,
    schemaVersion: SCHEMA_VERSION,
    eventCount: events.length,
    parseErrorCount: parseErrors.length,
    parseErrors: parseErrors.slice(0, 20),
    spanStartCount: spanStarts.length,
    spanCount: spanEvents.length,
    slowestSpans,
    spanTotals,
    repeatedSpans: Object.values(spanTotals)
      .filter((span) => span.count > 1)
      .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || (right.count - left.count))
      .slice(0, 10),
    openSpanCount: openSpansAll.length,
    openSpans,
    openSpansAll,
    gatewayPids,
    terminalGatewayPid: gatewayPids.at(-1) ?? null,
    keySpans: summarizeKeySpans({ spanEvents, openSpans: openSpansAll }),
    runtimeDeps,
    eventLoop: summarizeEventLoop(eventLoopSamples),
    providers: summarizeTimedCollection(providerRequests),
    childProcesses: summarizeChildProcesses(childProcesses),
    turnAttributionEvents: events.filter(isTurnAttributionEvent).map(compactAttributionEvent),
    events: events.slice(0, 200)
  };
}

function emptyTimeline(extra = {}) {
  return {
    available: false,
    schemaVersion: SCHEMA_VERSION,
    eventCount: 0,
    parseErrorCount: 0,
    parseErrors: [],
    spanCount: 0,
    slowestSpans: [],
    spanTotals: {},
    repeatedSpans: [],
    openSpanCount: 0,
    openSpans: [],
    openSpansAll: [],
    gatewayPids: [],
    terminalGatewayPid: null,
    keySpans: emptyKeySpans(),
    runtimeDeps: {
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      slowest: null,
      byPlugin: []
    },
    eventLoop: {
      sampleCount: 0,
      p95MaxMs: null,
      p99MaxMs: null,
      maxMs: null,
      slowestSample: null
    },
    providers: {
      count: 0,
      maxDurationMs: null,
      slowest: null
    },
    childProcesses: {
      count: 0,
      failedCount: 0,
      maxDurationMs: null,
      slowest: null
    },
    turnAttributionEvents: [],
    events: [],
    ...extra
  };
}

function normalizeEvent(event, line) {
  const normalized = {
    ...event,
    line,
    schemaVersion: event.schemaVersion ?? SCHEMA_VERSION,
    type: String(event.type ?? "mark"),
    name: String(event.name ?? event.phase ?? event.operation ?? "unknown"),
    timestamp: event.timestamp ?? event.time ?? null,
    durationMs: numberOrNull(event.durationMs ?? event.elapsedMs ?? event.ms)
  };

  if (normalized.durationMs === null) {
    delete normalized.durationMs;
  }

  if (isObject(event.attributes)) {
    normalized.attributes = event.attributes;
  }

  return normalized;
}

function summarizeSpans(events) {
  const totals = {};
  for (const event of events) {
    const existing = totals[event.name] ?? {
      name: event.name,
      count: 0,
      errorCount: 0,
      totalDurationMs: 0,
      maxDurationMs: null
    };
    existing.count += 1;
    if (event.type === "span.error") {
      existing.errorCount += 1;
    }
    if (typeof event.durationMs === "number") {
      existing.totalDurationMs = round(existing.totalDurationMs + event.durationMs);
      existing.maxDurationMs = existing.maxDurationMs === null ? event.durationMs : Math.max(existing.maxDurationMs, event.durationMs);
    }
    totals[event.name] = existing;
  }
  return totals;
}

function summarizeRuntimeDeps(events) {
  const runtimeDepsEvents = events.filter((event) => event.name === "runtimeDeps.stage");
  const byPlugin = new Map();
  let totalDurationMs = 0;
  let maxDurationMs = null;
  let slowest = null;

  for (const event of runtimeDepsEvents) {
    const durationMs = typeof event.durationMs === "number" ? event.durationMs : null;
    const pluginId = event.pluginId ?? event.attributes?.pluginId ?? "gateway";
    const dependencyCount = numberOrNull(event.dependencyCount ?? event.attributes?.dependencyCount ?? event.attributes?.pluginCount);
    const existing = byPlugin.get(pluginId) ?? {
      pluginId,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: null,
      dependencyCountMax: null
    };

    existing.count += 1;
    if (durationMs !== null) {
      totalDurationMs = round(totalDurationMs + durationMs);
      maxDurationMs = maxDurationMs === null ? durationMs : Math.max(maxDurationMs, durationMs);
      existing.totalDurationMs = round(existing.totalDurationMs + durationMs);
      existing.maxDurationMs = existing.maxDurationMs === null ? durationMs : Math.max(existing.maxDurationMs, durationMs);
      if (!slowest || durationMs > slowest.durationMs) {
        slowest = compactTimedEvent(event);
      }
    }
    existing.dependencyCountMax = maxNullable(existing.dependencyCountMax, dependencyCount);
    byPlugin.set(pluginId, existing);
  }

  return {
    count: runtimeDepsEvents.length,
    totalDurationMs,
    maxDurationMs,
    slowest,
    byPlugin: [...byPlugin.values()]
      .map((entry) => ({
        ...entry,
        totalDurationMs: round(entry.totalDurationMs),
        maxDurationMs: entry.maxDurationMs === null ? null : round(entry.maxDurationMs)
      }))
      .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || (right.maxDurationMs ?? 0) - (left.maxDurationMs ?? 0))
      .slice(0, 10)
  };
}

function summarizeOpenSpans(events) {
  const starts = [];
  const matched = new Set();
  const buckets = new Map();
  const latestTimestamp = latestEventTimestamp(events);

  // Consume the append-only stream in order. Per-identity stacks keep matching
  // amortized linear while newest-first wildcard matching handles reused span IDs.
  for (const event of events) {
    if (event.type === "span.start") {
      const index = starts.push(event) - 1;
      const bucket = spanMatchBucket(buckets, event);
      bucket.all.push(index);
      const pidKey = spanPidKey(event.pid);
      const pidStack = bucket.byPid.get(pidKey) ?? [];
      pidStack.push(index);
      bucket.byPid.set(pidKey, pidStack);
      continue;
    }
    if (event.type !== "span.end" && event.type !== "span.error") {
      continue;
    }
    const bucket = buckets.get(spanMatchKey(event));
    if (!bucket) {
      continue;
    }
    const terminalPidKey = spanPidKey(event.pid);
    const index = terminalPidKey === UNKNOWN_PID_KEY
      ? popUnmatched(bucket.all, matched)
      : popUnmatched(bucket.byPid.get(terminalPidKey), matched) ??
        popUnmatched(bucket.byPid.get(UNKNOWN_PID_KEY), matched);
    if (index !== null) {
      matched.add(index);
    }
  }

  return starts.flatMap((start, index) => matched.has(index) ? [] : [{
      type: start.type,
      name: start.name,
      spanId: start.spanId ?? null,
      parentSpanId: start.parentSpanId ?? null,
      timestamp: start.timestamp ?? null,
      ageMs: spanAgeMs(start, latestTimestamp),
      phase: start.phase ?? null,
      provider: start.provider ?? start.attributes?.provider ?? null,
      operation: start.operation ?? start.attributes?.operation ?? null,
      pluginId: start.pluginId ?? start.attributes?.pluginId ?? null,
      pid: start.pid ?? null
    }]).toSorted((left, right) => (right.ageMs ?? -1) - (left.ageMs ?? -1));
}

const UNKNOWN_PID_KEY = "<unknown>";

function spanMatchBucket(buckets, event) {
  const key = spanMatchKey(event);
  const bucket = buckets.get(key) ?? { all: [], byPid: new Map() };
  buckets.set(key, bucket);
  return bucket;
}

function spanMatchKey(event) {
  const spanId = spanIdOrNull(event);
  return spanId === null ? `name:${event.name}` : `id:${spanId}`;
}

function spanPidKey(pid) {
  return pid === undefined || pid === null ? UNKNOWN_PID_KEY : String(pid);
}

function popUnmatched(stack, matched) {
  while (stack?.length > 0 && matched.has(stack.at(-1))) {
    stack.pop();
  }
  return stack?.pop() ?? null;
}

function summarizeKeySpans({ spanEvents, openSpans }) {
  const byName = {};
  for (const name of KEY_OPENCLAW_SPANS) {
    const spans = spanEvents.filter((event) => keySpanMatches(name, event.name));
    const open = openSpans.filter((event) => keySpanMatches(name, event.name));
    const durations = spans.map((event) => event.durationMs).filter(isNumber);
    const slowest = spans
      .filter((event) => typeof event.durationMs === "number")
      .toSorted((left, right) => right.durationMs - left.durationMs)
      .at(0);
    byName[name] = {
      name,
      count: spans.length,
      errorCount: spans.filter((event) => event.type === "span.error").length,
      openCount: open.length,
      totalDurationMs: round(durations.reduce((total, value) => total + value, 0)),
      maxDurationMs: maxOrNull(durations),
      slowest: slowest ? compactTimedEvent(slowest) : null,
      open: open.slice(0, 5)
    };
  }
  return byName;
}

function keySpanMatches(keyName, eventName) {
  if (keyName === "gateway.chat_send") {
    return eventName === keyName || eventName.startsWith("gateway.chat_send.");
  }
  if (keyName === "auto_reply") {
    return eventName === keyName || eventName.startsWith("auto_reply.");
  }
  if (keyName === "reply") {
    return eventName === keyName || eventName.startsWith("reply.");
  }
  return eventName === keyName;
}

function emptyKeySpans() {
  return Object.fromEntries(KEY_OPENCLAW_SPANS.map((name) => [name, {
    name,
    count: 0,
    errorCount: 0,
    openCount: 0,
    totalDurationMs: 0,
    maxDurationMs: null,
    slowest: null,
    open: []
  }]));
}

function summarizeEventLoop(samples) {
  const p95Values = samples.map((sample) => numberOrNull(sample.p95Ms)).filter(isNumber);
  const p99Values = samples.map((sample) => numberOrNull(sample.p99Ms)).filter(isNumber);
  const maxValues = samples.map((sample) => numberOrNull(sample.maxMs ?? sample.eventLoopDelayMs)).filter(isNumber);
  const slowestSample = samples
    .map((sample) => ({
      timestamp: sample.timestamp ?? null,
      p95Ms: numberOrNull(sample.p95Ms),
      p99Ms: numberOrNull(sample.p99Ms),
      maxMs: numberOrNull(sample.maxMs ?? sample.eventLoopDelayMs),
      activeSpanName: sample.activeSpanName ?? sample.spanName ?? null
    }))
    .toSorted((left, right) => (right.maxMs ?? -1) - (left.maxMs ?? -1))
    .at(0) ?? null;

  return {
    sampleCount: samples.length,
    p95MaxMs: maxOrNull(p95Values),
    p99MaxMs: maxOrNull(p99Values),
    maxMs: maxOrNull(maxValues),
    slowestSample
  };
}

function summarizeTimedCollection(events) {
  const timed = events.filter((event) => typeof event.durationMs === "number");
  const slowest = timed.toSorted((left, right) => right.durationMs - left.durationMs).at(0);
  return {
    count: events.length,
    maxDurationMs: slowest?.durationMs ?? null,
    slowest: slowest ? compactTimedEvent(slowest) : null
  };
}

function summarizeChildProcesses(events) {
  const summary = summarizeTimedCollection(events);
  return {
    ...summary,
    failedCount: events.filter((event) => {
      const exitCode = numberOrNull(event.exitCode ?? event.code);
      return exitCode !== null ? exitCode !== 0 : Boolean(event.signal);
    }).length
  };
}

function compactTimedEvent(event) {
  return {
    type: event.type,
    name: event.name,
    spanId: event.spanId ?? null,
    parentSpanId: event.parentSpanId ?? null,
    durationMs: event.durationMs ?? null,
    timestamp: event.timestamp ?? null,
    phase: event.phase ?? null,
    provider: event.provider ?? event.attributes?.provider ?? null,
    operation: event.operation ?? event.attributes?.operation ?? null,
    pluginId: event.pluginId ?? event.attributes?.pluginId ?? null,
    pid: event.pid ?? null,
    exitCode: event.exitCode ?? event.code ?? null,
    signal: event.signal ?? null,
    errorName: event.errorName ?? event.attributes?.errorName ?? null,
    errorMessage: event.errorMessage ?? event.attributes?.errorMessage ?? null
  };
}

function isTurnAttributionEvent(event) {
  if (event.type === "eventLoop.sample") {
    return true;
  }
  if (event.type === "provider.request" || event.name === "provider.request") {
    return true;
  }
  if (event.type !== "span.start" && event.type !== "span.end" && event.type !== "span.error") {
    return false;
  }
  return event.name === "plugins.metadata.scan" ||
    event.name === "provider.request" ||
    event.name === "agent.prepare" ||
    event.name === "agent.turn" ||
    event.name === "agent.cleanup" ||
    event.name === "runtimeDeps.stage" ||
    event.name === "channel.capabilities" ||
    event.name === "models.catalog" ||
    event.name === "auto_reply" ||
    event.name.startsWith("auto_reply.") ||
    event.name.startsWith("gateway.chat_send") ||
    event.name.startsWith("models.catalog.") ||
    event.name.startsWith("models.discovery") ||
    event.name.startsWith("channel.plugin.") ||
    event.name.startsWith("reply.");
}

function compactAttributionEvent(event) {
  return {
    type: event.type,
    name: event.name,
    timestamp: event.timestamp ?? null,
    timestampEpochMs: numberOrNull(event.timestampEpochMs ?? event.timeEpochMs) ?? parsedTimestampMs(event.timestamp ?? event.time),
    durationMs: event.durationMs ?? null,
    spanId: event.spanId ?? null,
    parentSpanId: event.parentSpanId ?? null,
    phase: event.phase ?? null,
    pid: event.pid ?? null,
    provider: event.provider ?? event.attributes?.provider ?? null,
    operation: event.operation ?? event.attributes?.operation ?? null,
    pluginId: event.pluginId ?? event.attributes?.pluginId ?? null,
    errorName: event.errorName ?? event.attributes?.errorName ?? null,
    errorMessage: event.errorMessage ?? event.attributes?.errorMessage ?? null,
    maxMs: numberOrNull(event.maxMs ?? event.eventLoopDelayMs),
    p95Ms: numberOrNull(event.p95Ms),
    p99Ms: numberOrNull(event.p99Ms),
    receivedAtEpochMs: numberOrNull(event.receivedAtEpochMs),
    respondedAtEpochMs: numberOrNull(event.respondedAtEpochMs),
    status: numberOrNull(event.status),
    route: event.route ?? event.path ?? null,
    model: event.model ?? event.modelId ?? event.attributes?.model ?? null
  };
}

function parsedTimestampMs(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function spanIdOrNull(event) {
  if (event.spanId === undefined || event.spanId === null || String(event.spanId).length === 0) {
    return null;
  }
  return String(event.spanId);
}

function gatewayProcessPids(events) {
  const pids = [];
  for (const event of events) {
    if (event.pid === undefined || event.pid === null || !isGatewayLifecycleEvent(event)) {
      continue;
    }
    const existing = pids.indexOf(event.pid);
    if (existing !== -1) {
      pids.splice(existing, 1);
    }
    pids.push(event.pid);
  }
  return pids;
}

function isGatewayLifecycleEvent(event) {
  return event.name === "gateway.startup" ||
    event.name === "gateway.ready" ||
    event.name === "http.bound" ||
    event.name === "http.listen" ||
    String(event.spanId ?? "").startsWith("gateway-startup-");
}

function latestEventTimestamp(events) {
  const times = events
    .map((event) => Date.parse(event.timestamp ?? ""))
    .filter((time) => Number.isFinite(time));
  return times.length === 0 ? null : Math.max(...times);
}

function spanAgeMs(event, latestTimestamp) {
  const start = Date.parse(event.timestamp ?? "");
  if (!Number.isFinite(start) || latestTimestamp === null || latestTimestamp < start) {
    return null;
  }
  return latestTimestamp - start;
}

function maxOrNull(values) {
  return values.length === 0 ? null : Math.max(...values);
}

function maxNullable(left, right) {
  if (typeof right !== "number") {
    return left;
  }
  return left === null ? right : Math.max(left, right);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? round(number) : null;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function isNumber(value) {
  return typeof value === "number";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
