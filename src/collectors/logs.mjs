import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isOptionalNoLogsResult } from "../command-results.mjs";
import { runCommand } from "../commands.mjs";
import { ocmLogs } from "../ocm/commands.mjs";

export const LOG_METRICS_SCHEMA = "kova.logMetrics.v1";

const PROVIDER_TIMEOUT_SIGNAL_PATTERN =
  /(?:\bprovider\b|\bmodel\b).*(?:\btimeouts?\b|\btimed out\b)|(?:\btimeouts?\b|\btimed out\b).*(?:\bprovider\b|\bmodel\b)/i;
const SENSITIVE_LOG_KEY = String.raw`[a-z0-9_-]*(?:api[_-]?key|token|secret|password|cookie|credential|private[_-]?key|authorization)[a-z0-9_-]*`;
const SENSITIVE_LOG_KEY_PATTERN = new RegExp(`^${SENSITIVE_LOG_KEY}$`, "i");
const SENSITIVE_VALUE_LINE_PATTERN = new RegExp(
  `(["']?\\b${SENSITIVE_LOG_KEY}\\b["']?\\s*[:=]\\s*)(.*)$`,
  "i"
);
const SENSITIVE_CLI_LINE_PATTERN = new RegExp(
  `((?:^|\\s)--${SENSITIVE_LOG_KEY}(?:=|\\s+))(.*)$`,
  "i"
);
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
const URL_USERINFO_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]*:[^/\s?#@]+@/gi;

export async function collectLogMetrics(envName, timeoutMs, artifactDir, options = {}) {
  const result = await runCommand(ocmLogs(envName, { tail: 200 }), {
    timeoutMs,
    env: options.commandEnv,
    redactValues: options.redactValues
  });
  const rawText = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const stdout = redactLogText(result.stdout);
  const stderr = redactLogText(result.stderr);
  const text = `${stdout}\n${stderr}`;
  const noLogsAvailable = isOptionalNoLogsResult(result);
  const timestamps = collectTimestamps(text);
  const stdoutSnippet = boundedLogSnippet(stdout, 4000);
  const stderrSnippet = boundedLogSnippet(stderr, 4000);
  const artifacts = [];
  if (artifactDir) {
    await mkdir(join(artifactDir, "collectors"), { recursive: true });
    const logPath = join(artifactDir, "collectors", "gateway-tail.log");
    await writeFile(logPath, text, "utf8");
    artifacts.push(logPath);
  }
  return {
    schemaVersion: LOG_METRICS_SCHEMA,
    commandStatus: noLogsAvailable ? 0 : result.status,
    originalCommandStatus: noLogsAvailable ? result.status : null,
    optional: noLogsAvailable,
    note: noLogsAvailable ? "optional log collection found no env logs" : null,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    firstTimestamp: timestamps.first,
    lastTimestamp: timestamps.last,
    observedWindowMs: timestamps.windowMs,
    missingDependencyErrors: countPattern(rawText, /cannot find (module|package)|missing dependenc|missing runtime dep/i),
    pluginLoadFailures: countPattern(rawText, /\[plugins\].*failed to load|plugin.*failed to load|\[plugins\].*plugin service failed|plugin service failed/i),
    runtimeDependencyMentions: countPattern(rawText, /runtime dep|runtime dependency|runtime-deps/i),
    metadataScanMentions: countPattern(rawText, /collectBundledPluginMetadata|bundled plugin metadata|manifest read|readdirSync/i),
    configNormalizationMentions: countPattern(rawText, /config normal/i),
    gatewayRestartMentions: countPattern(rawText, /gateway.*restart|restart.*gateway|service restart|restarting/i),
    listeningMentions: countPattern(rawText, /listening|server started|gateway ready|ready on|websocket/i),
    providerLoadMentions: countPattern(rawText, /provider.*load|load.*provider|provider registry|auth provider/i),
    modelCatalogMentions: countPattern(rawText, /model catalog|models list|loading models|available models/i),
    providerTimeoutMentions: countProviderTimeoutMentions(rawText),
    eventLoopDelayMentions: countPattern(rawText, /event loop|event-loop|blocked loop|loop delay/i),
    v8DiagnosticMentions: countPattern(rawText, /v8|diagnostic report|heapsnapshot|heap snapshot/i),
    errorMentions: countPattern(rawText, /\berror\b|exception|unhandled/i),
    runtimeDeps: summarizeRuntimeDepsLogs(text),
    embeddedRuns: summarizeEmbeddedRunTraces(text),
    livenessWarnings: summarizeLivenessWarnings(text),
    structuredEvents: extractStructuredDiagnosticEvents(text),
    artifacts,
    snippetBudget: {
      schemaVersion: "kova.logSnippetBudget.v1",
      stdout: stdoutSnippet.budget,
      stderr: stderrSnippet.budget,
      truncated: stdoutSnippet.budget.truncated || stderrSnippet.budget.truncated,
      omittedBytes: stdoutSnippet.budget.omittedBytes + stderrSnippet.budget.omittedBytes
    },
    stdoutSnippet: stdoutSnippet.text,
    stderrSnippet: stderrSnippet.text
  };
}

export function redactLogText(value) {
  const text = String(value ?? "").replace(PEM_PRIVATE_KEY_PATTERN, "[REDACTED]");
  return redactSensitiveContinuations(text)
    .replace(URL_USERINFO_PATTERN, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /^((?:.*\s)?(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*:\s*).+$/gim,
      "$1[REDACTED]"
    );
}

function redactSensitiveContinuations(value) {
  const lines = String(value ?? "").split(/\r?\n/);
  let blockIndent = null;
  let quotedContinuation = null;
  let redactNextValue = false;

  for (const [index, line] of lines.entries()) {
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (quotedContinuation !== null) {
      const closingIndex = findUnescapedQuote(line, quotedContinuation);
      if (line.trim() !== "") {
        const suffix = closingIndex === -1 ? "" : line.slice(closingIndex + 1);
        lines[index] = `${line.slice(0, indent)}[REDACTED]${suffix}`;
      }
      if (closingIndex !== -1) {
        quotedContinuation = null;
      }
      continue;
    }
    if (redactNextValue) {
      if (line.trim() === "") {
        continue;
      }
      redactNextValue = /\\\s*$/.test(line);
      lines[index] = `${line.slice(0, indent)}[REDACTED]`;
      continue;
    }
    if (blockIndent !== null) {
      if (line.trim() === "" || indent > blockIndent) {
        if (line.trim() !== "") {
          lines[index] = `${line.slice(0, indent)}[REDACTED]`;
        }
        continue;
      }
      blockIndent = null;
    }

    const structuredLine = redactStructuredJsonLine(line);
    if (structuredLine !== null) {
      lines[index] = structuredLine;
      continue;
    }

    const pattern = SENSITIVE_VALUE_LINE_PATTERN.test(line)
      ? SENSITIVE_VALUE_LINE_PATTERN
      : SENSITIVE_CLI_LINE_PATTERN.test(line)
        ? SENSITIVE_CLI_LINE_PATTERN
        : null;
    if (!pattern) {
      continue;
    }
    const marker = line.match(pattern)?.[2].trim() ?? "";
    lines[index] = line.replace(pattern, "$1[REDACTED]");
    quotedContinuation = unclosedStartingQuote(marker);
    if (quotedContinuation !== null) {
      continue;
    }
    if (marker.endsWith("\\")) {
      redactNextValue = true;
    } else {
      // Indented following lines can be YAML folding or wrapped command output.
      // Treat them as part of the sensitive value until indentation returns.
      blockIndent = indent;
    }
  }

  return lines.join("\n");
}

function redactStructuredJsonLine(line) {
  const jsonStart = line.indexOf("{");
  if (jsonStart === -1) {
    return null;
  }
  try {
    const parsed = JSON.parse(line.slice(jsonStart));
    const redacted = redactStructuredJsonValue(parsed);
    return redacted.changed
      ? `${line.slice(0, jsonStart)}${JSON.stringify(redacted.value)}`
      : null;
  } catch {
    return null;
  }
}

function redactStructuredJsonValue(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const redacted = redactStructuredJsonValue(item);
      changed ||= redacted.changed;
      return redacted.value;
    });
    return { value: items, changed };
  }
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }

  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    if (SENSITIVE_LOG_KEY_PATTERN.test(key)) {
      changed = true;
      return [key, "[REDACTED]"];
    }
    const redacted = redactStructuredJsonValue(item);
    changed ||= redacted.changed;
    return [key, redacted.value];
  });
  return { value: Object.fromEntries(entries), changed };
}

