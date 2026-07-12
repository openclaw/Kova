import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { withFileLock } from "../file-lock.mjs";
import { artifactsDir } from "../paths.mjs";
import { artifactRunIdSegment, isCanonicalRunId } from "./artifact-names.mjs";
import { renderPasteSummary } from "./report.mjs";

const RESERVED_RETAINED_FILENAMES = new Set([
  "paste-summary.txt",
  "report.json",
  "report.md",
  "retained-artifacts.json"
]);

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

  const bundleName = `${artifactRunIdSegment(runId)}-bundle`;
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
    : join(artifactsDir, "release-gates", artifactRunIdSegment(report.runId));
  await mkdir(dirname(outputRoot), { recursive: true });

  const hasBundle = Boolean(bundle?.outputPath);
  const hasChecksum = Boolean(bundle?.checksumPath);
  if (hasBundle !== hasChecksum) {
    throw new Error("retained report bundle requires both archive and checksum");
  }
  if (hasBundle) {
    if (bundle.runId !== report.runId) {
      throw new Error(`retained report bundle run ID does not match report: ${bundle.runId ?? "missing"}`);
    }
    const retainedFilenames = [
      basename(bundle.outputPath),
      basename(bundle.checksumPath)
    ];
    const retainedFilenameKeys = retainedFilenames.map(portableRetentionFilenameKey);
    if (new Set(retainedFilenameKeys).size !== retainedFilenameKeys.length) {
      throw new Error("retained report bundle and checksum must use distinct filenames");
    }
    if (retainedFilenameKeys.some((name) => RESERVED_RETAINED_FILENAMES.has(name))) {
      throw new Error("retained report bundle filenames conflict with reserved retained artifacts");
    }
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

function portableRetentionFilenameKey(value) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value.endsWith(".") ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)
  ) {
    throw new Error("retained report bundle filenames must use portable filenames");
  }
  return value.toLowerCase();
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
      await copyDurableFile(bundle.outputPath, join(stage, basename(bundle.outputPath)));
    }
    if (bundle?.checksumPath) {
      await copyDurableFile(bundle.checksumPath, join(stage, basename(bundle.checksumPath)));
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
      const treeSha256 = await retainedArtifactTreeDigest(outputRoot);
      const claimId = randomUUID();
      await writeDurableMarker(backupMarker, `${JSON.stringify({
        schemaVersion: "kova.retainedArtifactBackup.v3",
        outputRoot,
        treeSha256,
        claimId,
        phase: "pending"
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
    await removeRetainedBackup(backup, backupMarker, outputRoot, parent).catch(() => {});
    return receipt;
  } catch (error) {
    const rollbackErrors = [];
    if (newTreePublished) {
      await rm(outputRoot, { recursive: true, force: true })
        .then(() => syncDirectory(parent))
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (oldTreeBackedUp) {
      await restoreRetainedBackup(backup, outputRoot, backupMarker, parent)
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "retained artifact publication failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await removeUnusedRetainedBackupMarker(backup, backupMarker, outputRoot);
  }
}

async function recoverRetainedArtifactTree(outputRoot, backup, backupMarker) {
  const marker = await readRetainedBackupMarker(backupMarker, outputRoot);
  if (!marker) {
    if (await retainedBackupStateExists(backup)) {
      throw new Error(`retained artifact backup is not Kova-managed: ${backup}`);
    }
    return;
  }
  const claimedBackup = await claimRetainedBackup(backup, marker, outputRoot, dirname(outputRoot));
  if (!claimedBackup) {
    await removeOwnedBackupMarker(backupMarker, outputRoot);
    return;
  }
  if (claimedBackup.empty) {
    await assertCompletedRetainedClaim(outputRoot, claimedBackup);
    await removeEmptyRetainedClaim(claimedBackup.container, backupMarker, dirname(outputRoot));
    return;
  }
  if (claimedBackup.partial) {
    await finishRetainedClaimCleanup(claimedBackup, backupMarker, dirname(outputRoot));
    return;
  }
  if (!await pathExists(outputRoot)) {
    await restoreClaimedRetainedBackup(
      claimedBackup,
      outputRoot,
      backupMarker,
      dirname(outputRoot)
    );
    return;
  }
  await assertManagedRetentionDirectory(outputRoot);
  let currentComplete = true;
  try {
    await assertManagedRetentionDirectory(outputRoot, outputRoot, true);
  } catch {
    currentComplete = false;
    // The current tree is Kova-managed but incomplete; restore the prior
    // committed tree only after proving the backup is valid.
  }
  if (currentComplete) {
    await removeClaimedRetainedBackup(
      claimedBackup,
      backupMarker,
      dirname(outputRoot)
    );
    return;
  }
  await rm(outputRoot, { recursive: true });
  await restoreClaimedRetainedBackup(
    claimedBackup,
    outputRoot,
    backupMarker,
    dirname(outputRoot)
  );
}

async function removeRetainedBackup(backup, backupMarker, outputRoot, parent) {
  const marker = await readRetainedBackupMarker(backupMarker, outputRoot);
  if (!marker) {
    if (await retainedBackupStateExists(backup)) {
      throw new Error(`retained artifact backup is not Kova-managed: ${backup}`);
    }
    return;
  }
  const claimedBackup = await claimRetainedBackup(backup, marker, outputRoot, parent);
  if (!claimedBackup) {
    await removeOwnedBackupMarker(backupMarker, outputRoot);
    return;
  }
  if (claimedBackup.empty) {
    await assertCompletedRetainedClaim(outputRoot, claimedBackup);
    await removeEmptyRetainedClaim(claimedBackup.container, backupMarker, parent);
    return;
  }
  if (claimedBackup.partial) {
    await finishRetainedClaimCleanup(claimedBackup, backupMarker, parent);
    return;
  }
  await removeClaimedRetainedBackup(claimedBackup, backupMarker, parent);
}

async function removeClaimedRetainedBackup(claimedBackup, backupMarker, parent) {
  // The owner marker must outlive the backup directory on durable storage.
  // Recovery rejects a backup whose marker disappeared first.
  await validateClaimedRetainedBackup(claimedBackup);
  await assertManagedRetentionDirectory(claimedBackup.outputRoot, claimedBackup.outputRoot, true);
  await writeRetainedBackupPhase(backupMarker, claimedBackup.marker, "cleanup");
  await finishRetainedClaimCleanup(claimedBackup, backupMarker, parent);
}

async function restoreRetainedBackup(backup, outputRoot, backupMarker, parent) {
  const marker = await requireOwnedBackupMarker(backupMarker, outputRoot);
  const claimedBackup = await claimRetainedBackup(backup, marker, outputRoot, parent);
  if (!claimedBackup) {
    throw new Error(`retained artifact backup is missing: ${backup}`);
  }
  if (claimedBackup.empty) {
    await assertCompletedRetainedClaim(outputRoot, claimedBackup);
    await removeEmptyRetainedClaim(claimedBackup.container, backupMarker, parent);
    return;
  }
  if (claimedBackup.partial) {
    await finishRetainedClaimCleanup(claimedBackup, backupMarker, parent);
    return;
  }
  await restoreClaimedRetainedBackup(claimedBackup, outputRoot, backupMarker, parent);
}

async function restoreClaimedRetainedBackup(claimedBackup, outputRoot, backupMarker, parent) {
  await validateClaimedRetainedBackup(claimedBackup);
  await rename(claimedBackup.path, outputRoot);
  await rmdir(claimedBackup.container);
  await syncDirectory(parent);
  await rm(backupMarker, { force: true });
  await syncDirectory(parent);
}

async function removeEmptyRetainedClaim(claimContainer, backupMarker, parent) {
  await assertEmptyRetainedClaimContainer(claimContainer);
  await rmdir(claimContainer);
  await syncDirectory(parent);
  await rm(backupMarker, { force: true });
  await syncDirectory(parent);
}

async function readRetainedBackupMarker(path, outputRoot) {
  if (!await pathExists(path)) {
    return null;
  }
  return requireOwnedBackupMarker(path, outputRoot);
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
    marker?.schemaVersion !== "kova.retainedArtifactBackup.v3" ||
    resolve(marker.outputRoot ?? "") !== resolve(outputRoot) ||
    !/^[a-f0-9]{64}$/.test(marker.treeSha256 ?? "") ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      marker.claimId ?? ""
    ) ||
    !["pending", "cleanup"].includes(marker.phase)
  ) {
    throw new Error(`retained artifact backup is not Kova-managed: ${path}`);
  }
  return marker;
}

async function claimRetainedBackup(backup, marker, outputRoot, parent) {
  const claimContainer = retainedBackupClaimContainer(backup, marker);
  const claimPath = join(claimContainer, "tree");
  const backupExists = await pathExists(backup);
  const containerExists = await pathExists(claimContainer);
  if (!backupExists && !containerExists) {
    return null;
  }
  if (!containerExists) {
    await mkdir(claimContainer, { recursive: false, mode: 0o700 });
    await syncDirectory(parent);
  }
  await assertRetainedClaimContainer(claimContainer);
  const claimExists = await pathExists(claimPath);
  if (backupExists && claimExists) {
    throw new Error(`retained artifact backup has a conflicting replacement: ${backup}`);
  }
  if (!backupExists && !claimExists) {
    return {
      container: claimContainer,
      path: null,
      empty: true,
      outputRoot,
      treeSha256: marker.treeSha256
    };
  }
  if (backupExists) {
    await rename(backup, claimPath);
    await syncDirectory(claimContainer);
    await syncDirectory(parent);
  }
  try {
    await assertManagedRetentionDirectory(claimPath, outputRoot);
    if (await retainedArtifactTreeDigest(claimPath) !== marker.treeSha256) {
      throw new Error("tree digest mismatch");
    }
  } catch {
    if (marker.phase === "cleanup") {
      return {
        container: claimContainer,
        path: claimPath,
        empty: false,
        partial: true,
        outputRoot,
        treeSha256: marker.treeSha256,
        marker
      };
    }
    throw new Error(`retained artifact backup is not Kova-managed: ${claimPath}`);
  }
  return {
    container: claimContainer,
    path: claimPath,
    empty: false,
    partial: false,
    outputRoot,
    treeSha256: marker.treeSha256,
    marker
  };
}

function retainedBackupClaimContainer(backup, marker) {
  return `${backup}.claim-${marker.claimId}`;
}

async function assertRetainedClaimContainer(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new Error(`retained artifact backup claim is invalid: ${path}`);
  }
  const names = await readdir(path);
  if (names.some((name) => name !== "tree")) {
    throw new Error(`retained artifact backup claim is invalid: ${path}`);
  }
}

async function assertEmptyRetainedClaimContainer(path) {
  await assertRetainedClaimContainer(path);
  if ((await readdir(path)).length !== 0) {
    throw new Error(`retained artifact backup claim is not empty: ${path}`);
  }
}

async function validateClaimedRetainedBackup(claimedBackup) {
  // The 0700 claim container and retention lock exclude peer Kova writers.
  // Revalidate immediately before mutation; same-user hostile writers are outside the trust boundary.
  await assertRetainedClaimContainer(claimedBackup.container);
  try {
    await assertManagedRetentionDirectory(claimedBackup.path, claimedBackup.outputRoot);
    if (await retainedArtifactTreeDigest(claimedBackup.path) !== claimedBackup.treeSha256) {
      throw new Error("tree digest mismatch");
    }
  } catch {
    throw new Error(`retained artifact backup is not Kova-managed: ${claimedBackup.path}`);
  }
}

async function assertCompletedRetainedClaim(outputRoot, claimedBackup) {
  if (!await pathExists(outputRoot)) {
    throw new Error(`retained artifact backup claim is incomplete: ${claimedBackup.container}`);
  }
  try {
    if (await retainedArtifactTreeDigest(outputRoot) === claimedBackup.treeSha256) {
      return;
    }
  } catch {
    // A different current tree still qualifies if it is a complete committed generation.
  }
  await assertManagedRetentionDirectory(outputRoot, outputRoot, true);
}

async function writeRetainedBackupPhase(path, marker, phase) {
  await writeDurableMarker(path, `${JSON.stringify({ ...marker, phase })}\n`);
}

async function finishRetainedClaimCleanup(claimedBackup, backupMarker, parent) {
  if (!await pathExists(claimedBackup.outputRoot)) {
    throw new Error(`retained artifact cleanup is missing current tree: ${claimedBackup.outputRoot}`);
  }
  await assertManagedRetentionDirectory(
    claimedBackup.outputRoot,
    claimedBackup.outputRoot,
    true
  );
  await assertRetainedClaimContainer(claimedBackup.container);
  await rm(claimedBackup.path, { recursive: true, force: true });
  await rmdir(claimedBackup.container);
  await syncDirectory(parent);
  await rm(backupMarker, { force: true });
  await syncDirectory(parent);
}

async function retainedBackupStateExists(backup) {
  if (await pathExists(backup)) {
    return true;
  }
  const names = await readdir(dirname(backup));
  const prefix = `${basename(backup)}.claim-`;
  return names.some((name) => name.startsWith(prefix));
}

async function removeOwnedBackupMarker(path, outputRoot) {
  if (!await pathExists(path)) {
    return;
  }
  await requireOwnedBackupMarker(path, outputRoot);
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function removeUnusedRetainedBackupMarker(backup, backupMarker, outputRoot) {
  const marker = await readRetainedBackupMarker(backupMarker, outputRoot);
  if (!marker) {
    return;
  }
  if (
    await pathExists(backup) ||
    await pathExists(retainedBackupClaimContainer(backup, marker))
  ) {
    return;
  }
  await removeOwnedBackupMarker(backupMarker, outputRoot);
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

export async function retainedArtifactTreeDigest(path) {
  const digest = createHash("sha256");
  const entries = (await readdir(path)).toSorted();
  for (const entry of entries) {
    const entryPath = join(path, entry);
    const info = await lstat(entryPath);
    if (!info.isFile()) {
      throw new Error(`retained artifact tree contains a non-file entry: ${entryPath}`);
    }
    const content = await readFile(entryPath);
    digest.update(`${entry}\0${content.length}\0`);
    digest.update(content);
  }
  return digest.digest("hex");
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
  // Windows FlushFileBuffers requires a writable handle. These are staged
  // copies owned by this transaction, so opening them read/write is safe.
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyDurableFile(source, destination) {
  await cp(source, destination);
  // The staged copy belongs to this transaction. Normalize its mode so a
  // read-only source cannot prevent the durability sync.
  await chmod(destination, 0o600);
  await syncFile(destination);
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
    const digest = name.slice(prefix.length, -suffix.length);
    if (!/^[a-f0-9]{64}$/.test(digest)) {
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
