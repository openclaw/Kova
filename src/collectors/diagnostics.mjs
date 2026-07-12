import { open as openFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { quoteShell, runCommand } from "../commands.mjs";
import { ocmEnvExecShell } from "../ocm/commands.mjs";
import { positiveProcessId } from "../process-safety.mjs";
import { copyCollectorArtifacts } from "./artifacts.mjs";

export const OPENCLAW_DIAGNOSTICS_SCHEMA = "kova.openclawDiagnostics.v1";
export const DIAGNOSTIC_ARTIFACTS_SCHEMA = "kova.diagnosticArtifacts.v1";
export const HEAP_SNAPSHOT_SCHEMA = "kova.heapSnapshot.v1";
export const DIAGNOSTIC_REPORT_SCHEMA = "kova.diagnosticReport.v1";
const MIN_DIAGNOSTIC_TIMEOUT_MS = 2500;
const DIAGNOSTIC_STABILITY_MS = 1000;
const DIAGNOSTIC_COMMAND_EXIT_RESERVE_MS = 1250;
const DIAGNOSTIC_RUNNER_EXIT_RESERVE_MS = 250;
const DIAGNOSTIC_POLL_INTERVAL_MS = 750;
const MAX_DIAGNOSTIC_REPORT_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_SEARCH_MAX_DEPTH = 6;

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
  const scanCommand = boundedFindCommand(
    ['"$OPENCLAW_HOME"'],
    '-name "report.*.json" -o -name "*.heapsnapshot" -o -name "*heap*.json" -o -name "*diagnostic*.json"'
  );
  const command = ocmEnvExecShell(
    envName,
    `${scanCommand} | head -100`
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
    commandEnv: options.commandEnv
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
  const requestedAtEpochMs = Date.now();
  let normalizedPid;
  try {
    normalizedPid = positiveProcessId(pid, "diagnostic target pid");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const error = `invalid diagnostic target pid: ${message}`;
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
  const commandBudgetMs = normalizedTimeoutMs - DIAGNOSTIC_RUNNER_EXIT_RESERVE_MS;
  const pollAttempts = Math.max(
    1,
    Math.floor(
      (normalizedTimeoutMs - DIAGNOSTIC_COMMAND_EXIT_RESERVE_MS)
      / DIAGNOSTIC_POLL_INTERVAL_MS
    )
  );
  const sessionDeadlineEpochMs = requestedAtEpochMs + normalizedTimeoutMs;
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
  const discoveredArtifacts = boundedFindCommand(searchRoots, artifactNamePredicates);
  const fingerprintCommand = `node -e ${quoteShell([
    'const fs=require("node:fs");',
    'for(const path of fs.readFileSync(0,"utf8").split("\\n").filter(Boolean)){',
    'try{',
    'const value=fs.statSync(path,{bigint:true});',
    'process.stdout.write(path+"\\t"+[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(":")+"\\n");',
    '}catch{}',
    '}'
  ].join(""))}`;
  const attributionCommand = `node -e ${quoteShell([
    'const fs=require("node:fs"),pathModule=require("node:path");',
    'const expectedPid=Number(process.argv[1]);',
    `const maxReportBytes=${MAX_DIAGNOSTIC_REPORT_BYTES};`,
    'for(const path of fs.readFileSync(0,"utf8").split("\\n").filter(Boolean)){',
    'try{',
    'const name=pathModule.basename(path);',
    'const heap=name.toLowerCase().endsWith(".heapsnapshot");',
    'const match=(heap?/^Heap\\.\\d{8}\\.\\d{6}\\.(\\d+)\\./i:/^report\\.\\d{8}\\.\\d{6}\\.(\\d+)\\./i).exec(name);',
    'const namePid=match?Number(match[1]):null;',
    'if(Number.isFinite(namePid)&&namePid!==expectedPid)continue;',
    'const nameAttributed=namePid===expectedPid;',
    'const stat=fs.statSync(path);',
    'if(stat.size<=0)continue;',
    'if(heap){',
    'if(!nameAttributed)continue;',
    'const fd=fs.openSync(path,"r");',
    'try{',
    'const size=Math.min(stat.size,4096),head=Buffer.alloc(size),tail=Buffer.alloc(size);',
    'fs.readSync(fd,head,0,size,0);',
    'fs.readSync(fd,tail,0,size,Math.max(0,stat.size-size));',
    'if(!head.toString("utf8").trimStart().startsWith("{")||!tail.toString("utf8").trimEnd().endsWith("}"))continue;',
    '}finally{fs.closeSync(fd);}',
    '}else{',
    'if(stat.size>maxReportBytes)continue;',
    'const report=JSON.parse(fs.readFileSync(path,"utf8"));',
    'const reportPid=Number(report?.header?.processId);',
    'if(Number.isFinite(reportPid)&&reportPid!==expectedPid)continue;',
    'if(!nameAttributed&&reportPid!==expectedPid)continue;',
    '}',
    'process.stdout.write((heap?"heap":"report")+"\\t"+path+"\\n");',
    '}catch{}',
    '}'
  ].join(""))} ${normalizedPid}`;
  const sessionStateCommand = [
    'baseline=$(mktemp)',
    'fresh=$(mktemp)',
    'attributed=$(mktemp)',
    'trap \'rm -f "$baseline" "$fresh" "$attributed"\' EXIT',
    `${discoveredArtifacts} | ${fingerprintCommand} | sort -u > "$baseline"`,
    `refresh_candidates() { ${discoveredArtifacts} | ${fingerprintCommand} | sort -u | grep -Fvx -f "$baseline" > "$fresh" || :; }`,
    `refresh_attributed() { cut -f1 "$fresh" | ${attributionCommand} > "$attributed"; }`
  ].join("; ");
  const signalCommand = `kill -USR2 ${normalizedPid}`;
  // Attributed paths get first claim on each cap. Invalid siblings remain as
  // validation evidence only when they cannot displace a successful capture.
  const artifactOutputCommand = `{ cut -f2 "$attributed"; cut -f1 "$fresh"; } | awk '!seen[$0]++ { if (/[.]heapsnapshot$/) { if (heap++ < 25) print; next } if (report++ < 25) print }'`;
  const command = ocmEnvExecShell(
    envName,
    `set -eu; ${sessionStateCommand}; ${signalCommand}; attempts=0; while :; do refresh_candidates; refresh_attributed; heap_count=$(awk -F '\\t' '$1 == "heap" { count++ } END { print count + 0 }' "$attributed"); report_count=$(awk -F '\\t' '$1 == "report" { count++ } END { print count + 0 }' "$attributed"); if ${readyConditions}; then break; fi; if [ "$attempts" -ge ${pollAttempts} ]; then break; fi; attempts=$((attempts + 1)); sleep ${DIAGNOSTIC_POLL_INTERVAL_MS / 1000}; done; ${artifactOutputCommand}`
  );
  const result = await runCommand(command, {
    // OCM invocation, polling, and artifact retention share one caller-owned deadline.
    timeoutMs: commandBudgetMs,
    maxOutputChars: 100000,
    env: options.commandEnv
  });
  const files = result.status === 0
    ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const uniqueFiles = [...new Set(files)];
  const heapFiles = uniqueFiles.filter((file) => /\.heapsnapshot$/i.test(file)).slice(0, 25);
  const reportFiles = uniqueFiles
    .filter((file) => /report\..*\.json$|diagnostic.*\.json$/i.test(file))
    .slice(0, 25);
  const triggerError = result.status === 0
    ? null
    : firstOutputLine(result.stderr) || firstOutputLine(result.stdout) || "diagnostic trigger unavailable";
  const retentionDeadlineEpochMs = sessionDeadlineEpochMs;
  const [heapCopied, reportCopied] = await Promise.all([
    retainTriggeredArtifacts({
      requested: requestHeapSnapshot,
      artifactDir,
      files: heapFiles,
      destination: "heap",
      deadlineEpochMs: retentionDeadlineEpochMs,
      expectedPid: normalizedPid
    }),
    retainTriggeredArtifacts({
      requested: requestDiagnosticReport,
      artifactDir,
      files: reportFiles,
      destination: "diagnostic-reports",
      deadlineEpochMs: retentionDeadlineEpochMs,
      expectedPid: normalizedPid
    })
  ]);
  const heapError = triggerError ?? heapCopied.error ?? (
    requestHeapSnapshot && heapCopied.files.length === 0
      ? "heap snapshot was not emitted before the diagnostic trigger timeout"
      : null
  );
  const reportError = triggerError ?? reportCopied.error ?? (
    requestDiagnosticReport && reportCopied.files.length === 0
      ? "diagnostic report was not emitted before the diagnostic trigger timeout"
      : null
  );

  return {
    heapSnapshot: diagnosticTriggerResult(HEAP_SNAPSHOT_SCHEMA, {
      result,
      requested: requestHeapSnapshot,
      files: heapCopied.files,
      copied: heapCopied,
      error: heapError
    }),
    diagnosticReport: diagnosticTriggerResult(DIAGNOSTIC_REPORT_SCHEMA, {
      result,
      requested: requestDiagnosticReport,
      files: reportCopied.files,
      copied: reportCopied,
      error: reportError
    })
  };
}

function boundedFindCommand(roots, namePredicates, extraPredicates = "") {
  const rootArguments = Array.isArray(roots) ? roots.join(" ") : roots;
  const depthPattern = Array.from(
    { length: DIAGNOSTIC_SEARCH_MAX_DEPTH + 1 },
    () => "*"
  ).join("/");
  const suffix = extraPredicates ? ` ${extraPredicates}` : "";
  // -maxdepth is not portable across the BSD find versions used by macOS.
  // Prune at depth seven so files through the six-level contract remain visible.
  return `{ for root in ${rootArguments}; do while [ "$root" != "/" ] && [ "\${root%/}" != "$root" ]; do root=\${root%/}; done; [ -d "$root" ] || continue; find "$root" \\( -path "$root/${depthPattern}" -prune \\) -o \\( -type f \\( ${namePredicates} \\)${suffix} -print \\) 2>/dev/null || :; done; }`;
}

async function retainTriggeredArtifacts({
  requested,
  artifactDir,
  files,
  destination,
  deadlineEpochMs,
  expectedPid
}) {
  if (!requested || files.length === 0) {
    return { files: [], artifacts: [], artifactBytes: 0, error: null };
  }
  const destinationDir = artifactDir ? join(artifactDir, destination) : null;
  // Candidate lists are capped at 25 per class. Poll them together so a
  // corrupt artifact cannot monopolize workers until the shared deadline.
  const outcomes = await Promise.all(
    [...new Set(files)].map(async (file) => {
      try {
        const remainingMs = Math.max(0, deadlineEpochMs - Date.now());
        await waitForStableFile(file, remainingMs, {
          jsonValidation: destination === "heap" ? "envelope" : "full",
          maxBytes: destination === "heap" ? null : MAX_DIAGNOSTIC_REPORT_BYTES
        });
        if (!await diagnosticArtifactMatchesPid(file, destination, expectedPid)) {
          throw new Error(`diagnostic artifact belongs to another process: ${file}`);
        }
        if (!destinationDir) {
          return { files: [file], artifacts: [], artifactBytes: 0, error: null };
        }
        const copied = await copyCollectorArtifacts([file], destinationDir, {
          deadlineEpochMs
        });
        return copied.artifacts.length > 0
          ? { ...copied, files: [file], error: null }
          : { ...copied, files: [], error: `diagnostic artifact disappeared before copy: ${file}` };
      } catch (error) {
        return {
          files: [],
          artifacts: [],
          artifactBytes: 0,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
  const retainedFiles = [...new Set(outcomes.flatMap((outcome) => outcome.files))];
  const artifacts = [...new Set(outcomes.flatMap((outcome) => outcome.artifacts))];
  const artifactBytes = outcomes.reduce((total, outcome) => total + outcome.artifactBytes, 0);
  const errors = outcomes.map((outcome) => outcome.error).filter(Boolean);
  return {
    files: retainedFiles,
    artifacts,
    artifactBytes,
    error: errors.length > 0 ? errors.slice(0, 3).join("; ") : null
  };
}

async function diagnosticArtifactMatchesPid(path, destination, expectedPid) {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const standardName = destination === "heap"
    ? /^Heap\.\d{8}\.\d{6}\.(\d+)\./i.exec(name)
    : /^report\.\d{8}\.\d{6}\.(\d+)\./i.exec(name);
  const namePid = standardName ? Number(standardName[1]) : null;
  if (Number.isFinite(namePid) && namePid !== expectedPid) {
    return false;
  }
  const nameAttributed = namePid === expectedPid;
  if (destination === "heap") {
    return nameAttributed;
  }
  try {
    const report = JSON.parse(await readFileBounded(path, MAX_DIAGNOSTIC_REPORT_BYTES));
    const reportPid = Number(report?.header?.processId);
    return (nameAttributed || reportPid === expectedPid)
      && (!Number.isFinite(reportPid) || reportPid === expectedPid);
  } catch {
    return false;
  }
}

async function readFileBounded(path, maxBytes) {
  let file;
  try {
    file = await openFile(path, "r");
    const { size } = await file.stat();
    if (size > maxBytes) {
      throw new Error(`diagnostic report exceeds ${maxBytes} byte validation limit: ${path}`);
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`diagnostic report changed while reading: ${path}`);
      }
      offset += bytesRead;
    }
    return bytes.toString("utf8");
  } finally {
    if (file) {
      await file.close().catch(() => {});
    }
  }
}

async function collectLocalDiagnosticReports(artifactDir) {
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
    return candidates;
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

async function waitForStableFile(path, timeoutMs, options = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (true) {
    const now = Date.now();
    const observedAt = Math.min(now, deadline);
    const state = await fileState(path);
    if (typeof options.maxBytes === "number" && state.size > options.maxBytes) {
      throw new Error(`diagnostic report exceeds ${options.maxBytes} byte validation limit: ${path}`);
    }
    if (state.size > 0 && observedAt - state.mtimeMs >= DIAGNOSTIC_STABILITY_MS) {
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
  try {
    JSON.parse(await readFileBounded(path, maxBytes));
    return true;
  } catch {
    return false;
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