function unclosedStartingQuote(value) {
  const quote = value[0];
  if (!["\"", "'", "`"].includes(quote)) {
    return null;
  }
  return findUnescapedQuote(value, quote, 1) === -1 ? quote : null;
}

function findUnescapedQuote(value, quote, startIndex = 0) {
  let escaped = false;
  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote && !escaped) {
      return index;
    }
    if (character === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return -1;
}

export function boundedLogSnippet(value, maxChars) {
  const text = String(value ?? "");
  const truncated = text.length > maxChars;
  const retained = truncated ? text.slice(-maxChars) : text;
  return {
    text: truncated ? `[truncated ${text.length - maxChars} chars]\n${retained}` : retained,
    budget: {
      originalBytes: Buffer.byteLength(text),
      retainedBytes: Buffer.byteLength(retained),
      omittedBytes: truncated ? Buffer.byteLength(text.slice(0, -maxChars)) : 0,
      truncated,
      limitChars: maxChars
    }
  };
}

export function summarizeEmbeddedRunTraces(text) {
  const events = parseEmbeddedRunTraceEvents(text);
  const stageTotals = {};
  let totalMaxMs = null;

  for (const event of events) {
    totalMaxMs = maxNumber(totalMaxMs, event.totalMs);
    for (const stage of event.stages) {
      const current = stageTotals[stage.name] ?? {
        name: stage.name,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: null,
        maxOffsetMs: null,
        traceKinds: []
      };
      current.count += 1;
      current.totalDurationMs = round(current.totalDurationMs + stage.durationMs);
      current.maxDurationMs = maxNumber(current.maxDurationMs, stage.durationMs);
      current.maxOffsetMs = maxNumber(current.maxOffsetMs, stage.offsetMs);
      current.traceKinds = [...new Set([...current.traceKinds, event.traceKind])].sort();
      stageTotals[stage.name] = current;
    }
  }

  const topStages = Object.values(stageTotals)
    .toSorted((left, right) => (right.totalDurationMs - left.totalDurationMs) || left.name.localeCompare(right.name))
    .slice(0, 12);

  return {
    schemaVersion: "kova.embeddedRunTraceSummary.v1",
    available: events.length > 0,
    eventCount: events.length,
    startupCount: events.filter((event) => event.traceKind === "startup").length,
    prepCount: events.filter((event) => event.traceKind === "prep").length,
    totalMaxMs,
    stageTotals,
    topStages,
    events: events.slice(-20)
  };
}

