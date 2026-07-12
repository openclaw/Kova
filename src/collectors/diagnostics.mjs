import { mkdtemp, open as openFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { ocmEnvExecShell } from "../ocm/commands.mjs";
import { copyCollectorArtifacts } from "./artifacts.mjs";

export const OPENCLAW_DIAGNOSTICS_SCHEMA = "kova.openclawDiagnostics.v1";
export const DIAGNOSTIC_ARTIFACTS_SCHEMA = "kova.diagnosticArtifacts.v1";
export const HEAP_SNAPSHOT_SCHEMA = "kova.heapSnapshot.v1";
export const DIAGNOSTIC_REPORT_SCHEMA = "kova.diagnosticReport.v1";
const MIN_DIAGNOSTIC_TIMEOUT_MS = 2500;
const MAX_DIAGNOSTIC_REPORT_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_VALIDATION_CONCURRENCY = 2;

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

export async function triggerDiagnosticReport(envName, pid, timeoutMs, artifactDir, options = {}) {
  return (await triggerDiagnosticSession(envName, pid, timeoutMs, artifactDir, {
    diagnosticReport: true,
    commandEnv: options.commandEnv,
    signalAlreadySent: options.signalAlreadySent === true,
    signalSentAtEpochMs: options.signalSentAtEpochMs
  })).diagnosticReport;
}

export async function triggerDiagnosticSession(envName, pid, timeoutMs, artifactDir, options = {}) {
  const requestHeapSnapshot = options.heapSnapshot === true;
  const requestDiagnosticReport = options.diagnosticReport === true;
  if (!requestHeapSnapshot && !requestDiagnosticReport) {
    return {
      heapSnapshot: diagnosticTriggerResult(HEAP_SNAPSHOT_SCHEMA),
      diagnosticReport: diagnosticTriggerResult(DIAGNOSTIC_REPORT_SCHEMA)
    };
  }
  const normalizedPid = positiveIntegerPid(pid);
  const requestedAtEpochMs = Date.now();
  if (normalizedPid === null) {
    const error = `invalid diagnostic target pid: ${String(pid)}`;
    return {
      heapSnapshot: diagnosticTriggerResult(HEAP_SNAPSHOT_SCHEMA, { requested: requestHeapSnapshot, error }),
      diagnosticReport: diagnosticTriggerResult(DIAGNOSTIC_REPORT_SCHEMA, { requested: requestDiagnosticReport, error })
    };
  }
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs < MIN_DIAGNOSTIC_TIMEOUT_MS) {
    const error = `diagnostic timeout must be at least ${MIN_DIAGNOSTIC_TIMEOUT_MS}ms`;
    return {
      heapSnapshot: diagnosticTriggerResult(HEAP_SNAPSHOT_SCHEMA, { requested: requestHeapSnapshot, error }),
      diagnosticReport: diagnosticTriggerResult(DIAGNOSTIC_REPORT_SCHEMA, { requested: requestDiagnosticReport, error })
    };
  }
  const signalAlreadySent = options.signalAlreadySent === true;
  const signalSentAtEpochMs = Number(options.signalSentAtEpochMs);
  if (
    signalAlreadySent
    && (!Number.isFinite(signalSentAtEpochMs) || signalSentAtEpochMs <= 0 || signalSentAtEpochMs > requestedAtEpochMs)
  ) {
    const error = "signalSentAtEpochMs is required when signalAlreadySent is true";
    return {
      heapSnapshot: diagnosticTriggerResult(HEAP_SNAPSHOT_SCHEMA, { requested: requestHeapSnapshot, error }),
      diagnosticReport: diagnosticTriggerResult(DIAGNOSTIC_REPORT_SCHEMA, { requested: requestDiagnosticReport, error })
    };
  }
  const stabilizationReserveMs = Math.min(
    2000,
    Math.max(1500, Math.floor(normalizedTimeoutMs * 0.25))
  );
  const commandBudgetMs = normalizedTimeoutMs - stabilizationReserveMs;
  const commandExitReserveMs = Math.min(500, Math.max(250, Math.floor(commandBudgetMs * 0.1)));
  const pollAttempts = Math.max(1, Math.floor((commandBudgetMs - commandExitReserveMs) / 250));
  const sessionDeadlineEpochMs = requestedAtEpochMs + normalizedTimeoutMs;
  const signalMarker = signalAlreadySent
    ? await createTimestampMarker(signalSentAtEpochMs)
    : null;
  // The legacy report wrapper uses the caller's signal timestamp; new triggers
  // create their marker immediately before signaling.
  const markerCommand = signalMarker
    ? `marker=${quoteShell(signalMarker.path)}`
    : 'marker=$(mktemp); trap \'rm -f "$marker"\' EXIT; touch "$marker"';
  const signalCommand = signalAlreadySent ? ":" : `kill -USR2 ${normalizedPid}`;
  const searchRoots = [
    '"$OPENCLAW_HOME"',
    artifactDir ? quoteShell(join(artifactDir, "node-profiles")) : null
  ].filter(Boolean).join(" ");
  const readyConditions = [
    requestHeapSnapshot ? '[ "$heap_count" -gt 0 ]' : null,
    requestDiagnosticReport ? '[ "$report_count" -gt 0 ]' : null
  ].filter(Boolean).join(" && ") || "true";
  const artifactNamePredicates = [
    requestHeapSnapshot ? '-name "*.heapsnapshot"' : null,
    requestDiagnosticReport ? '-name "report.*.json"' : null,
    requestDiagnosticReport ? '-name "*diagnostic*.json"' : null
  ].filter(Boolean).join(" -o ");
  const artifactOutputCommand = `{ find ${searchRoots} -maxdepth 6 -type f \\( ${artifactNamePredicates} \\) -newer "$marker" -print 2>/dev/null || :; } | awk '/[.]heapsnapshot$/ { if (heap++ < 25) print; next } { if (report++ < 25) print }'`;
  const command = ocmEnvExecShell(
    envName,
    `set -eu; ${markerCommand}; ${signalCommand}; attempts=0; while :; do heap_count=$({ find ${searchRoots} -maxdepth 6 -type f -name "*.heapsnapshot" -newer "$marker" -print 2>/dev/null || :; } | wc -l | tr -d ' '); report_count=$({ find ${searchRoots} -maxdepth 6 -type f \\( -name "report.*.json" -o -name "*diagnostic*.json" \\) -newer "$marker" -print 2>/dev/null || :; } | wc -l | tr -d ' '); if ${readyConditions}; then break; fi; if [ "$attempts" -ge ${pollAttempts} ]; then break; fi; attempts=$((attempts + 1)); sleep 0.25; done; ${artifactOutputCommand}`
  );
  let result;
  try {
    result = await runCommand(command, {
      // OCM invocation, polling, and artifact retention share one caller-owned deadline.
      timeoutMs: commandBudgetMs,
      maxOutputChars: 100000,
      env: options.commandEnv
    });
  } finally {
    await signalMarker?.cleanup();
  }
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  if (result.status === 0) {
    files.push(...await collectLocalDiagnosticReports(
      artifactDir,
      signalAlreadySent ? signalSentAtEpochMs : requestedAtEpochMs
    ));
  }
  const uniqueFiles = [...new Set(files)];
  const heapFiles = uniqueFiles.filter((file) => /\.heapsnapshot$/i.test(file));
  const reportFiles = uniqueFiles.filter((file) => /report\..*\.json$|diagnostic.*\.json$/i.test(file));
  const triggerError = result.status === 0
    ? null
    : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "diagnostic trigger unavailable";
  const retentionDeadlineEpochMs = sessionDeadlineEpochMs;
  const heapCopied = await retainTriggeredArtifacts({
    requested: requestHeapSnapshot,
    artifactDir,
    files: heapFiles,
    destination: "heap",
    deadlineEpochMs: retentionDeadlineEpochMs
  });
  const reportCopied = await retainTriggeredArtifacts({
    requested: requestDiagnosticReport,
    artifactDir,
    files: reportFiles,
    destination: "diagnostic-reports",
    deadlineEpochMs: retentionDeadlineEpochMs
  });
  const heapError = triggerError ?? heapCopied.error ?? (
    requestHeapSnapshot && heapFiles.length === 0
      ? "heap snapshot was not emitted before the diagnostic trigger timeout"
      : null
  );
  const reportError = triggerError ?? reportCopied.error ?? (
    requestDiagnosticReport && reportFiles.length === 0
      ? "diagnostic report was not emitted before the diagnostic trigger timeout"
      : null
  );

  return {
    heapSnapshot: diagnosticTriggerResult(HEAP_SNAPSHOT_SCHEMA, {
      result,
      requested: requestHeapSnapshot,
      files: heapFiles,
      copied: heapCopied,
      error: heapError
    }),
    diagnosticReport: diagnosticTriggerResult(DIAGNOSTIC_REPORT_SCHEMA, {
      result,
      requested: requestDiagnosticReport,
      files: reportFiles,
      copied: reportCopied,
      error: reportError
    })
  };
}

