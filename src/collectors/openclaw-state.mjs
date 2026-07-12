import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const OPENCLAW_STATE_SNAPSHOT_SCHEMA = "kova.openclawStateSnapshot.v1";

const DEFAULT_LIMITS = {
  maxFileBytes: 64 * 1024,
  maxJsonDepth: 5,
  maxArrayEntries: 40,
  maxPluginDirs: 80
};

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|password|cookie|credential|private[_-]?key)/i;
const SAFE_VALUE_KEY_PATTERN = /^(?:id|name|title|kind|source|provider|providerId|model|modelId|authMethod|method|version|channel|release|schemaVersion|enabled|disabled)$/i;
const EXCLUDED_DIRS = new Set([
  ".git",
  "dist",
  "build",
  "node_modules",
  "runtime",
  "runtimes",
  "workspaces",
  ".pnpm",
  ".cache"
]);

const KNOWN_FILES = [
  ".openclaw/openclaw.json",
  "config.json",
  "settings.json",
  "providers.json",
  "models.json",
  "auth.json",
  "config/config.json",
  "config/settings.json",
  "config/providers.json",
  "config/models.json",
  "config/auth.json",
  "config/kova-doctor-upgrade-evidence.json",
  "config/version.json",
  "config/kova-source-release.json",
  "plugins/legacy-index.json",
  "plugins/installs.json",
  ".openclaw/plugins/installs.json"
];

export async function captureOpenClawStateSnapshot(options = {}) {
  const limits = normalizeLimits(options.limits);
  const home = options.home ?? process.env.OPENCLAW_HOME ?? null;
  const label = options.label ?? "openclaw-state";
  const snapshot = {
    schemaVersion: OPENCLAW_STATE_SNAPSHOT_SCHEMA,
    label,
    capturedAt: new Date().toISOString(),
    limits,
    home: await homeSummary(home),
    runtime: runtimeSummary(options.runtime),
    service: serviceSummary(options.service),
    config: configSummary(),
    auth: authSummary(),
    models: modelSummary(),
    workspace: workspaceSummary(),
    cleanup: cleanupSummary(options.cleanup),
    files: [],
    plugins: {
      roots: [],
      installIndexes: [],
      pluginDirs: []
    },
    budget: {
      fileCount: 0,
      totalBytes: 0,
      truncatedCount: 0,
      omittedCount: 0,
      excludedPaths: []
    },
    redaction: {
      secretKeyCount: 0
    }
  };

  if (!home || snapshot.home.present !== true) {
    snapshot.budget.omittedCount += 1;
    return snapshot;
  }
  const resolvedHome = await realpath(home);

  for (const relPath of KNOWN_FILES) {
    const summary = await summarizeFile(home, resolvedHome, relPath, limits, snapshot);
    if (summary) {
      snapshot.files.push(summary);
      applyKnownFileSemantics(snapshot, relPath, summary);
    }
  }

  await summarizePluginRoot(home, resolvedHome, "plugins", limits, snapshot);
  await summarizePluginRoot(home, resolvedHome, ".openclaw/plugins", limits, snapshot);

  snapshot.files.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.plugins.roots.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.plugins.installIndexes.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.plugins.pluginDirs.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.budget.fileCount = snapshot.files.length;
  snapshot.budget.totalBytes = snapshot.files.reduce((total, file) => total + (file.bytes ?? 0), 0);
  snapshot.budget.truncatedCount = snapshot.files.filter((file) => file.truncated).length;

  return snapshot;
}

function runtimeSummary(runtime = {}) {
  const targetKind = stringOrNull(runtime.targetKind);
  const targetValue = stringOrNull(runtime.targetValue);
  const runtimeName = stringOrNull(runtime.runtimeName);
  return {
    targetKind,
    targetValue: targetKind === "local-build" ? null : targetValue,
    targetValueHash: targetValue && targetKind === "local-build" ? sha256(targetValue).slice(0, 16) : null,
    runtimeName,
    releaseTrack: targetKind === "release" ? targetValue : null,
    version: targetKind === "version" ? targetValue : null
  };
}

