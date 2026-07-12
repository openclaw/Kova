import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../commands.mjs";
import { ocmEnvExecShell } from "../ocm/commands.mjs";
import { copyCollectorArtifacts } from "./artifacts.mjs";

export const OPENCLAW_DIAGNOSTICS_SCHEMA = "kova.openclawDiagnostics.v1";
export const DIAGNOSTIC_ARTIFACTS_SCHEMA = "kova.diagnosticArtifacts.v1";
export const HEAP_SNAPSHOT_SCHEMA = "kova.heapSnapshot.v1";
export const DIAGNOSTIC_REPORT_SCHEMA = "kova.diagnosticReport.v1";

export function collectOpenClawDiagnostics(logs) {
  const events = logs?.structuredEvents ?? [];
  const startupEvents = events.filter((event) => event.category === "startup" || event.phase || event.startupPhase);
  const pluginEvents = events.filter((event) => event.category === "plugins" || event.plugin || event.pluginId);
  const configEvents = events.filter((event) => event.category === "config" || event.config || event.normalization);
  const runtimeDepEvents = events.filter((event) => event.category === "runtime-deps" || event.runtimeDeps || event.runtimeDependency);
  const providerEvents = events.filter((event) => event.category === "providers" || event.provider || event.modelProvider);
  const eventLoopEvents = events.filter((event) => event.eventLoopDelayMs !== undefined || event.eventLoop !== undefined);

  return {
    schemaVersion: OPENCLAW_DIAGNOSTICS_SCHEMA,
    available: events.length > 0,
    source: events.length > 0 ? "structured-log-events" : "unavailable",
    eventCount: events.length,
    startupTimeline: summarizeTimedEvents(startupEvents),
    pluginMetadataScanCount: numericSum(pluginEvents, ["metadataScanCount", "scanCount"]),
    configNormalizationCount: numericSum(configEvents, ["normalizationCount", "configNormalizationCount"]),
    runtimeDepsStagingMs: numericMax(runtimeDepEvents, ["durationMs", "runtimeDepsStagingMs", "stagingMs"]),
    eventLoopDelayMs: numericMax(eventLoopEvents, ["eventLoopDelayMs", "delayMs", "maxMs"]),
    providerModelTimingMs: numericMax(providerEvents, ["durationMs", "providerModelTimingMs", "modelCatalogMs"]),
    events: events.slice(0, 50)
  };
}

export async function collectDiagnosticMetrics(envName, timeoutMs, artifactDir, commandEnv) {
  const command = ocmEnvExecShell(
    envName,
    'find "$OPENCLAW_HOME" -maxdepth 6 -type f \\( -name "report.*.json" -o -name "*.heapsnapshot" -o -name "*heap*.json" -o -name "*diagnostic*.json" \\) -print 2>/dev/null | head -100'
  );
  const result = await runCommand(command, {
    timeoutMs,
    maxOutputChars: 100000,
    env: commandEnv
  });
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  files.push(...await collectLocalDiagnosticReports(artifactDir));
  const uniqueFiles = [...new Set(files)];
  const copied = artifactDir
    ? await copyCollectorArtifacts(uniqueFiles, join(artifactDir, "diagnostics"), { limit: 25 })
    : { artifacts: [], artifactBytes: 0 };

  return {
    schemaVersion: DIAGNOSTIC_ARTIFACTS_SCHEMA,
    commandStatus: result.status,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    fileCount: uniqueFiles.length,
    v8ReportCount: uniqueFiles.filter((file) => /report\..*\.json$|diagnostic.*\.json$/i.test(file)).length,
    heapSnapshotCount: uniqueFiles.filter((file) => /\.heapsnapshot$|heap.*\.json$/i.test(file)).length,
    artifactBytes: copied.artifactBytes,
    files: uniqueFiles.slice(0, 25),
    artifacts: copied.artifacts,
    error: result.status === 0 ? null : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "diagnostic artifact scan unavailable"
  };
}

export async function triggerHeapSnapshot(envName, pid, timeoutMs, artifactDir, commandEnv) {
  return (await triggerDiagnosticSession(envName, pid, timeoutMs, artifactDir, {
    heapSnapshot: true,
    commandEnv
  })).heapSnapshot;
}

export async function triggerDiagnosticReport(envName, pid, timeoutMs, artifactDir, commandEnv) {
  return (await triggerDiagnosticSession(envName, pid, timeoutMs, artifactDir, {
    diagnosticReport: true,
    commandEnv
  })).diagnosticReport;
}

