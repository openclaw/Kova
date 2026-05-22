import { spawnSync } from "node:child_process";

const DIAGNOSTIC_SCHEMA = "kova.channelRuntimeDiagnostics.v1";

export async function collectRuntimeDiagnostics({ envName, sinceEpochMs, timeoutMs = 10000 }) {
  const result = spawnSync("ocm", ["logs", envName, "--tail", "300", "--raw"], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const events = parseRuntimeDiagnosticEvents(text, { sinceEpochMs });
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA,
    available: result.status === 0,
    commandStatus: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    events,
    blockingCount: events.filter((event) => event.severity === "fail").length
  };
}

export function parseRuntimeDiagnosticEvents(text, { sinceEpochMs = null } = {}) {
  const events = [];
  for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
    const timestampMs = timestampFromLogLine(line);
    if (typeof sinceEpochMs === "number" && timestampMs !== null && timestampMs + 500 < sinceEpochMs) {
      continue;
    }
    const event = diagnosticEventFromLine(line, index + 1, timestampMs);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

export function runtimeDiagnosticFailureReason(caseId, diagnostics) {
  const event = firstBlockingDiagnostic(diagnostics);
  if (!event) {
    return `${caseId} had no blocking OpenClaw runtime diagnostics`;
  }
  if (event.kind === "security-blocked-url-fetch") {
    return `${caseId} hit OpenClaw runtime diagnostic: blocked URL fetch${event.targetOrigin ? ` to ${event.targetOrigin}` : ""}${event.detail ? ` (${event.detail})` : ""}`;
  }
  return `${caseId} hit OpenClaw runtime diagnostic: ${event.summary}`;
}

export function hasBlockingRuntimeDiagnostics(diagnostics) {
  return firstBlockingDiagnostic(diagnostics) !== null;
}

function firstBlockingDiagnostic(diagnostics) {
  const events = Array.isArray(diagnostics?.events) ? diagnostics.events : [];
  return events.find((event) => event?.severity === "fail") ?? null;
}

function diagnosticEventFromLine(line, lineNumber, timestampMs) {
  const security = String(line ?? "").match(/\[security\]\s+blocked URL fetch\s+\(([^)]+)\)\s+targetOrigin=([^\s]+)\s+reason=(.*)$/i);
  if (security) {
    return {
      kind: "security-blocked-url-fetch",
      severity: "fail",
      line: lineNumber,
      timestampMs,
      operation: security[1] ?? null,
      targetOrigin: security[2] ?? null,
      detail: compact(security[3]),
      summary: compact(line),
      ownerArea: "OpenClaw provider/tool network policy"
    };
  }

  if (/Blocked hostname or private\/internal\/special-use IP address/i.test(line)) {
    return {
      kind: "security-blocked-url-fetch",
      severity: "fail",
      line: lineNumber,
      timestampMs,
      operation: null,
      targetOrigin: null,
      detail: "Blocked hostname or private/internal/special-use IP address",
      summary: compact(line),
      ownerArea: "OpenClaw provider/tool network policy"
    };
  }

  return null;
}

function timestampFromLogLine(line) {
  const match = String(line ?? "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/);
  if (!match) {
    return null;
  }
  const value = Date.parse(match[1]);
  return Number.isNaN(value) ? null : value;
}

function compact(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
}