function serviceSummary(service = {}) {
  return {
    desired: stringOrNull(service.desired),
    state: stringOrNull(service.state),
    pid: integerOrNull(service.pid),
    port: integerOrNull(service.port),
    restartCount: integerOrNull(service.restartCount),
    readiness: stringOrNull(service.readiness),
    source: service.source ?? "snapshot-context"
  };
}

function configSummary() {
  return {
    files: [],
    keys: [],
    schemaVersions: []
  };
}

function authSummary() {
  return {
    providerIds: [],
    authMethodShapes: [],
    secretReferenceKeys: [],
    secretValueCount: 0
  };
}

function modelSummary() {
  return {
    providerIds: [],
    modelIds: [],
    modelCount: 0
  };
}

function workspaceSummary() {
  return {
    roots: [],
    rootHashes: [],
    allowedRootCount: 0,
    durableBoundary: "redacted-paths"
  };
}

function cleanupSummary(cleanup = {}) {
  return {
    expected: cleanup.expected === true,
    state: stringOrNull(cleanup.state) ?? "not-evaluated",
    reason: stringOrNull(cleanup.reason)
  };
}

export async function writeOpenClawStateSnapshot(options = {}) {
  const snapshot = await captureOpenClawStateSnapshot(options);
  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  return snapshot;
}

async function homeSummary(home) {
  if (!home) {
    return { present: false, pathHash: null };
  }
  try {
    const stats = await stat(home);
    const resolved = await realpath(home).catch(() => home);
    return {
      present: stats.isDirectory(),
      pathHash: sha256(resolved).slice(0, 16)
    };
  } catch (error) {
    return {
      present: false,
      pathHash: sha256(String(home)).slice(0, 16),
      reason: error.code ?? error.message
    };
  }
}

async function summarizePluginRoot(home, resolvedHome, rootRelPath, limits, snapshot) {
  const rootPath = join(home, rootRelPath);
  const resolvedRoot = await resolveContainedPath(resolvedHome, rootPath, rootRelPath, snapshot);
  if (!resolvedRoot) {
    return;
  }
  const rootStats = await stat(resolvedRoot).catch(() => null);
  if (!rootStats?.isDirectory()) {
    return;
  }

  const entries = await readdir(resolvedRoot, { withFileTypes: true }).catch(() => null);
  if (!entries || !await directoryIdentityMatches(resolvedHome, rootPath, rootStats)) {
    recordExcludedPath(snapshot, rootRelPath);
    return;
  }

  snapshot.plugins.roots.push({
    path: rootRelPath,
    present: true
  });

  const installIndex = snapshot.files.find((file) => file.path === `${rootRelPath}/installs.json`);
  if (installIndex) {
    snapshot.plugins.installIndexes.push({
      path: installIndex.path,
      bytes: installIndex.bytes,
      sha256: installIndex.sha256,
      truncated: installIndex.truncated
    });
    applyPluginInstallIndexSemantics(snapshot, installIndex);
  }

  let seen = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) {
      snapshot.budget.excludedPaths.push(`${rootRelPath}/${entry.name}`);
      continue;
    }
    if (seen >= limits.maxPluginDirs) {
      snapshot.budget.omittedCount += 1;
      continue;
    }
    seen += 1;
    if (entry.isSymbolicLink()) {
      snapshot.budget.excludedPaths.push(`${rootRelPath}/${entry.name}`);
      snapshot.budget.omittedCount += 1;
      continue;
    }

    const relPath = `${rootRelPath}/${entry.name}`;
    const resolvedPluginRoot = await resolveContainedPath(
      resolvedHome,
      join(resolvedRoot, entry.name),
      relPath,
      snapshot
    );
    if (!resolvedPluginRoot) {
      continue;
    }
    const plugin = {
      path: relPath,
      name: entry.name,
      nodeModulesPresent: await existsContained(resolvedHome, join(resolvedPluginRoot, "node_modules")),
      manifests: []
    };
    if (plugin.nodeModulesPresent) {
      snapshot.budget.excludedPaths.push(`${relPath}/node_modules`);
    }
    for (const manifestName of ["plugin.json", "manifest.json", "package.json"]) {
      const manifest = await summarizeFile(home, resolvedHome, `${relPath}/${manifestName}`, limits, snapshot);
      if (manifest) {
        snapshot.files.push(manifest);
        plugin.manifests.push({
          path: manifest.path,
          bytes: manifest.bytes,
          sha256: manifest.sha256,
          truncated: manifest.truncated
        });
      }
    }
    snapshot.plugins.pluginDirs.push(plugin);
  }
}

