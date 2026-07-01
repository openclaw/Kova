import { commandResultFailed } from "../measurement-contract.mjs";

const PRIORITY_PATTERNS = [
  /Cannot find module/i,
  /Error \[/i,
  /ECONNREFUSED/i,
  /timed out|timeout/i,
  /missing/i,
  /failed/i,
  /error/i
];

export function firstFailedCommand(record, options = {}) {
  for (const phase of record?.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (commandResultFailed(result)) {
        return result;
      }
    }
  }
  if (options.includeCleanup && record?.cleanup === "destroy-failed" && record.cleanupResult?.status !== 0) {
    return record.cleanupResult;
  }
  return null;
}

export function summarizeFailureReason(result) {
  const structured = summarizeStructuredFailure(result, 260);
  if (structured) {
    return structured;
  }
  return summarizeCommandFailure(result, {
    maxLength: 260,
    filterOcmHelp: true,
    exitedText: (status) => `command exited with status ${status}`,
    timedOutText: () => "command timed out"
  });
}

export function summarizeFailedCommand(result) {
  const structured = summarizeStructuredFailure(result, 220);
  if (structured) {
    return structured;
  }
  return summarizeCommandFailure(result, {
    maxLength: 220,
    filterOcmHelp: false,
    exitedText: (status, command) => `command exited ${status}: ${command}`,
    timedOutText: (command) => `command timed out: ${command}`
  });
}

function summarizeStructuredFailure(result, maxLength) {
  const interpretation = result?.interpretation ?? parseStructuredStdout(result?.stdout);
  if (!interpretation || interpretation.structured === false) {
    return null;
  }
  const domain = interpretation.failureDomain ? `${interpretation.failureDomain}: ` : "";
  const reason = interpretation.reason ?? null;
  if (!reason) {
    return null;
  }
  return truncate(`${domain}${reason}`, maxLength);
}

function parseStructuredStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) {
    return null;
  }
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return {
      structured: true,
      failureDomain: typeof payload.failureDomain === "string" ? payload.failureDomain : null,
      reason: typeof payload.error === "string" ? payload.error : null
    };
  } catch {
    return null;
  }
}

function summarizeCommandFailure(result, options) {
  if (!result) {
    return null;
  }
  const output = (result.stderr?.trim() || result.stdout?.trim() || "").trim();
  if (!output) {
    return result.timedOut
      ? options.timedOutText(result.command)
      : options.exitedText(result.status, result.command);
  }

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !options.filterOcmHelp || !/^Run "ocm help"/.test(line));
  const important = PRIORITY_PATTERNS
    .map((pattern) => lines.find((line) => pattern.test(line)))
    .find(Boolean);
  const line = important ?? lines[0] ?? output;
  return truncate(line, options.maxLength);
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
