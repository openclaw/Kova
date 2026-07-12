import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { withFileLock } from "../file-lock.mjs";
import { artifactsDir } from "../paths.mjs";
import { renderPasteSummary } from "./report.mjs";

export async function bundleReport(reportPath, options = {}) {
  const sourceJsonPath = resolve(reportPath);
  const report = JSON.parse(await readFile(sourceJsonPath, "utf8"));
  const runId = report.runId;
  if (!runId) {
    throw new Error("report is missing runId");
  }

  const outputRoot = options.outputDir ? resolve(options.outputDir) : join(artifactsDir, "bundles");
  await mkdir(outputRoot, { recursive: true });

  const bundleName = `${safeRunIdSegment(runId)}-bundle`;
  const tmp = await mkdtemp(join(tmpdir(), "kova-artifact-bundle-"));
  const stage = join(tmp, bundleName);
  const stagedArchivePath = join(tmp, `${bundleName}.tar.gz`);

  try {
    await mkdir(stage, { recursive: true });
    await cp(sourceJsonPath, join(stage, "report.json"));

    const markdownPath = siblingMarkdownPath(sourceJsonPath);
    await requireRegularFile(markdownPath, "report Markdown");
    const included = {
      reportJson: true,
      reportMarkdown: true,
      pasteSummary: true,
      runArtifacts: false,
      artifactIndex: true
    };

    await cp(markdownPath, join(stage, "report.md"));

    await writeFile(join(stage, "paste-summary.txt"), renderPasteSummary(report), "utf8");

    const runArtifactsPath = isCanonicalRunId(runId) ? join(artifactsDir, runId) : null;
    if (runArtifactsPath && await directoryExists(runArtifactsPath)) {
      await cp(runArtifactsPath, join(stage, "artifacts"), { recursive: true });
      included.runArtifacts = true;
    }

    const manifest = {
      schemaVersion: "kova.artifact.manifest.v1",
      generatedAt: new Date().toISOString(),
      runId,
      mode: report.mode ?? null,
      target: report.target ?? null,
      profile: report.profile ?? null,
      platform: report.platform ?? null,
      source: {
        reportJsonPath: sourceJsonPath,
        reportMarkdownPath: markdownPath,
        runArtifactsPath: runArtifactsPath && await directoryExists(runArtifactsPath)
          ? runArtifactsPath
          : null
      },
      included
    };
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const artifactIndex = await buildArtifactIndex(stage, bundleName);
    await writeFile(join(stage, "artifact-index.json"), `${JSON.stringify(artifactIndex, null, 2)}\n`, "utf8");

    const tar = spawnSync("tar", ["-czf", stagedArchivePath, "-C", tmp, bundleName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (tar.status !== 0) {
      throw new Error(tar.stderr || tar.stdout || "tar failed");
    }

    const archive = await readFile(stagedArchivePath);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const outputPath = join(outputRoot, `${bundleName}-${sha256}.tar.gz`);
    const checksumPath = `${outputPath}.sha256`;
    await publishBundlePair({
      archive,
      outputPath,
      checksumPath,
      checksum: `${sha256}  ${basename(outputPath)}\n`
    });

    return {
      schemaVersion: "kova.artifact.bundle.v1",
      generatedAt: new Date().toISOString(),
      runId,
      outputPath,
      checksumPath,
      sha256,
      bytes: archive.length,
      artifactIndex: {
        path: "artifact-index.json",
        fileCount: artifactIndex.fileCount,
        totalBytes: artifactIndex.totalBytes
      },
      included
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function retainGateArtifacts(reportPath, bundle, options = {}) {
  const sourceJsonPath = resolve(reportPath);
  const report = JSON.parse(await readFile(sourceJsonPath, "utf8"));
  if (!report.runId) {
    throw new Error("report is missing runId");
  }

  const outputRoot = options.outputDir
    ? resolve(options.outputDir)
    : join(artifactsDir, "release-gates", safeRunIdSegment(report.runId));
  await mkdir(dirname(outputRoot), { recursive: true });

  const markdownPath = siblingMarkdownPath(sourceJsonPath);
  await requireRegularFile(markdownPath, "report Markdown");
  if (bundle?.outputPath) {
    await requireRegularFile(bundle.outputPath, "report bundle");
  }
  if (bundle?.checksumPath) {
    await requireRegularFile(bundle.checksumPath, "report bundle checksum");
  }

  const lockPath = `${outputRoot}.lock`;
  return withFileLock(lockPath, () => replaceRetainedArtifactTree({
    outputRoot,
    sourceJsonPath,
    markdownPath,
    report,
    bundle
  }));
}

function siblingMarkdownPath(path) {
  const extension = extname(path);
  const base = extension ? basename(path, extension) : basename(path);
  return join(dirname(path), `${base}.md`);
}

function safeRunIdSegment(value) {
  const runId = String(value);
  if (isCanonicalRunId(runId)) {
    return runId;
  }
  return `external-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
}

function isCanonicalRunId(value) {
  return /^kova-\d{6}-\d{6}-[0-9a-f]{6}$/.test(value);
}

async function buildArtifactIndex(stage, bundleName) {
  const entries = await listFiles(stage, stage);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    schemaVersion: "kova.artifact.index.v1",
    generatedAt: new Date().toISOString(),
    bundleRoot: bundleName,
    fileCount: entries.length,
    totalBytes,
    entries
  };
}

async function listFiles(root, dir) {
  const names = await readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const name of names.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      entries.push(...await listFiles(root, path));
      continue;
    }
    if (!name.isFile()) {
      continue;
    }
    const bytes = await readFile(path);
    entries.push({
      path: relative(root, path),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  return entries;
}

export async function publishBundlePair({ archive, outputPath, checksumPath, checksum }) {
  const entries = [
    { path: outputPath, content: archive },
    { path: checksumPath, content: checksum }
  ];
  const staged = entries.map((entry) => ({
    ...entry,
    stagedPath: `${entry.path}.${randomUUID()}.tmp`
  }));
  let archivePublished = false;
  try {
    for (const entry of staged) {
      await writeDurableFile(entry.stagedPath, entry.content);
    }
    const outputExists = await pathExists(outputPath);
    const checksumExists = await pathExists(checksumPath);
    if (outputExists || checksumExists) {
      if (outputExists) {
        await requireRegularFile(outputPath, "existing report bundle");
      }
      if (checksumExists) {
        await requireRegularFile(checksumPath, "existing report bundle checksum");
      }
      const existing = outputExists ? await readFile(outputPath) : null;
      const existingHash = existing ? createHash("sha256").update(existing).digest("hex") : null;
      const expectedHash = createHash("sha256").update(archive).digest("hex");
      const existingChecksum = checksumExists ? await readFile(checksumPath, "utf8") : null;
      if (existingHash !== expectedHash || (existingChecksum !== null && existingChecksum !== checksum)) {
        throw new Error(`bundle destination collision: ${outputPath}`);
      }
      if (!checksumExists) {
        await rename(staged[1].stagedPath, checksumPath);
      }
      return;
    }
    await rename(staged[0].stagedPath, outputPath);
    archivePublished = true;
    await rename(staged[1].stagedPath, checksumPath);
  } catch (error) {
    if (archivePublished) {
      await rm(outputPath, { force: true });
    }
    throw error;
  } finally {
    await Promise.all(staged.map((entry) => rm(entry.stagedPath, { force: true })));
  }
}

async function replaceRetainedArtifactTree({
  outputRoot,
  sourceJsonPath,
  markdownPath,
  report,
  bundle
}) {
  const parent = dirname(outputRoot);
  const transaction = randomUUID();
  const stage = join(parent, `.${basename(outputRoot)}.${transaction}.tmp`);
  const backup = join(parent, `.${basename(outputRoot)}.${transaction}.bak`);
  let oldTreeBackedUp = false;
  let preserveBackup = false;

  try {
    await mkdir(stage, { recursive: false, mode: 0o700 });
    await cp(sourceJsonPath, join(stage, "report.json"));
    await cp(markdownPath, join(stage, "report.md"));
    await writeFile(join(stage, "paste-summary.txt"), renderPasteSummary(report), "utf8");

    const retainedBundlePath = bundle?.outputPath
      ? join(outputRoot, basename(bundle.outputPath))
      : null;
    const retainedChecksumPath = bundle?.checksumPath
      ? join(outputRoot, basename(bundle.checksumPath))
      : null;
    if (bundle?.outputPath) {
      await cp(bundle.outputPath, join(stage, basename(bundle.outputPath)));
    }
    if (bundle?.checksumPath) {
      await cp(bundle.checksumPath, join(stage, basename(bundle.checksumPath)));
    }

    const receipt = {
      schemaVersion: "kova.releaseGate.retainedArtifacts.v1",
      generatedAt: new Date().toISOString(),
      runId: report.runId,
      verdict: report.gate?.verdict ?? null,
      outputDir: outputRoot,
      reportPath: join(outputRoot, "report.md"),
      jsonPath: join(outputRoot, "report.json"),
      pasteSummaryPath: join(outputRoot, "paste-summary.txt"),
      bundlePath: retainedBundlePath,
      checksumPath: retainedChecksumPath
    };
    // The receipt is the retained tree's commit marker and is written only
    // after every referenced artifact is present in the staging directory.
    await writeFile(join(stage, "retained-artifacts.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    if (await pathExists(outputRoot)) {
      await rename(outputRoot, backup);
      oldTreeBackedUp = true;
    }
    await rename(stage, outputRoot);
    // Publication commits at the directory rename. Cleanup cannot safely
    // restore a backup once recursive deletion may have started.
    oldTreeBackedUp = false;
    preserveBackup = true;
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    return receipt;
  } catch (error) {
    const rollbackErrors = [];
    if (oldTreeBackedUp) {
      await rename(backup, outputRoot).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      preserveBackup = true;
      throw new AggregateError([error, ...rollbackErrors], "retained artifact publication failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (!preserveBackup) {
      await rm(backup, { recursive: true, force: true });
    }
  }
}

async function writeDurableFile(path, content) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireRegularFile(path, label) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing: ${path}`);
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