function applyKnownFileSemantics(snapshot, relPath, summary) {
  const json = summary.json;
  if (!json || json.parseError || json.type !== "object") {
    return;
  }
  if (isConfigPath(relPath)) {
    mergeUnique(snapshot.config.files, relPath);
    mergeUniqueArray(snapshot.config.keys, json.keys ?? []);
    const schemaVersion = fieldStringValue(json, "schemaVersion");
    if (schemaVersion) {
      mergeUnique(snapshot.config.schemaVersions, schemaVersion);
    }
    collectProviderModelWorkspaceShape(snapshot, json);
    collectAuthShape(snapshot, json);
  }
  if (/auth\.json$/i.test(relPath)) {
    collectAuthShape(snapshot, json);
  }
  if (/providers\.json$/i.test(relPath) || /models\.json$/i.test(relPath)) {
    collectProviderModelWorkspaceShape(snapshot, json);
  }
  if (/plugins\/installs\.json$/i.test(relPath)) {
    applyPluginInstallIndexSemantics(snapshot, summary);
  }
}

function applyPluginInstallIndexSemantics(snapshot, summary) {
  const plugins = collectObjectsByKey(summary.json, "plugins").flatMap((entry) => entry.items ?? []);
  for (const plugin of plugins) {
    if (plugin.type !== "object") {
      continue;
    }
    const id = fieldStringValue(plugin, "id") ?? fieldStringValue(plugin, "name");
    if (!id) {
      continue;
    }
    const existing = snapshot.plugins.installed ?? [];
    if (!snapshot.plugins.installed) {
      snapshot.plugins.installed = existing;
    }
    if (!existing.some((item) => item.id === id)) {
      existing.push({
        id,
        source: fieldStringValue(plugin, "source"),
        enabled: fieldPrimitiveValue(plugin, "enabled"),
        version: fieldStringValue(plugin, "version")
      });
    }
  }
}

function collectProviderModelWorkspaceShape(snapshot, json) {
  for (const provider of collectValuesByKey(json, ["provider", "providerId", "providerID"])) {
    mergeUnique(snapshot.models.providerIds, provider);
    mergeUnique(snapshot.auth.providerIds, provider);
  }
  for (const model of collectValuesByKey(json, ["model", "modelId", "modelID"])) {
    mergeUnique(snapshot.models.modelIds, model);
  }
  for (const rootHash of collectFingerprintsByKey(json, ["workspace", "workspaceRoot", "workspacePath", "root", "allowedRoot"])) {
    mergeUnique(snapshot.workspace.rootHashes, rootHash);
  }
  const allowedRoots = collectObjectsByKey(json, "allowedRoots").flatMap((entry) => stringItemFingerprints(entry));
  for (const rootHash of allowedRoots) {
    mergeUnique(snapshot.workspace.rootHashes, rootHash);
  }
  snapshot.workspace.allowedRootCount = snapshot.workspace.rootHashes.length;
  snapshot.models.modelCount = snapshot.models.modelIds.length;
}

function collectAuthShape(snapshot, json) {
  for (const authMethod of collectValuesByKey(json, ["authMethod", "auth", "method"])) {
    mergeUnique(snapshot.auth.authMethodShapes, authMethod);
  }
  for (const key of collectSecretKeys(json)) {
    mergeUnique(snapshot.auth.secretReferenceKeys, key);
  }
  snapshot.auth.secretValueCount = snapshot.redaction.secretKeyCount;
}

function isConfigPath(relPath) {
  return /(?:^|\/)(?:config|settings|kova-source-release)\.json$/i.test(relPath) ||
    /(?:^|\/)config\/.*\.json$/i.test(relPath);
}

