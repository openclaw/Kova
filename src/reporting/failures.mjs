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
      if (result.status !== 0 || result.timedOut) {
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
  return summarizeCommandFailure(result, {
    maxLength: 260,
    filterOcmHelp: true,
    exitedText: (status) => `command exited with status ${status}`,
    timedOutText: () => "command timed out"
  });
}

export function summarizeFailedCommand(result) {
  return summarizeCommandFailure(result, {
    maxLength: 220,
    filterOcmHelp: false,
    exitedText: (status, command) => `command exited ${status}: ${command}`,
    timedOutText: (command) => `command timed out: ${command}`
  });
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
