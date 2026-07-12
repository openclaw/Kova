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
  const snapshot = await snapshotReportSet(sourceJsonPath);
  const report = JSON.parse(snapshot.json.toString("utf8"));
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
    await writeDurableFile(join(stage, "report.json"), snapshot.json);

    const markdownPath = snapshot.markdownPath;
    const included = {
      reportJson: true,
      reportMarkdown: true,
      pasteSummary: true,
      runArtifacts: false,
      artifactIndex: true
    };

    await writeDurableFile(join(stage, "report.md"), snapshot.markdown);

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
    await withFileLock(join(outputRoot, `${bundleName}.publication.lock`), async () => {
      await cleanupOrphanBundleChecksums(outputRoot, bundleName);
      await publishBundlePair({
        archive,
        outputPath,
        checksumPath,
        checksum: `${sha256}  ${basename(outputPath)}\n`
      });
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
  const snapshot = await snapshotReportSet(sourceJsonPath);
  const report = JSON.parse(snapshot.json.toString("utf8"));
  if (!report.runId) {
    throw new Error("report is missing runId");
  }

  const outputRoot = options.outputDir
    ? resolve(options.outputDir)
    : join(artifactsDir, "release-gates", safeRunIdSegment(report.runId));
  await mkdir(dirname(outputRoot), { recursive: true });

  const hasBundle = Boolean(bundle?.outputPath);
  const hasChecksum = Boolean(bundle?.checksumPath);
  if (hasBundle !== hasChecksum) {
    throw new Error("retained report bundle requires both archive and checksum");
  }
  if (hasBundle) {
    await requireRegularFile(bundle.outputPath, "report bundle");
    await requireRegularFile(bundle.checksumPath, "report bundle checksum");
    await validateBundlePair(bundle.outputPath, bundle.checksumPath);
  }

  const lockPath = `${outputRoot}.lock`;
  return withFileLock(lockPath, () => replaceRetainedArtifactTree({
    outputRoot,
    sourceJson: snapshot.json,
    markdown: snapshot.markdown,
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
  if (dirname(outputPath) !== dirname(checksumPath)) {
    throw new Error("report bundle and checksum must share one publication directory");
  }
  return withFileLock(`${outputPath}.lock`, () => publishBundlePairLocked({
    archive,
    outputPath,
    checksumPath,
    checksum
  }));
}

async function publishBundlePairLocked({ archive, outputPath, checksumPath, checksum }) {
  const entries = [
    { path: outputPath, content: archive },
    { path: checksumPath, content: checksum }
  ];
  const staged = entries.map((entry) => ({
    ...entry,
    stagedPath: `${entry.path}.${randomUUID()}.tmp`
  }));
  let archivePublished = false;
  let checksumPublished = false;
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
      if (
        (existingHash !== null && existingHash !== expectedHash) ||
        (existingChecksum !== null && existingChecksum !== checksum)
      ) {
        throw new Error(`bundle destination collision: ${outputPath}`);
      }
      if (!checksumExists && outputExists) {
        await rename(staged[1].stagedPath, checksumPath);
        await syncDirectory(dirname(outputPath));
      } else if (!outputExists && checksumExists) {
        await rename(staged[0].stagedPath, outputPath);
        await syncDirectory(dirname(outputPath));
      }
      return;
    }
    await rename(staged[1].stagedPath, checksumPath);
    checksumPublished = true;
    await syncDirectory(dirname(outputPath));
    // The archive is the bundle commit marker. A checksum-only crash state is
    // harmless and is completed by the recovery branch above.
    await rename(staged[0].stagedPath, outputPath);
    archivePublished = true;
    await syncDirectory(dirname(outputPath));
  } catch (error) {
    if (archivePublished) {
      await rm(outputPath, { force: true });
    }
    if (checksumPublished) {
      await rm(checksumPath, { force: true });
    }
    await syncDirectory(dirname(outputPath)).catch(() => {});
    throw error;
  } finally {
    await Promise.all(staged.map((entry) => rm(entry.stagedPath, { force: true }).catch(() => {})));
  }
}

async function replaceRetainedArtifactTree({
  outputRoot,
  sourceJson,
  markdown,
  report,
  bundle
}) {
  const parent = dirname(outputRoot);
  const transaction = randomUUID();
  const stage = join(parent, `.${basename(outputRoot)}.${transaction}.tmp`);
  const backup = join(parent, `.${basename(outputRoot)}.bak`);
  const backupMarker = `${backup}.owner`;
  let oldTreeBackedUp = false;
  let newTreePublished = false;

  try {
    await recoverRetainedArtifactTree(outputRoot, backup, backupMarker);
    await assertManagedRetentionDirectory(outputRoot);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    await writeDurableFile(join(stage, "report.json"), sourceJson);
    await writeDurableFile(join(stage, "report.md"), markdown);
    await writeDurableFile(join(stage, "paste-summary.txt"), renderPasteSummary(report));

    const retainedBundlePath = bundle?.outputPath
      ? join(outputRoot, basename(bundle.outputPath))
      : null;
    const retainedChecksumPath = bundle?.checksumPath
      ? join(outputRoot, basename(bundle.checksumPath))
      : null;
    if (bundle?.outputPath) {
      await cp(bundle.outputPath, join(stage, basename(bundle.outputPath)));
      await syncFile(join(stage, basename(bundle.outputPath)));
    }
    if (bundle?.checksumPath) {
      await cp(bundle.checksumPath, join(stage, basename(bundle.checksumPath)));
      await syncFile(join(stage, basename(bundle.checksumPath)));
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
    await writeDurableFile(
      join(stage, "retained-artifacts.json"),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    await syncDirectory(stage);

    if (await pathExists(outputRoot)) {
      await writeDurableMarker(backupMarker, `${JSON.stringify({
        schemaVersion: "kova.retainedArtifactBackup.v1",
        outputRoot
      })}\n`);
      await rename(outputRoot, backup);
      oldTreeBackedUp = true;
      await syncDirectory(parent);
    }
    await rename(stage, outputRoot);
    newTreePublished = true;
    await syncDirectory(parent);
    // Publication commits at the directory rename. Cleanup cannot safely
    // restore a backup once recursive deletion may have started.
    oldTreeBackedUp = false;
    newTreePublished = false;
    await rm(backup, { recursive: true, force: true })
      .then(() => rm(backupMarker, { force: true }))
      .then(() => syncDirectory(parent))
      .catch(() => {});
    return receipt;
  } catch (error) {
    const rollbackErrors = [];
    if (newTreePublished) {
      await rm(outputRoot, { recursive: true, force: true })
        .then(() => syncDirectory(parent))
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (oldTreeBackedUp) {
      await rename(backup, outputRoot)
        .then(() => rm(backupMarker, { force: true }))
        .then(() => syncDirectory(parent))
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "retained artifact publication failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (!await pathExists(backup)) {
      await removeOwnedBackupMarker(backupMarker, outputRoot);
    }
  }
}

async function recoverRetainedArtifactTree(outputRoot, backup, backupMarker) {
  if (!await pathExists(backup)) {
    await removeOwnedBackupMarker(backupMarker, outputRoot);
    return;
  }
  await requireOwnedBackupMarker(backupMarker, outputRoot);
  if (!await pathExists(outputRoot)) {
    await assertManagedRetentionDirectory(backup, outputRoot);
    await rename(backup, outputRoot);
    await rm(backupMarker, { force: true });
    await syncDirectory(dirname(outputRoot));
    return;
  }
  await assertManagedRetentionDirectory(outputRoot);
  try {
    await assertManagedRetentionDirectory(outputRoot, outputRoot, true);
    await rm(backup, { recursive: true });
    await rm(backupMarker, { force: true });
    await syncDirectory(dirname(outputRoot));
    return;
  } catch {
    // The current tree is Kova-managed but incomplete; restore the prior
    // committed tree only after proving the backup is valid.
  }
  await assertManagedRetentionDirectory(backup, outputRoot);
  await rm(outputRoot, { recursive: true });
  await rename(backup, outputRoot);
  await rm(backupMarker, { force: true });
  await syncDirectory(dirname(outputRoot));
}

async function requireOwnedBackupMarker(path, outputRoot) {
  let marker;
  try {
    const info = await lstat(path);
    if (!info.isFile()) {
      throw new Error("not a regular file");
    }
    marker = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`retained artifact backup is not Kova-managed: ${path}`);
  }
  if (
    marker?.schemaVersion !== "kova.retainedArtifactBackup.v1" ||
    resolve(marker.outputRoot ?? "") !== resolve(outputRoot)
  ) {
    throw new Error(`retained artifact backup is not Kova-managed: ${path}`);
  }
}

async function removeOwnedBackupMarker(path, outputRoot) {
  if (!await pathExists(path)) {
    return;
  }
  await requireOwnedBackupMarker(path, outputRoot);
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function assertManagedRetentionDirectory(path, expectedOutputRoot = path, requireComplete = false) {
  if (!await pathExists(path)) {
    return;
  }
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new Error(`retained artifact destination is not a directory: ${path}`);
  }
  const entries = await readdir(path);
  if (entries.length === 0) {
    if (requireComplete) {
      throw new Error(`retained artifact destination is incomplete: ${path}`);
    }
    return;
  }
  const receiptPath = join(path, "retained-artifacts.json");
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    throw new Error(`retained artifact destination must be empty or Kova-managed: ${path}`);
  }
  if (
    receipt?.schemaVersion !== "kova.releaseGate.retainedArtifacts.v1" ||
    resolve(receipt.outputDir ?? "") !== resolve(expectedOutputRoot) ||
    resolve(receipt.reportPath ?? "") !== resolve(expectedOutputRoot, "report.md") ||
    resolve(receipt.jsonPath ?? "") !== resolve(expectedOutputRoot, "report.json") ||
    resolve(receipt.pasteSummaryPath ?? "") !== resolve(expectedOutputRoot, "paste-summary.txt")
  ) {
    throw new Error(`retained artifact destination must be empty or Kova-managed: ${path}`);
  }
  const managedEntries = new Set([
    "retained-artifacts.json",
    "report.json",
    "report.md",
    "paste-summary.txt"
  ]);
  for (const artifactPath of [receipt.bundlePath, receipt.checksumPath]) {
    if (!artifactPath) {
      continue;
    }
    const resolvedArtifactPath = resolve(artifactPath);
    if (dirname(resolvedArtifactPath) !== resolve(expectedOutputRoot)) {
      throw new Error(`retained artifact destination must be empty or Kova-managed: ${path}`);
    }
    managedEntries.add(basename(resolvedArtifactPath));
  }
  for (const entry of entries) {
    const info = await lstat(join(path, entry));
    if (!managedEntries.has(entry) || !info.isFile()) {
      throw new Error(`retained artifact destination contains unmanaged files: ${path}`);
    }
  }
  if (requireComplete) {
    for (const entry of managedEntries) {
      if (!entries.includes(entry)) {
        throw new Error(`retained artifact destination is incomplete: ${path}`);
      }
    }
    const hasBundle = Boolean(receipt.bundlePath);
    const hasChecksum = Boolean(receipt.checksumPath);
    if (hasBundle !== hasChecksum) {
      throw new Error(`retained artifact destination has an incomplete bundle pair: ${path}`);
    }
    if (hasBundle) {
      await validateBundlePair(
        join(path, basename(receipt.bundlePath)),
        join(path, basename(receipt.checksumPath))
      );
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

async function writeDurableMarker(path, content) {
  const stagedPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeDurableFile(stagedPath, content);
    await rename(stagedPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(stagedPath, { force: true });
  }
}

async function syncDirectory(path) {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function snapshotReportSet(sourceJsonPath) {
  const markdownPath = siblingMarkdownPath(sourceJsonPath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await requireRegularFile(sourceJsonPath, "report JSON");
    await requireRegularFile(markdownPath, "report Markdown");
    const before = await lstat(sourceJsonPath);
    const markdownBefore = await lstat(markdownPath);
    const json = await readFile(sourceJsonPath);
    const markdown = await readFile(markdownPath);
    const committedJson = await readFile(sourceJsonPath);
    const after = await lstat(sourceJsonPath);
    const markdownAfter = await lstat(markdownPath);
    if (
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      markdownBefore.dev === markdownAfter.dev &&
      markdownBefore.ino === markdownAfter.ino &&
      markdownBefore.size === markdownAfter.size &&
      markdownBefore.mtimeMs === markdownAfter.mtimeMs &&
      json.equals(committedJson)
    ) {
      return { json, markdown, markdownPath };
    }
  }
  throw new Error(`report changed while publication snapshot was being captured: ${sourceJsonPath}`);
}

async function cleanupOrphanBundleChecksums(outputRoot, bundleName) {
  const prefix = `${bundleName}-`;
  const suffix = ".tar.gz.sha256";
  for (const name of await readdir(outputRoot)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
      continue;
    }
    const checksumPath = join(outputRoot, name);
    const archivePath = checksumPath.slice(0, -".sha256".length);
    if (!await pathExists(archivePath)) {
      await rm(checksumPath, { force: true });
    }
  }
  await syncDirectory(outputRoot);
}

async function validateBundlePair(archivePath, checksumPath) {
  const [archive, checksum] = await Promise.all([
    readFile(archivePath),
    readFile(checksumPath, "utf8")
  ]);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const expected = `${sha256}  ${basename(archivePath)}\n`;
  if (checksum !== expected) {
    throw new Error(`report bundle checksum does not match archive: ${archivePath}`);
  }
}

async function requireRegularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
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