function collectValuesByKey(summary, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const values = [];
  visitSummary(summary, (node, key) => {
    if (key && wanted.has(key.toLowerCase())) {
      const value = summaryStringValue(node);
      if (value) {
        values.push(value);
      }
    }
  });
  return values;
}

function collectFingerprintsByKey(summary, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const values = [];
  visitSummary(summary, (node, key) => {
    if (key && wanted.has(key.toLowerCase())) {
      const value = summaryStringFingerprint(node);
      if (value) {
        values.push(value);
      }
    }
  });
  return values;
}

function collectObjectsByKey(summary, key) {
  const values = [];
  visitSummary(summary, (node, nodeKey) => {
    if (nodeKey === key && node) {
      values.push(node);
    }
  });
  return values;
}

function collectSecretKeys(summary) {
  const keys = [];
  visitSummary(summary, (node, key) => {
    if (key && node?.redacted === true) {
      keys.push(key);
    }
  });
  return keys;
}

function visitSummary(node, visitor, key = null) {
  if (!node || typeof node !== "object") {
    return;
  }
  visitor(node, key);
  if (node.type === "object") {
    for (const [fieldKey, field] of Object.entries(node.fields ?? {})) {
      visitSummary(field, visitor, fieldKey);
    }
  } else if (node.type === "array") {
    for (const item of node.items ?? []) {
      visitSummary(item, visitor, null);
    }
  }
}

function fieldStringValue(objectSummary, key) {
  return summaryStringValue(objectSummary?.fields?.[key]);
}

function fieldPrimitiveValue(objectSummary, key) {
  const field = objectSummary?.fields?.[key];
  return field?.value ?? null;
}

function summaryStringValue(summary) {
  if (summary?.type === "string" && typeof summary.value === "string") {
    return summary.value;
  }
  return null;
}

function stringItemFingerprints(summary) {
  if (summary?.type !== "array") {
    return [];
  }
  return (summary.items ?? []).map(summaryStringFingerprint).filter(Boolean);
}

function mergeUnique(values, value) {
  if (value !== null && value !== undefined && !values.includes(value)) {
    values.push(value);
  }
}

function mergeUniqueArray(values, additions) {
  for (const value of additions ?? []) {
    mergeUnique(values, value);
  }
}

function summaryStringFingerprint(summary) {
  if (summary?.type !== "string") {
    return null;
  }
  if (typeof summary.value === "string") {
    return sha256(summary.value).slice(0, 16);
  }
  return typeof summary.sha256 === "string" ? summary.sha256.slice(0, 16) : null;
}

async function summarizeFile(home, resolvedHome, relPath, limits, snapshot) {
  const fullPath = join(home, relPath);
  const opened = await openContainedFile(resolvedHome, fullPath, relPath, snapshot);
  if (!opened) {
    return null;
  }
  const { handle, stats } = opened;
  try {
    if (!stats.isFile()) {
      snapshot.budget.omittedCount += 1;
      return null;
    }

    const sample = await readFileSample(handle, stats.size, limits.maxFileBytes);
    const summary = {
      path: relPath,
      name: basename(relPath),
      bytes: stats.size,
      sampledBytes: sample.bytes.length,
      truncated: sample.truncated,
      hashScope: sample.truncated ? "sample" : "full",
      sha256: sha256(sample.bytes),
      json: null
    };

    if (sample.truncated) {
      summary.truncation = {
        reason: "file exceeded snapshot maxFileBytes",
        maxFileBytes: limits.maxFileBytes
      };
    }

    if (relPath.endsWith(".json") && !sample.truncated) {
      try {
        const parsed = JSON.parse(sample.bytes.toString("utf8"));
        const redaction = { secretKeyCount: 0 };
        summary.json = summarizeJson(parsed, { limits, redaction });
        snapshot.redaction.secretKeyCount += redaction.secretKeyCount;
      } catch (error) {
        summary.json = {
          parseError: error.message
        };
      }
    }

    return summary;
  } finally {
    await handle.close();
  }
}

