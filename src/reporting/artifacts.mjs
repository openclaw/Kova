import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack as packTar } from "tar-stream";
import { withFileLock } from "../file-lock.mjs";
import { artifactsDir } from "../paths.mjs";
import { reportTransactionLockPath } from "../run/report-output.mjs";
import { artifactRunIdSegment, isCanonicalRunId } from "./artifact-names.mjs";
import { renderPasteSummary } from "./report.mjs";

const RESERVED_RETAINED_FILENAMES = new Set([
  "paste-summary.txt",
  "report.json",
  "report.md",
  "retained-artifacts.json"
]);
const MAX_BUNDLE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_BUNDLE_CHECKSUM_BYTES = 8 * 1024;
const MAX_USTAR_FILE_BYTES = 0o77777777777;
const FILE_READ_CHUNK_BYTES = 1024 * 1024;
const READ_ONLY_NONBLOCK =
  fsConstants.O_RDONLY |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

export async function bundleReport(reportPath, options = {}) {
  const sourceJsonPath = resolve(reportPath);
  const snapshot = await snapshotReportSet(sourceJsonPath);
  const report = JSON.parse(snapshot.json.toString("utf8"));
  const runId = report.runId;
  if (!runId) {
    throw new Error("report is missing runId");
  }

  const outputRoot = options.outputDir ? resolve(options.outputDir) : join(artifactsDir, "bundles");
  const sourceArtifactsRoot = options.artifactsDir
    ? resolve(options.artifactsDir)
    : artifactsDir;
  await mkdir(outputRoot, { recursive: true });

  const bundleName = `${artifactRunIdSegment(runId)}-bundle`;
  const publicationLock = join(outputRoot, `${bundleName}.publication.lock`);
  return withFileLock(publicationLock, async () => {
    await cleanupBundleBuildStages(outputRoot, bundleName);
    const transaction = randomUUID();
    const tmp = join(tmpdir(), `kova-artifact-bundle-${transaction}.tmp`);
    const stageOwner = `${tmp}.owner`;
    const stage = join(tmp, bundleName);
    const stagedArchivePath = join(tmp, `${bundleName}.tar.gz`);
    let tmpCreated = false;
    try {
      await writeDurableMarker(stageOwner, `${JSON.stringify({
        schemaVersion: "kova.bundleBuildStage.v1",
        transaction,
        outputRoot,
        bundleName
      })}\n`);
      await mkdir(tmp, { mode: 0o700 });
      tmpCreated = true;
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
      await writeFile(
        join(stage, "paste-summary.txt"),
        renderPasteSummary(report),
        "utf8"
      );

      const runArtifactsPath = isCanonicalRunId(runId)
        ? join(sourceArtifactsRoot, runId)
        : null;
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
      await writeFile(
        join(stage, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8"
      );
      const artifactIndex = await buildArtifactIndex(stage, bundleName);
      await writeFile(
        join(stage, "artifact-index.json"),
        `${JSON.stringify(artifactIndex, null, 2)}\n`,
        "utf8"
      );
      await writeUstarArchive(stage, bundleName, stagedArchivePath);

      const archive = await readStableRegularFile(
        stagedArchivePath,
        "generated report bundle",
        MAX_BUNDLE_ARCHIVE_BYTES
      );
      const sha256 = createHash("sha256").update(archive).digest("hex");
      const outputPath = join(outputRoot, `${bundleName}-${sha256}.tar.gz`);
      const checksumPath = `${outputPath}.sha256`;
      await cleanupOrphanBundlePublications(outputRoot, bundleName);
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
      if (tmpCreated) {
        await rm(tmp, { recursive: true, force: true });
      }
      await rm(stageOwner, { force: true });
      await syncDirectory(tmpdir()).catch(() => {});
    }
  });
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
  }

  const lockPath = `${outputRoot}.lock`;
  return withFileLock(lockPath, async () => {
    const bundleSnapshot = hasBundle
      ? await readVerifiedBundlePair(bundle.outputPath, bundle.checksumPath)
      : null;
    return replaceRetainedArtifactTree({
      outputRoot,
      sourceJson: snapshot.json,
      markdown: snapshot.markdown,
      report,
      bundle,
      bundleSnapshot
    });
  });
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
  const entries = await listFiles(stage, stage, bundleName);
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

async function listFiles(root, dir, bundleName) {
  const names = await readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const name of names.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      entries.push(...await listFiles(root, path, bundleName));
      continue;
    }
    if (!name.isFile()) {
      throw new Error(`report bundle contains an unsupported filesystem entry: ${path}`);
    }
    const info = await lstat(path);
    if (info.size > MAX_USTAR_FILE_BYTES) {
      throw new Error(`report bundle file exceeds the portable USTAR size limit: ${path}`);
    }
    const metadata = await hashFile(path);
    const bundlePath = relative(root, path).split(sep).join("/");
    entries.push({
      path: bundlePath,
      archivePath: archivePathFor(bundleName, bundlePath),
      bytes: metadata.bytes,
      sha256: metadata.sha256
    });
  }
  return entries;
}