export function parseEmbeddedRunTraceEvents(text) {
  const events = [];
  const tracePattern = /\[agent\/embedded\]\s+\[trace:embedded-run\]\s+([a-z0-9_-]+)\s+stages:\s+runId=([^\s]+)\s+sessionId=([^\s]+)\s+phase=([^\s]+)\s+totalMs=(\d+(?:\.\d+)?)\s+stages=(.*)$/i;
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    const match = line.match(tracePattern);
    if (!match) {
      continue;
    }
    const stages = [];
    const stageText = match[6] ?? "";
    const stagePattern = /([^:,]+):(\d+(?:\.\d+)?)ms@(\d+(?:\.\d+)?)ms/g;
    for (const stageMatch of stageText.matchAll(stagePattern)) {
      stages.push({
        name: stageMatch[1],
        durationMs: Number(stageMatch[2]),
        offsetMs: Number(stageMatch[3])
      });
    }
    events.push({
      kind: "embedded-run-trace",
      line: index + 1,
      traceKind: match[1],
      runId: match[2],
      sessionId: match[3],
      phase: match[4],
      totalMs: Number(match[5]),
      stages,
      text: compactLine(line)
    });
  }
  return events;
}

export function summarizeLivenessWarnings(text) {
  const events = parseLivenessWarningEvents(text);
  return {
    schemaVersion: "kova.livenessWarningSummary.v1",
    available: events.length > 0,
    count: events.length,
    maxEventLoopDelayP99Ms: numericMax(events, "eventLoopDelayP99Ms"),
    maxEventLoopDelayMaxMs: numericMax(events, "eventLoopDelayMaxMs"),
    maxEventLoopUtilization: numericMax(events, "eventLoopUtilization"),
    maxCpuCoreRatio: numericMax(events, "cpuCoreRatio"),
    events: events.slice(-20)
  };
}

export function parseLivenessWarningEvents(text) {
  const events = [];
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    if (!/\[diagnostic\]\s+liveness warning:/i.test(line)) {
      continue;
    }
    events.push({
      kind: "liveness-warning",
      line: index + 1,
      reasons: parseReasonList(extractValue(line, "reasons")),
      intervalMs: numberFromValue(extractValue(line, "interval")),
      eventLoopDelayP99Ms: numberFromValue(extractValue(line, "eventLoopDelayP99Ms")),
      eventLoopDelayMaxMs: numberFromValue(extractValue(line, "eventLoopDelayMaxMs")),
      eventLoopUtilization: numberFromValue(extractValue(line, "eventLoopUtilization")),
      cpuCoreRatio: numberFromValue(extractValue(line, "cpuCoreRatio")),
      active: numberFromValue(extractValue(line, "active")),
      waiting: numberFromValue(extractValue(line, "waiting")),
      queued: numberFromValue(extractValue(line, "queued")),
      text: compactLine(line)
    });
  }
  return events;
}