async function readFileSample(handle, size, maxBytes) {
  if (size <= maxBytes) {
    return {
      bytes: await handle.readFile(),
      truncated: false
    };
  }

  const bytes = Buffer.alloc(maxBytes);
  const { bytesRead } = await handle.read(bytes, 0, maxBytes, 0);
  return {
    bytes: bytes.subarray(0, bytesRead),
    truncated: true
  };
}

function summarizeJson(value, context, key = null, depth = 0) {
  if (key && SECRET_KEY_PATTERN.test(key)) {
    context.redaction.secretKeyCount += 1;
    return {
      type: typeOf(value),
      redacted: true
    };
  }
  if (depth >= context.limits.maxJsonDepth) {
    return {
      type: typeOf(value),
      truncated: true,
      reason: "max json depth reached"
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
      truncated: value.length > context.limits.maxArrayEntries,
      items: value.slice(0, context.limits.maxArrayEntries).map((item) => summarizeJson(item, context, null, depth + 1))
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return {
      type: "object",
      keys: entries.map(([entryKey]) => entryKey),
      fields: Object.fromEntries(entries.map(([entryKey, entryValue]) => [
        entryKey,
        summarizeJson(entryValue, context, entryKey, depth + 1)
      ]))
    };
  }
  if (typeof value === "string") {
    const safeValue = key && SAFE_VALUE_KEY_PATTERN.test(key) && value.length <= 160;
    return {
      type: "string",
      length: value.length,
      value: safeValue ? value : undefined,
      sha256: safeValue ? undefined : sha256(value).slice(0, 16)
    };
  }
  return {
    type: typeOf(value),
    value
  };
}

function typeOf(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

async function existsContained(resolvedHome, path) {
  const resolvedPath = await realpath(path).catch(() => null);
  return resolvedPath !== null && isContainedPath(resolvedHome, resolvedPath);
}

async function directoryIdentityMatches(resolvedHome, path, expectedStats) {
  const currentPath = await realpath(path).catch(() => null);
  if (!currentPath || !isContainedPath(resolvedHome, currentPath)) {
    return false;
  }
  const currentStats = await stat(currentPath).catch(() => null);
  return currentStats?.isDirectory() === true &&
    currentStats.dev === expectedStats.dev &&
    currentStats.ino === expectedStats.ino;
}

async function openContainedFile(resolvedHome, path, displayPath, snapshot) {
  const initialPath = await resolveContainedPath(resolvedHome, path, displayPath, snapshot);
  if (!initialPath) {
    return null;
  }
  const handle = await open(
    initialPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  ).catch(() => null);
  if (!handle) {
    return null;
  }
  let transferred = false;
  try {
    const handleStats = await handle.stat();
    const currentPath = await realpath(path).catch(() => null);
    if (!currentPath || !isContainedPath(resolvedHome, currentPath)) {
      recordExcludedPath(snapshot, displayPath);
      return null;
    }
    const currentStats = await stat(currentPath).catch(() => null);
    if (!currentStats || currentStats.dev !== handleStats.dev || currentStats.ino !== handleStats.ino) {
      recordExcludedPath(snapshot, displayPath);
      return null;
    }
    transferred = true;
    return {
      handle,
      stats: handleStats
    };
  } finally {
    if (!transferred) {
      await handle.close();
    }
  }
}

async function resolveContainedPath(resolvedHome, path, displayPath, snapshot) {
  const resolvedPath = await realpath(path).catch(() => null);
  if (!resolvedPath) {
    return null;
  }
  if (isContainedPath(resolvedHome, resolvedPath)) {
    return resolvedPath;
  }
  recordExcludedPath(snapshot, displayPath);
  return null;
}

function recordExcludedPath(snapshot, path) {
  if (!snapshot.budget.excludedPaths.includes(path)) {
    snapshot.budget.excludedPaths.push(path);
  }
  snapshot.budget.omittedCount += 1;
}

function isContainedPath(root, candidate) {
  const relPath = relative(root, candidate);
  return relPath === "" ||
    (!isAbsolute(relPath) && relPath !== ".." && !relPath.startsWith(`..${sep}`));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (Number.isInteger(value) && value > 0) {
      limits[key] = value;
    }
  }
  return limits;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}
