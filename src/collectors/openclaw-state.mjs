import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const OPENCLAW_STATE_SNAPSHOT_SCHEMA = "kova.openclawStateSnapshot.v1";

const DEFAULT_LIMITS = {
  maxFileBytes: 64 * 1024,
  maxJsonDepth: 5,
  maxArrayEntries: 40,
  maxPluginDirs: 80
};

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|password|cookie|credential|private[_-]?key)/i;
const SAFE_VALUE_KEY_PATTERN = /^(?:id|name|title|kind|source|provider|model|version|channel|release|schemaVersion|enabled|disabled|path|root)$/i;
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
  "config/kova-source-release.json",
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

  for (const relPath of KNOWN_FILES) {
    const summary = await summarizeFile(home, relPath, limits, snapshot);
    if (summary) {
      snapshot.files.push(summary);
    }
  }

  await summarizePluginRoot(home, "plugins", limits, snapshot);
  await summarizePluginRoot(home, ".openclaw/plugins", limits, snapshot);

  snapshot.files.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.plugins.roots.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.plugins.installIndexes.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.plugins.pluginDirs.sort((a, b) => a.path.localeCompare(b.path));
  snapshot.budget.fileCount = snapshot.files.length;
  snapshot.budget.totalBytes = snapshot.files.reduce((total, file) => total + (file.bytes ?? 0), 0);
  snapshot.budget.truncatedCount = snapshot.files.filter((file) => file.truncated).length;

  return snapshot;
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

async function summarizePluginRoot(home, rootRelPath, limits, snapshot) {
  const rootPath = join(home, rootRelPath);
  const rootStats = await stat(rootPath).catch(() => null);
  if (!rootStats?.isDirectory()) {
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
  }

  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
  let seen = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (EXCLUDED_DIRS.has(entry.name)) {
      snapshot.budget.excludedPaths.push(`${rootRelPath}/${entry.name}`);
      continue;
    }
    if (seen >= limits.maxPluginDirs) {
      snapshot.budget.omittedCount += 1;
      continue;
    }
    seen += 1;

    const relPath = `${rootRelPath}/${entry.name}`;
    const plugin = {
      path: relPath,
      name: entry.name,
      nodeModulesPresent: await exists(join(home, relPath, "node_modules")),
      manifests: []
    };
    if (plugin.nodeModulesPresent) {
      snapshot.budget.excludedPaths.push(`${relPath}/node_modules`);
    }
    for (const manifestName of ["plugin.json", "manifest.json", "package.json"]) {
      const manifest = await summarizeFile(home, `${relPath}/${manifestName}`, limits, snapshot);
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

async function summarizeFile(home, relPath, limits, snapshot) {
  const fullPath = join(home, relPath);
  const stats = await stat(fullPath).catch(() => null);
  if (!stats) {
    return null;
  }
  if (!stats.isFile()) {
    snapshot.budget.omittedCount += 1;
    return null;
  }

  const sample = await readFileSample(fullPath, stats.size, limits.maxFileBytes);
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
}

async function readFileSample(path, size, maxBytes) {
  if (size <= maxBytes) {
    return {
      bytes: await readFile(path),
      truncated: false
    };
  }

  const handle = await open(path, constants.O_RDONLY);
  try {
    const bytes = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(bytes, 0, maxBytes, 0);
    return {
      bytes: bytes.subarray(0, bytesRead),
      truncated: true
    };
  } finally {
    await handle.close();
  }
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