export function summarizeRuntimeDepsLogs(text) {
  const events = parseRuntimeDepsLogEvents(text);
  const installEvents = events.filter((event) => event.kind === "install");
  const stageEvents = events.filter((event) => event.kind === "stage");
  const postbuildEvents = events.filter((event) => event.kind === "postbuild");

  return {
    schemaVersion: "kova.runtimeDepsLogSummary.v1",
    eventCount: events.length,
    stageCount: stageEvents.length,
    installCount: installEvents.length,
    installMaxMs: maxDuration(installEvents),
    postbuildCount: postbuildEvents.length,
    postbuildMaxMs: maxDuration(postbuildEvents),
    pluginIds: [...new Set(events.map((event) => event.pluginId).filter(Boolean))].sort(),
    events: events.slice(0, 50)
  };
}

export function parseRuntimeDepsLogEvents(text) {
  const events = [];
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    const stage = line.match(/\[plugins\]\s+([a-z0-9._-]+)\s+staging bundled runtime deps\s+\((\d+)\s+specs?\)/i);
    if (stage) {
      events.push({
        kind: "stage",
        line: index + 1,
        pluginId: stage[1],
        dependencyCount: Number(stage[2]),
        durationMs: null,
        text: compactLine(line)
      });
      continue;
    }

    const install = line.match(/\[plugins\]\s+([a-z0-9._-]+)\s+installed bundled runtime deps in\s+(\d+(?:\.\d+)?)ms/i);
    if (install) {
      events.push({
        kind: "install",
        line: index + 1,
        pluginId: install[1],
        dependencyCount: null,
        durationMs: Number(install[2]),
        text: compactLine(line)
      });
      continue;
    }

    const postbuild = line.match(/runtime-postbuild:\s+bundled plugin runtime deps completed in\s+(\d+(?:\.\d+)?)ms/i);
    if (postbuild) {
      events.push({
        kind: "postbuild",
        line: index + 1,
        pluginId: "postbuild",
        dependencyCount: null,
        durationMs: Number(postbuild[1]),
        text: compactLine(line)
      });
    }
  }
  return events;
}

export function collectTimestamps(text) {
  const values = [];
  const patterns = [
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/g,
    /\b(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const time = Date.parse(match[1].replace(" ", "T"));
      if (!Number.isNaN(time)) {
        values.push(time);
      }
    }
  }

  values.sort((a, b) => a - b);
  const first = values.at(0) ?? null;
  const last = values.at(-1) ?? null;
  return {
    first: first === null ? null : new Date(first).toISOString(),
    last: last === null ? null : new Date(last).toISOString(),
    windowMs: first !== null && last !== null ? last - first : null
  };
}

export function extractStructuredDiagnosticEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const candidate = line.slice(line.indexOf("{"));
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && (
        parsed.openclawDiagnostic === true ||
        parsed.diagnosticType ||
        parsed.category ||
        parsed.startupPhase ||
        parsed.eventLoopDelayMs !== undefined ||
        parsed.runtimeDepsStagingMs !== undefined
      )) {
        events.push(parsed);
      }
    } catch {
      // Non-JSON log lines are expected; structured diagnostics are optional.
    }
  }
  return events;
}

export function isExpectedKovaMockProviderFailureLine(line) {
  return /mock provider channel workflow failure|kova_channel_workflow_error/i.test(String(line ?? ""));
}

export function countProviderTimeoutMentions(text) {
  return countPattern(String(text ?? ""), PROVIDER_TIMEOUT_SIGNAL_PATTERN, {
    ignoreLine: isExpectedKovaMockProviderFailureLine
  });
}

function countPattern(text, pattern, { ignoreLine = null } = {}) {
  let count = 0;
  for (const line of text.split("\n")) {
    if (pattern.test(line) && !(typeof ignoreLine === "function" && ignoreLine(line))) {
      count += 1;
    }
  }
  return count;
}

function maxDuration(events) {
  const values = events.map((event) => event.durationMs).filter((value) => typeof value === "number");
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

function maxNumber(left, right) {
  if (typeof left !== "number") {
    return typeof right === "number" ? right : null;
  }
  if (typeof right !== "number") {
    return left;
  }
  return Math.max(left, right);
}

function numericMax(items, field) {
  const values = items.map((item) => item[field]).filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function extractValue(line, key) {
  const match = String(line ?? "").match(new RegExp(`${key}=([^\\s]+)`));
  return match?.[1] ?? null;
}

function parseReasonList(value) {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberFromValue(value) {
  if (!value) {
    return null;
  }
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
}

function compactLine(line) {
  return String(line ?? "").trim().slice(0, 300);
}