async function retainTriggeredArtifacts({ requested, artifactDir, files, destination, deadlineEpochMs }) {
  if (!requested || !artifactDir || files.length === 0) {
    return { artifacts: [], artifactBytes: 0, error: null };
  }
  const destinationDir = join(artifactDir, destination);
  const outcomes = await mapWithConcurrency(
    [...new Set(files)],
    DIAGNOSTIC_VALIDATION_CONCURRENCY,
    async (file) => {
      try {
        const remainingMs = Math.max(0, deadlineEpochMs - Date.now());
        await waitForStableFile(file, remainingMs, {
          jsonValidation: destination === "heap" ? "envelope" : "full",
          maxBytes: destination === "heap" ? null : MAX_DIAGNOSTIC_REPORT_BYTES
        });
        const copied = await copyCollectorArtifacts([file], destinationDir);
        return copied.artifacts.length > 0
          ? { ...copied, error: null }
          : { ...copied, error: `diagnostic artifact disappeared before copy: ${file}` };
      } catch (error) {
        return {
          artifacts: [],
          artifactBytes: 0,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  const artifacts = [...new Set(outcomes.flatMap((outcome) => outcome.artifacts))];
  const artifactBytes = outcomes.reduce((total, outcome) => total + outcome.artifactBytes, 0);
  const errors = outcomes.map((outcome) => outcome.error).filter(Boolean);
  return {
    artifacts,
    artifactBytes,
    error: errors.length > 0 ? errors.slice(0, 3).join("; ") : null
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

async function createTimestampMarker(epochMs) {
  const directory = await mkdtemp(join(tmpdir(), "kova-diagnostic-marker-"));
  const path = join(directory, "signal");
  const handle = await openFile(path, "wx");
  await handle.close();
  const timestamp = new Date(epochMs);
  await utimes(path, timestamp, timestamp);
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

function diagnosticTriggerResult(schemaVersion, options = {}) {
  const result = options.result ?? {};
  const copied = options.copied ?? { artifacts: [], artifactBytes: 0 };
  const files = options.files ?? [];
  const requested = options.requested === true;
  return {
    schemaVersion,
    commandStatus: requested ? (result.status ?? (options.error ? 1 : 0)) : 0,
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

async function waitForStableFile(path, timeoutMs, options = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (true) {
    const now = Date.now();
    const observedAt = Math.min(now, deadline);
    const state = await fileState(path);
    if (typeof options.maxBytes === "number" && state.size > options.maxBytes) {
      throw new Error(`diagnostic report exceeds ${options.maxBytes} byte validation limit: ${path}`);
    }
    if (state.size > 0 && observedAt - state.mtimeMs >= 1000) {
      const valid = options.jsonValidation === "full"
        ? await isValidJsonFile(path, options.maxBytes)
        : (options.jsonValidation === "envelope" ? await hasJsonEnvelope(path) : true);
      if (valid) {
        return state.size;
      }
    }
    if (now >= deadline) {
      break;
    }
    await sleep(Math.min(250, deadline - now));
  }

  throw new Error(`diagnostic artifact did not stabilize before timeout: ${path}`);
}

async function isValidJsonFile(path, maxBytes) {
  let file;
  try {
    file = await openFile(path, "r");
    const { size } = await file.stat();
    if (size <= 0 || size > maxBytes) {
      return false;
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) {
        return false;
      }
      offset += bytesRead;
    }
    JSON.parse(bytes.toString("utf8"));
    return true;
  } catch {
    return false;
  } finally {
    if (file) {
      await file.close().catch(() => {});
    }
  }
}

async function hasJsonEnvelope(path) {
  let file;
  try {
    file = await openFile(path, "r");
    const { size } = await file.stat();
    if (size <= 0) {
      return false;
    }
    const chunkSize = Math.min(size, 4096);
    const head = Buffer.alloc(chunkSize);
    const tail = Buffer.alloc(chunkSize);
    await file.read(head, 0, chunkSize, 0);
    await file.read(tail, 0, chunkSize, Math.max(0, size - chunkSize));
    return head.toString("utf8").trimStart().startsWith("{")
      && tail.toString("utf8").trimEnd().endsWith("}");
  } catch {
    return false;
  } finally {
    if (file) {
      await file.close().catch(() => {});
    }
  }
}

async function fileState(path) {
  try {
    const file = await stat(path);
    return { size: file.size, mtimeMs: file.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: Date.now() };
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

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  ));
  return results;
}