async function writeUstarArchive(stage, bundleName, destination) {
  const files = await listFiles(stage, stage, bundleName);
  const archivePaths = new Set();
  const pack = packTar();
  const output = pipeline(
    pack,
    createGzip({ level: 9 }),
    createWriteStream(destination, { flags: "wx", mode: 0o600 })
  );
  try {
    for (const file of files) {
      if (archivePaths.has(file.archivePath)) {
        throw new Error(`report bundle archive path collision: ${file.archivePath}`);
      }
      archivePaths.add(file.archivePath);
      const source = join(stage, ...file.path.split("/"));
      const entry = pack.entry({
        name: `${bundleName}/${file.archivePath}`,
        type: "file",
        mode: 0o600,
        uid: 0,
        gid: 0,
        size: file.bytes,
        mtime: new Date(0)
      });
      await pipeline(createReadStream(source), entry);
    }
    pack.finalize();
    await output;
  } catch (error) {
    pack.destroy(error);
    await output.catch(() => {});
    throw error;
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function archivePathFor(bundleName, bundlePath) {
  // `mapped/` is owned by the archiver. Remap any future source path that
  // enters that namespace so original and generated paths cannot collide.
  if (!bundlePath.startsWith("mapped/") && isUstarPath(`${bundleName}/${bundlePath}`)) {
    return bundlePath;
  }
  return `mapped/${createHash("sha256").update(bundlePath).digest("hex")}`;
}

function isUstarPath(path) {
  if (Buffer.byteLength(path) !== path.length) {
    return false;
  }
  let name = path;
  let prefix = "";
  while (Buffer.byteLength(name) > 100) {
    const separator = name.indexOf("/");
    if (separator === -1) {
      return false;
    }
    prefix += prefix ? `/${name.slice(0, separator)}` : name.slice(0, separator);
    name = name.slice(separator + 1);
  }
  return Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155;
}

export async function publishBundlePair({ archive, outputPath, checksumPath, checksum }) {
  const resolvedOutputPath = resolve(outputPath);
  const resolvedChecksumPath = resolve(checksumPath);
  if (dirname(resolvedOutputPath) !== dirname(resolvedChecksumPath)) {
    throw new Error("report bundle and checksum must share one publication directory");
  }
  return withFileLock(`${resolvedOutputPath}.lock`, () => publishBundlePairLocked({
    archive,
    outputPath: resolvedOutputPath,
    checksumPath: resolvedChecksumPath,
    checksum
  }));
}

async function publishBundlePairLocked({ archive, outputPath, checksumPath, checksum }) {
  await cleanupBundlePairStages(outputPath, checksumPath);
  const transaction = randomUUID();
  const entries = [
    { path: outputPath, content: archive },
    { path: checksumPath, content: checksum }
  ];
  const staged = entries.map((entry) => ({
    ...entry,
    stagedPath: `${entry.path}.${transaction}.tmp`
  }));
  const stageOwner = `${staged[0].stagedPath}.owner`;
  let archivePublished = false;
  let checksumPublished = false;
  let publicationFailed = false;
  try {
    await writeDurableMarker(stageOwner, `${JSON.stringify({
      schemaVersion: "kova.bundlePairStage.v1",
      transaction,
      outputPath: resolve(outputPath),
      checksumPath: resolve(checksumPath)
    })}\n`);
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
      const existing = outputExists
        ? await readStableRegularFile(
          outputPath,
          "existing report bundle",
          MAX_BUNDLE_ARCHIVE_BYTES
        )
        : null;
      const existingHash = existing ? createHash("sha256").update(existing).digest("hex") : null;
      const expectedHash = createHash("sha256").update(archive).digest("hex");
      const existingChecksum = checksumExists
        ? await readStableRegularFile(
          checksumPath,
          "existing report bundle checksum",
          MAX_BUNDLE_CHECKSUM_BYTES,
          "utf8"
        )
        : null;
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
    publicationFailed = true;
    if (archivePublished) {
      await rm(outputPath, { force: true });
    }
    if (checksumPublished) {
      await rm(checksumPath, { force: true });
    }
    await syncDirectory(dirname(outputPath)).catch(() => {});
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const entry of staged) {
      await rm(entry.stagedPath, { force: true })
        .catch((error) => cleanupErrors.push(error));
    }
    if (cleanupErrors.length === 0) {
      await rm(stageOwner, { force: true });
      await syncDirectory(dirname(outputPath)).catch(() => {});
    } else if (!publicationFailed) {
      throw new AggregateError(
        cleanupErrors,
        "report bundle publication committed but staging cleanup was incomplete"
      );
    }
  }
}

async function replaceRetainedArtifactTree({
  outputRoot,
  sourceJson,
  markdown,
  report,
  bundle,
  bundleSnapshot
}) {
  const parent = dirname(outputRoot);
  const transaction = randomUUID();
  const stage = join(parent, `.${basename(outputRoot)}.${transaction}.tmp`);
  const stageOwner = `${stage}.owner`;
  const backup = join(parent, `.${basename(outputRoot)}.bak`);
  const backupMarker = `${backup}.owner`;
  let oldTreeBackedUp = false;
  let newTreePublished = false;
  let stageCreated = false;

  try {
    await cleanupRetainedArtifactStages(outputRoot);
    await recoverRetainedArtifactTree(outputRoot, backup, backupMarker);
    await assertManagedRetentionDirectory(outputRoot);
    await writeDurableMarker(stageOwner, `${JSON.stringify({
      schemaVersion: "kova.retainedArtifactStage.v1",
      transaction,
      outputRoot
    })}\n`);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    stageCreated = true;
    await writeDurableFile(join(stage, "report.json"), sourceJson);
    await writeDurableFile(join(stage, "report.md"), markdown);
    await writeDurableFile(join(stage, "paste-summary.txt"), renderPasteSummary(report));

    const retainedBundlePath = bundle?.outputPath
      ? join(outputRoot, basename(bundle.outputPath))
      : null;
    const retainedChecksumPath = bundle?.checksumPath
      ? join(outputRoot, basename(bundle.checksumPath))
      : null;
    if (bundleSnapshot) {
      await writeDurableFile(
        join(stage, basename(bundle.outputPath)),
        bundleSnapshot.archive
      );
      await writeDurableFile(
        join(stage, basename(bundle.checksumPath)),
        bundleSnapshot.checksum
      );
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
    if (stageCreated) {
      await rm(stage, { recursive: true, force: true });
    }
    await rm(stageOwner, { force: true });
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

async function snapshotReportSet(sourceJsonPath) {
  return withFileLock(
    reportTransactionLockPath(sourceJsonPath),
    () => snapshotReportSetLocked(sourceJsonPath)
  );
}

async function snapshotReportSetLocked(sourceJsonPath) {
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

async function cleanupOrphanBundlePublications(outputRoot, bundleName) {
  const prefix = `${bundleName}-`;
  for (const name of await readdir(outputRoot)) {
    const checksumMatch = name.match(
      new RegExp(`^${escapeRegExp(prefix)}([a-f0-9]{64})[.]tar[.]gz[.]sha256$`)
    );
    if (checksumMatch) {
      const checksumPath = join(outputRoot, name);
      const archivePath = checksumPath.slice(0, -".sha256".length);
      if (!await pathExists(archivePath)) {
        await rm(checksumPath, { force: true });
      }
      continue;
    }
    if (new RegExp(
      `^${escapeRegExp(prefix)}[a-f0-9]{64}[.]tar[.]gz[.]` +
      "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}[.]tmp[.]owner$"
    ).test(name)) {
      await cleanupOwnedBundlePairStage(join(outputRoot, name), {
        outputRoot,
        bundleName
      });
    }
  }
  await syncDirectory(outputRoot);
}

async function validateBundlePair(archivePath, checksumPath) {
  await readVerifiedBundlePair(archivePath, checksumPath);
}

async function readVerifiedBundlePair(archivePath, checksumPath) {
  const [archive, checksum] = await Promise.all([
    readStableRegularFile(
      archivePath,
      "report bundle",
      MAX_BUNDLE_ARCHIVE_BYTES
    ),
    readStableRegularFile(
      checksumPath,
      "report bundle checksum",
      MAX_BUNDLE_CHECKSUM_BYTES,
      "utf8"
    )
  ]);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const expected = `${sha256}  ${basename(archivePath)}\n`;
  if (checksum !== expected) {
    throw new Error(`report bundle checksum does not match archive: ${archivePath}`);
  }
  return { archive, checksum };
}

async function readStableRegularFile(path, label, maxBytes, encoding = null) {
  let pathInfo;
  try {
    pathInfo = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing: ${path}`);
    }
    throw error;
  }
  if (!pathInfo.isFile()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
  let handle;
  try {
    handle = await open(path, READ_ONLY_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing: ${path}`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      pathInfo.dev !== before.dev ||
      pathInfo.ino !== before.ino
    ) {
      throw new Error(`${label} changed before it was read: ${path}`);
    }
    if (before.size > maxBytes) {
      throw new Error(`${label} exceeds the size limit: ${path}`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(
        Math.min(FILE_READ_CHUNK_BYTES, maxBytes + 1 - total)
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new Error(`${label} exceeds the size limit: ${path}`);
    }
    const bytes = Buffer.concat(chunks, total);
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    return encoding ? bytes.toString(encoding) : bytes;
  } finally {
    await handle.close();
  }
}

async function cleanupBundleBuildStages(outputRoot, bundleName) {
  const directory = tmpdir();
  for (const name of await readdir(directory)) {
    const match = name.match(
      /^kova-artifact-bundle-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})[.]tmp[.]owner$/
    );
    if (!match) {
      continue;
    }
    const ownerPath = join(directory, name);
    const marker = await readOwnedStageMarker(ownerPath);
    if (
      marker?.schemaVersion !== "kova.bundleBuildStage.v1" ||
      typeof marker.transaction !== "string" ||
      typeof marker.outputRoot !== "string" ||
      typeof marker.bundleName !== "string" ||
      marker.transaction !== match[1] ||
      resolve(marker.outputRoot) !== resolve(outputRoot) ||
      marker.bundleName !== bundleName
    ) {
      continue;
    }
    const stage = ownerPath.slice(0, -".owner".length);
    const info = await lstat(stage).catch(() => null);
    if (info && !isOwnedByCurrentUser(info)) {
      continue;
    }
    if (info && !info.isDirectory()) {
      throw new Error(`report bundle staging path is not a directory: ${stage}`);
    }
    if (info) {
      await rm(stage, { recursive: true });
    }
    await rm(ownerPath);
  }
  await syncDirectory(directory);
}

async function cleanupBundlePairStages(outputPath, checksumPath) {
  const directory = dirname(outputPath);
  const pattern = new RegExp(
    `^${escapeRegExp(basename(outputPath))}[.]` +
    "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}[.]tmp[.]owner$"
  );
  for (const name of await readdir(directory)) {
    if (pattern.test(name)) {
      await cleanupOwnedBundlePairStage(join(directory, name), {
        outputPath,
        checksumPath
      });
    }
  }
  await syncDirectory(directory);
}

async function cleanupOwnedBundlePairStage(ownerPath, expected) {
  const marker = await readOwnedStageMarker(ownerPath);
  const transaction = marker?.transaction;
  if (
    marker?.schemaVersion !== "kova.bundlePairStage.v1" ||
    typeof transaction !== "string" ||
    typeof marker.outputPath !== "string" ||
    typeof marker.checksumPath !== "string"
  ) {
    return;
  }
  const outputPath = resolve(marker.outputPath);
  const checksumPath = resolve(marker.checksumPath);
  const valid = (
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      transaction
    ) &&
    dirname(outputPath) === dirname(checksumPath) &&
    ownerPath === `${outputPath}.${transaction}.tmp.owner` &&
    (
      expected.outputPath === undefined ||
      outputPath === resolve(expected.outputPath)
    ) &&
    (
      expected.checksumPath === undefined ||
      checksumPath === resolve(expected.checksumPath)
    ) &&
    (
      expected.outputRoot === undefined ||
      dirname(outputPath) === resolve(expected.outputRoot)
    ) &&
    (
      expected.bundleName === undefined ||
      basename(outputPath).startsWith(`${expected.bundleName}-`)
    )
  );
  if (!valid) {
    return;
  }
  const stages = [
    `${outputPath}.${transaction}.tmp`,
    `${checksumPath}.${transaction}.tmp`
  ];
  const stageInfos = await Promise.all(
    stages.map((stage) => lstat(stage).catch(() => null))
  );
  if (stageInfos.some((info) => info && !isOwnedByCurrentUser(info))) {
    return;
  }
  for (const [index, stage] of stages.entries()) {
    const info = stageInfos[index];
    if (info && !info.isFile()) {
      throw new Error(`report bundle staging path is not a regular file: ${stage}`);
    }
    if (info) {
      await rm(stage);
    }
  }
  await rm(ownerPath);
  await syncDirectory(dirname(outputPath));
}

async function cleanupRetainedArtifactStages(outputRoot) {
  const parent = dirname(outputRoot);
  const prefix = `.${basename(outputRoot)}.`;
  for (const name of await readdir(parent)) {
    if (
      !name.startsWith(prefix) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}[.]tmp[.]owner$/.test(
        name.slice(prefix.length)
      )
    ) {
      continue;
    }
    const ownerPath = join(parent, name);
    const marker = await readOwnedStageMarker(ownerPath);
    const transaction = marker?.transaction;
    const stage = ownerPath.slice(0, -".owner".length);
    if (
      marker?.schemaVersion !== "kova.retainedArtifactStage.v1" ||
      typeof marker.outputRoot !== "string" ||
      typeof transaction !== "string" ||
      resolve(marker.outputRoot) !== resolve(outputRoot) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        transaction
      ) ||
      stage !== join(parent, `.${basename(outputRoot)}.${transaction}.tmp`)
    ) {
      continue;
    }
    const info = await lstat(stage).catch(() => null);
    if (info && !isOwnedByCurrentUser(info)) {
      continue;
    }
    if (info && !info.isDirectory()) {
      throw new Error(`retained artifact staging path is not a directory: ${stage}`);
    }
    if (info) {
      await rm(stage, { recursive: true });
    }
    await rm(ownerPath);
  }
  await syncDirectory(parent);
}

async function readOwnedStageMarker(path) {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      !isOwnedByCurrentUser(info)
    ) {
      return null;
    }
    const content = await readStableRegularFile(
      path,
      "Kova stage owner marker",
      MAX_BUNDLE_CHECKSUM_BYTES,
      "utf8"
    );
    const marker = JSON.parse(content);
    return marker && typeof marker === "object" && !Array.isArray(marker)
      ? marker
      : null;
  } catch {
    return null;
  }
}

function isOwnedByCurrentUser(info) {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
