import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { runCommand, quoteShell } from "../commands.mjs";

const MAX_JSON_PARSE_BYTES = 40 * 1024 * 1024;

export async function collectStateFixtureAccounting(state, envName, artifactDir, options = {}) {
  const spec = state?.fixtureAccounting;
  if (!spec || !Array.isArray(spec.files) || spec.files.length === 0) {
    return null;
  }

  const envInfo = await (options.resolveEnvInfo ?? resolveEnvInfo)(envName);
  const openclawHome = envInfo?.runDir ?? null;
  const files = [];
  for (const fileSpec of spec.files) {
    files.push(await inspectFixtureFile(fileSpec, {
      artifactDir,
      openclawHome,
      envResolutionError: envInfo?.error ?? null
    }));
  }

  const accounting = {
    schemaVersion: "kova.fixtureAccounting.v1",
    stateId: state.id ?? null,
    kind: spec.kind ?? null,
    collectedAt: new Date().toISOString(),
    openclawHome,
    envResolution: envInfo?.error
      ? {
        status: "error",
        error: envInfo.error,
        commandStatus: envInfo.status ?? null
      }
      : { status: "ok", error: null, commandStatus: 0 },
    files,
    findings: fixtureFindings(files, envInfo),
  };
  accounting.status = accounting.findings.some((finding) => finding.severity === "error")
    ? "error"
    : "ok";

  const artifactPath = `${artifactDir}/state-fixture-accounting.json`;
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(accounting, null, 2)}\n`, "utf8");
  accounting.artifactPath = artifactPath;
  return accounting;
}

async function resolveEnvInfo(envName) {
  const result = await runCommand(`ocm service status ${quoteShell(envName)} --json`, {
    timeoutMs: 30_000,
    maxOutputChars: 200_000,
  });
  if (result.status !== 0) {
    return {
      error: "service-status-failed",
      status: result.status,
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      error: "service-status-json-invalid",
    };
  }
}

async function inspectFixtureFile(fileSpec, context) {
  const path = materializePath(fileSpec.path, context);
  const summary = {
    id: fileSpec.id,
    scope: fileSpec.scope ?? null,
    expectedShape: fileSpec.expectedShape ?? null,
    sourceId: fileSpec.sourceId ?? null,
    path: displayPath(path, context),
    exists: false,
    sizeBytes: null,
    sizeMb: null,
    shape: {
      kind: "missing",
      validOpenClawSessionStore: null,
    },
  };

  if (!path) {
    summary.shape = {
      kind: context.envResolutionError ? "environment-unavailable" : "unresolved-path",
      validOpenClawSessionStore: null,
      error: context.envResolutionError,
    };
    return summary;
  }

  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return summary;
    }
    summary.shape = {
      kind: "stat-error",
      validOpenClawSessionStore: null,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error?.code ?? null,
    };
    return summary;
  }

  summary.exists = true;
  summary.sizeBytes = stats.size;
  summary.sizeMb = roundMb(stats.size);
  if (!stats.isFile()) {
    summary.shape = {
      kind: "not-file",
      validOpenClawSessionStore: null,
    };
    return summary;
  }
  if (stats.size > MAX_JSON_PARSE_BYTES) {
    summary.shape = {
      kind: "too-large-to-classify",
      validOpenClawSessionStore: null,
      parseLimitBytes: MAX_JSON_PARSE_BYTES,
    };
    return summary;
  }

  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    summary.shape = {
      kind: "read-error",
      validOpenClawSessionStore: null,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error?.code ?? null,
    };
    return summary;
  }
  try {
    summary.shape = classifyJsonShape(JSON.parse(raw), fileSpec.expectedShape);
  } catch (error) {
    summary.shape = {
      kind: "invalid-json",
      validOpenClawSessionStore: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return summary;
}

function classifyJsonShape(value, expectedShape) {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      topType: "array",
      arrayLength: value.length,
      validOpenClawSessionStore: false,
    };
  }
  if (!value || typeof value !== "object") {
    return {
      kind: typeof value,
      topType: typeof value,
      validOpenClawSessionStore: false,
    };
  }

  const entries = Object.entries(value);
  const keys = entries.map(([key]) => key);
  if (Array.isArray(value.sessions)) {
    return {
      kind: "malformed-session-wrapper",
      topType: "object",
      topKeys: keys.slice(0, 8),
      schemaVersion: typeof value.schemaVersion === "string" ? value.schemaVersion : null,
      sessionArrayLength: value.sessions.length,
      validOpenClawSessionStore: false,
    };
  }
  if (Array.isArray(value.items) && expectedShape === "kova-memory-fixture") {
    return {
      kind: "kova-memory-fixture",
      topType: "object",
      topKeys: keys.slice(0, 8),
      schemaVersion: typeof value.schemaVersion === "string" ? value.schemaVersion : null,
      itemCount: value.items.length,
      validOpenClawSessionStore: null,
    };
  }

  const invalidEntryCount = entries.filter(([, entry]) => !entry || typeof entry !== "object" || Array.isArray(entry)).length;
  const sessionIdCount = entries.filter(([, entry]) => typeof entry?.sessionId === "string").length;
  return {
    kind: "openclaw-session-store",
    topType: "object",
    topKeys: keys.slice(0, 8),
    entryCount: entries.length,
    invalidEntryCount,
    sessionIdCount,
    sampleEntryKeys: entries.length > 0 && entries[0][1] && typeof entries[0][1] === "object"
      ? Object.keys(entries[0][1]).slice(0, 8)
      : [],
    validOpenClawSessionStore: invalidEntryCount === 0,
  };
}

function fixtureFindings(files, envInfo = null) {
  const findings = [];
  const byId = new Map(files.map((file) => [file.id, file]));
  if (envInfo?.error) {
    findings.push({
      severity: "error",
      kind: "harness",
      message: `OCM environment resolution failed (${envInfo.error})`,
      commandStatus: envInfo.status ?? null,
    });
  }
  for (const file of files) {
    const inspectionFailed = ["environment-unavailable", "unresolved-path", "stat-error", "read-error"].includes(file.shape?.kind);
    if (!inspectionFailed && file.expectedShape === "openclaw-session-store" && file.shape?.validOpenClawSessionStore === false) {
      findings.push({
        severity: "warning",
        fileId: file.id,
        message: `${file.id} is not a valid OpenClaw session store (${file.shape.kind})`,
      });
    }
    if (!inspectionFailed && file.expectedShape === "malformed-session-wrapper" && file.shape?.kind !== "malformed-session-wrapper") {
      findings.push({
        severity: "info",
        fileId: file.id,
        message: `${file.id} no longer has malformed wrapper shape (${file.shape?.kind ?? "unknown"})`,
      });
    }
    if (file.shape?.kind === "stat-error" || file.shape?.kind === "read-error") {
      findings.push({
        severity: "error",
        kind: "harness",
        fileId: file.id,
        message: `${file.id} could not be inspected (${file.shape.kind}: ${file.shape.errorCode ?? "unknown"})`,
      });
    }
    if (!file.exists && file.shape?.kind === "missing") {
      findings.push({
        severity: "warning",
        fileId: file.id,
        message: `${file.id} is missing`,
      });
    }
    const source = file.sourceId ? byId.get(file.sourceId) : null;
    if (source && source.exists && file.exists && source.sizeBytes !== file.sizeBytes) {
      findings.push({
        severity: "info",
        fileId: file.id,
        sourceId: file.sourceId,
        message: `${file.id} size changed after import/startup (${source.sizeBytes} -> ${file.sizeBytes} bytes)`,
      });
    }
    if (source && source.shape?.kind && file.shape?.kind && source.shape.kind !== file.shape.kind) {
      findings.push({
        severity: "info",
        fileId: file.id,
        sourceId: file.sourceId,
        message: `${file.id} shape changed after import/startup (${source.shape.kind} -> ${file.shape.kind})`,
      });
    }
  }
  return findings;
}

function materializePath(path, { artifactDir, openclawHome }) {
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }
  if (path.includes("{openclawHome}") && !openclawHome) {
    return null;
  }
  return path
    .replaceAll("{artifactDir}", artifactDir)
    .replaceAll("{openclawHome}", openclawHome ?? "");
}

function displayPath(path, { artifactDir, openclawHome }) {
  if (!path) {
    return null;
  }
  if (openclawHome && path.startsWith(openclawHome)) {
    return `{openclawHome}/${relative(openclawHome, path)}`;
  }
  if (path.startsWith(artifactDir)) {
    return `{artifactDir}/${relative(artifactDir, path)}`;
  }
  return path;
}

function roundMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}