export async function triggerDiagnosticSession(envName, pid, timeoutMs, artifactDir, options = {}) {
  const normalizedPid = positiveIntegerPid(pid);
  const requestedAtEpochMs = Date.now();
  if (normalizedPid === null) {
    const error = `invalid diagnostic target pid: ${String(pid)}`;
    return {
      heapSnapshot: diagnosticTriggerResult(HEAP_SNAPSHOT_SCHEMA, { requested: options.heapSnapshot === true, error }),
      diagnosticReport: diagnosticTriggerResult(DIAGNOSTIC_REPORT_SCHEMA, { requested: options.diagnosticReport === true, error })
    };
  }
  const command = ocmEnvExecShell(
    envName,
    `set -eu; marker=$(mktemp); trap 'rm -f "$marker"' EXIT; touch "$marker"; sleep 1; kill -USR2 ${normalizedPid}; sleep 1; find "$OPENCLAW_HOME" -maxdepth 6 -type f \\( -name "*.heapsnapshot" -o -name "report.*.json" -o -name "*diagnostic*.json" \\) -newer "$marker" -print 2>/dev/null | head -50`
  );
  const result = await runCommand(command, {
    timeoutMs,
    maxOutputChars: 100000,
    env: options.commandEnv
  });
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  if (result.status === 0) {
    files.push(...await collectLocalDiagnosticReports(artifactDir, requestedAtEpochMs));
  }
  const uniqueFiles = [...new Set(files)];
  const heapFiles = uniqueFiles.filter((file) => /\.heapsnapshot$/i.test(file));
  const reportFiles = uniqueFiles.filter((file) => /report\..*\.json$|diagnostic.*\.json$/i.test(file));
  const triggerError = result.status === 0
    ? null
    : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "diagnostic trigger unavailable";
  const heapCopied = options.heapSnapshot === true && artifactDir && result.status === 0
    ? await copyCollectorArtifacts(heapFiles, join(artifactDir, "heap"), {
      beforeCopy: (file) => waitForStableFile(file, Math.min(timeoutMs, 5000))
    })
    : { artifacts: [], artifactBytes: 0 };
  const reportCopied = options.diagnosticReport === true && artifactDir && result.status === 0
    ? await copyCollectorArtifacts(reportFiles, join(artifactDir, "diagnostic-reports"))
    : { artifacts: [], artifactBytes: 0 };

  return {
    heapSnapshot: diagnosticTriggerResult(HEAP_SNAPSHOT_SCHEMA, {
      result,
      requested: options.heapSnapshot === true,
      files: heapFiles,
      copied: heapCopied,
      error: triggerError
    }),
    diagnosticReport: diagnosticTriggerResult(DIAGNOSTIC_REPORT_SCHEMA, {
      result,
      requested: options.diagnosticReport === true,
      files: reportFiles,
      copied: reportCopied,
      error: triggerError
    })
  };
}

async function collectLocalDiagnosticReports(artifactDir, modifiedAfterEpochMs = null) {
  const profileDir = artifactDir ? join(artifactDir, "node-profiles") : null;
  if (!profileDir) {
    return [];
  }

  try {
    const entries = await readdir(profileDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(profileDir, entry.name))
      .filter((path) => /report\..*\.json$|diagnostic.*\.json$/i.test(path));
    if (modifiedAfterEpochMs === null) {
      return candidates;
    }
    const fresh = [];
    for (const path of candidates) {
      try {
        if ((await stat(path)).mtimeMs >= modifiedAfterEpochMs) {
          fresh.push(path);
        }
      } catch {
        // A concurrently removed profile is not retained as trigger evidence.
      }
    }
    return fresh;
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function diagnosticTriggerResult(schemaVersion, options = {}) {
  const result = options.result ?? {};
  const copied = options.copied ?? { artifacts: [], artifactBytes: 0 };
  const files = options.files ?? [];
  const requested = options.requested === true;
  return {
    schemaVersion,
    commandStatus: requested ? (result.status ?? 1) : 0,
    durationMs: result.durationMs ?? 0,
    timedOut: result.timedOut ?? false,
    requested,
    fileCount: requested ? files.length : 0,
    artifactBytes: requested ? copied.artifactBytes : 0,
    files: requested ? files : [],
    artifacts: requested ? copied.artifacts : [],
    error: requested ? options.error ?? null : null
  };
}

function positiveIntegerPid(pid) {
  const value = Number(pid);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function waitForStableFile(path, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() <= deadline) {
    const size = await fileSize(path);
    if (size > 0 && size === lastSize) {
      stableCount += 1;
      if (stableCount >= 2) {
        return size;
      }
    } else {
      stableCount = 0;
      lastSize = size;
    }
    await sleep(250);
  }

  return lastSize;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function summarizeTimedEvents(events) {
  return events
    .map((event) => ({
      phase: event.phase ?? event.startupPhase ?? event.name ?? event.category ?? "unknown",
      durationMs: firstNumber(event, ["durationMs", "elapsedMs", "ms"]),
      timestamp: event.timestamp ?? event.time ?? null
    }))
    .slice(0, 50);
}

function numericSum(events, keys) {
  let total = 0;
  let found = false;
  for (const event of events) {
    const value = firstNumber(event, keys);
    if (typeof value === "number") {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

function numericMax(events, keys) {
  const values = events.map((event) => firstNumber(event, keys)).filter((value) => typeof value === "number");
  return values.length === 0 ? null : Math.max(...values);
}

function firstNumber(value, keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "number") {
      return value[key];
    }
  }
  return null;
}

function firstOutputLine(value) {
  return value.trim().split("\n").find(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
