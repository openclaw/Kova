import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";

export const COLLECTOR_ARTIFACT_DIRS_SCHEMA = "kova.collectorArtifactDirs.v1";
const MAX_ARTIFACT_NAME_BYTES = 255;

export function collectorArtifactDirs(runArtifactDir) {
  return {
    schemaVersion: COLLECTOR_ARTIFACT_DIRS_SCHEMA,
    root: runArtifactDir,
    collectors: join(runArtifactDir, "collectors"),
    openclaw: join(runArtifactDir, "openclaw"),
    provider: join(runArtifactDir, "provider"),
    processSnapshots: join(runArtifactDir, "process-snapshots"),
    resourceSamples: join(runArtifactDir, "resource-samples"),
    nodeProfiles: join(runArtifactDir, "node-profiles"),
    diagnostics: join(runArtifactDir, "diagnostics"),
    heap: join(runArtifactDir, "heap"),
    diagnosticReports: join(runArtifactDir, "diagnostic-reports")
  };
}

export async function prepareCollectorArtifactDirs(runArtifactDir, options = {}) {
  const dirs = collectorArtifactDirs(runArtifactDir);
  const required = [
    dirs.root,
    dirs.collectors,
    dirs.openclaw,
    dirs.provider,
    dirs.processSnapshots,
    dirs.resourceSamples
  ];
  if (options.nodeProfile === true) {
    required.push(dirs.nodeProfiles);
  }
  if (options.deepProfile === true || options.profileOnFailure === true || options.heapSnapshot === true) {
    required.push(dirs.diagnostics, dirs.heap, dirs.diagnosticReports);
  }
  for (const dir of required) {
    await mkdir(dir, { recursive: true });
  }
  return dirs;
}

export async function copyCollectorArtifacts(sources, destinationDir, options = {}) {
  await mkdir(destinationDir, { recursive: true });
  const artifacts = [];
  const seenTargets = new Set();
  const limit = Math.max(0, Number(options.limit ?? sources.length));

  for (const source of [...new Set(sources)].slice(0, limit)) {
    if (options.beforeCopy) {
      await options.beforeCopy(source);
    }
    const target = join(destinationDir, collisionSafeArtifactName(source));
    if (seenTargets.has(target)) {
      continue;
    }
    try {
      await copyArtifact(source, target, options.deadlineEpochMs);
      artifacts.push(target);
      seenTargets.add(target);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const artifactBytes = (await Promise.all(artifacts.map(async (path) => {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }))).reduce((total, size) => total + size, 0);

  return { artifacts, artifactBytes };
}

async function copyArtifact(source, target, deadlineEpochMs) {
  const temporaryTarget = join(
    dirname(target),
    `.kova-artifact-${randomUUID()}.tmp`
  );
  const deadline = Number(deadlineEpochMs);
  let controller;
  let timeout;
  try {
    if (Number.isFinite(deadline)) {
      const remainingMs = Math.floor(deadline - Date.now());
      if (remainingMs <= 0) {
        throw new Error(`collector artifact copy exceeded deadline: ${source}`);
      }
      controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), remainingMs);
      timeout.unref?.();
      await pipeline(
        createReadStream(source),
        createWriteStream(temporaryTarget, { flags: "wx", mode: 0o600 }),
        { signal: controller.signal }
      );
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw new Error(`collector artifact copy exceeded deadline: ${source}`);
      }
    } else {
      await pipeline(
        createReadStream(source),
        createWriteStream(temporaryTarget, { flags: "wx", mode: 0o600 })
      );
    }
    // Keep an earlier valid artifact intact until its replacement is complete.
    await rename(temporaryTarget, target);
  } catch (error) {
    await rm(temporaryTarget, { force: true }).catch(() => {});
    if (controller?.signal.aborted) {
      throw new Error(`collector artifact copy exceeded deadline: ${source}`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function collisionSafeArtifactName(source) {
  const name = basename(source);
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const digestSuffix = `-${digest}`;
  const extensionBudget = MAX_ARTIFACT_NAME_BYTES - Buffer.byteLength(digestSuffix);
  const retainedExtension = truncateUtf8(extension, extensionBudget);
  const stemBudget = MAX_ARTIFACT_NAME_BYTES
    - Buffer.byteLength(digestSuffix)
    - Buffer.byteLength(retainedExtension);
  return `${truncateUtf8(stem, stemBudget)}${digestSuffix}${retainedExtension}`;
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}
