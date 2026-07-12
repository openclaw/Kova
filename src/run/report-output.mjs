import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../file-lock.mjs";
import { buildReportSummary, renderMarkdownReport } from "../reporting/report.mjs";
import { createRunId } from "./run-id.mjs";

export function buildReportOutputPaths(reportRoot, runId, suffix = null) {
  const basename = suffix ? `${runId}-${suffix}` : runId;
  return {
    markdown: join(reportRoot, `${basename}.md`),
    json: join(reportRoot, `${basename}.json`),
    summary: join(reportRoot, `${basename}.summary.json`)
  };
}

export async function allocateReportOutputPaths(reportRoot, suffix = null) {
  await mkdir(reportRoot, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runId = createRunId();
    const outputPaths = buildReportOutputPaths(reportRoot, runId, suffix);
    const lockPath = join(reportRoot, `${runId}.lock`);
    let lockAcquired = false;
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
      lockAcquired = true;
      if (await anyPathExists(Object.values(outputPaths))) {
        await releaseReportOutputLock(lockPath);
        lockAcquired = false;
        continue;
      }
      return { runId, outputPaths, lockPath };
    } catch (error) {
      if (lockAcquired) {
        await releaseReportOutputLock(lockPath);
      }
      if (error?.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error("could not allocate a unique Kova run id after 20 attempts");
}

export async function writeReportOutputs(reportRoot, report) {
  await mkdir(reportRoot, { recursive: true });
  const entries = [
    {
      path: report.outputPaths.markdown,
      content: renderMarkdownReport(report)
    },
    {
      path: report.outputPaths.summary,
      content: `${JSON.stringify(buildReportSummary(report), null, 2)}\n`
    },
    {
      path: report.outputPaths.json,
      content: `${JSON.stringify(report, null, 2)}\n`
    }
  ];
  await replaceReportFileSet(entries, report.outputPaths.json);
}

export async function releaseReportOutputLock(lockPath) {
  if (lockPath) {
    await rm(lockPath, { force: true });
  }
}

export function reportTransactionLockPath(canonicalPath) {
  return `${reportTransactionPath(canonicalPath)}.lock`;
}

async function anyPathExists(paths) {
  for (const path of paths) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return false;
}

async function replaceReportFileSet(entries, canonicalPath) {
  const transactionPath = reportTransactionPath(canonicalPath);
  return withFileLock(reportTransactionLockPath(canonicalPath), () => (
    replaceReportFileSetLocked(entries, canonicalPath, transactionPath)
  ));
}

function reportTransactionPath(canonicalPath) {
  return join(
    dirname(canonicalPath),
    `.${basename(canonicalPath)}.kova-transaction`
  );
}

async function replaceReportFileSetLocked(entries, canonicalPath, transactionPath) {
  const transaction = randomUUID();
  const staged = entries.map((entry) => ({
    ...entry,
    stagedPath: join(dirname(entry.path), `.${transaction}-${basename(entry.path)}.tmp`),
    backupPath: join(dirname(entry.path), `.${basename(entry.path)}.kova-backup`)
  }));
  const published = [];
  let preserveBackups = false;
  let committed = false;
  let transactionMarker = null;

  await recoverReportFileSet(staged, canonicalPath, transactionPath);
  try {
    for (const entry of staged) {
      await writeDurableFile(entry.stagedPath, entry.content);
    }
    // Hash the complete generation before moving the old files. Recovery must
    // not mistake a mixed set left by an incomplete rollback for a commit.
    transactionMarker = await buildReportTransaction(staged, canonicalPath, transaction);
    await writeDurableReportTransaction(
      transactionPath,
      `${JSON.stringify(transactionMarker, null, 2)}\n`,
      staged
    );

    // Remove the canonical JSON first and publish it last. Report readers use
    // that file as the commit marker and never observe a newly partial set.
    const backupOrder = [
      ...staged.filter((entry) => entry.path === canonicalPath),
      ...staged.filter((entry) => entry.path !== canonicalPath)
    ];
    for (const entry of backupOrder) {
      if (await pathExists(entry.path)) {
        await rename(entry.path, entry.backupPath);
      }
    }
    await syncDirectories(staged);

    const publishOrder = [
      ...staged.filter((entry) => entry.path !== canonicalPath),
      ...staged.filter((entry) => entry.path === canonicalPath)
    ];
    for (const entry of publishOrder) {
      if (entry.path === canonicalPath) {
        await syncDirectories(staged);
      }
      await rename(entry.stagedPath, entry.path);
      published.push(entry);
    }
    await syncDirectories(staged);
    committed = true;
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of published.toReversed()) {
      await rm(entry.path, { force: true }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length === 0 && transactionMarker) {
      await restorePreviousReportSet(staged, transactionMarker, canonicalPath)
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
      if (rollbackErrors.length === 0) {
        await syncDirectories(staged)
          .catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      if (rollbackErrors.length === 0) {
        await rm(transactionPath, { force: true })
          .catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
    }
    await syncDirectories(staged).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length > 0) {
      preserveBackups = true;
      throw new AggregateError([error, ...rollbackErrors], "report publication failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await Promise.all(staged.map((entry) => rm(entry.stagedPath, { force: true }).catch(() => {})));
    if (committed) {
      await removeReportBackupsAndMarker(staged, transactionPath, transactionMarker).catch(() => {});
    } else if (!preserveBackups && transactionMarker) {
      await removeReportBackupsAndMarker(staged, transactionPath, transactionMarker);
    }
  }
}

async function recoverReportFileSet(entries, canonicalPath, transactionPath) {
  await rm(`${transactionPath}.tmp`, { force: true });
  const marker = await readReportTransaction(transactionPath, entries, canonicalPath);
  if (!marker && !await reportBackupStateExists(entries)) {
    return;
  }

  if (!marker) {
    throw new Error(`report backup is missing transaction marker: ${entries[0].backupPath}`);
  }

  if (await currentReportMatchesTransaction(entries, marker)) {
    await removeReportBackupsAndMarker(entries, transactionPath, marker);
    return;
  }

  await restorePreviousReportSet(entries, marker, canonicalPath);
  await syncDirectories(entries);
  await rm(transactionPath, { force: true });
  await syncDirectories(entries);
}

async function restorePreviousReportSet(entries, marker, canonicalPath) {
  const claimedBackups = await claimReportBackups(entries, marker, "restore");
  const previousFiles = new Map(marker.previousFiles.map((entry) => [entry.name, entry.sha256]));
  const backedUpNames = new Set(claimedBackups.map((entry) => basename(entry.path)));
  for (const entry of entries) {
    const name = basename(entry.path);
    const previousHash = previousFiles.get(name);
    if (backedUpNames.has(name)) {
      continue;
    }
    if (!previousHash) {
      await rm(entry.path, { force: true });
      continue;
    }
    const info = await lstat(entry.path).catch(() => null);
    if (!info?.isFile() || await fileSha256(entry.path) !== previousHash) {
      throw new Error(`report prior file does not match transaction marker: ${entry.path}`);
    }
  }

  await restoreReportBackups(claimedBackups, canonicalPath);
}

async function restoreReportBackups(claimedBackups, canonicalPath) {
  const restoreOrder = [
    ...claimedBackups.filter((entry) => entry.path !== canonicalPath),
    ...claimedBackups.filter((entry) => entry.path === canonicalPath)
  ];
  for (const entry of restoreOrder) {
    await validateClaimedReportBackup(entry);
    await rm(entry.path, { force: true });
    await rename(entry.claimPath, entry.path);
    await rmdir(entry.claimContainer);
  }
}

async function removeReportBackupsAndMarker(entries, transactionPath, marker) {
  // Keep the transaction marker durable until backup deletion is durable.
  // Otherwise recovery cannot distinguish a committed generation from a mix.
  const claimedBackups = await claimReportBackups(entries, marker, "cleanup");
  for (const entry of claimedBackups) {
    await validateClaimedReportBackup(entry);
    await rm(entry.claimPath, { force: true });
    await rmdir(entry.claimContainer);
  }
  await syncDirectories(entries);
  await rm(transactionPath, { force: true });
  await syncDirectories(entries);
}

async function buildReportTransaction(entries, canonicalPath, transaction) {
  const previousFiles = [];
  for (const entry of entries) {
    const info = await lstat(entry.path).catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!info) {
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`report output is not a regular file: ${entry.path}`);
    }
    previousFiles.push({
      name: basename(entry.path),
      sha256: await fileSha256(entry.path)
    });
  }
  return {
    schemaVersion: "kova.reportTransaction.v3",
    transaction,
    canonical: basename(canonicalPath),
    previousFiles,
    files: entries.map((entry) => ({
      name: basename(entry.path),
      sha256: createHash("sha256").update(entry.content).digest("hex")
    }))
  };
}

async function currentReportMatchesTransaction(entries, marker) {
  for (const expected of marker.files) {
    const entry = entries.find((candidate) => basename(candidate.path) === expected.name);
    const info = await lstat(entry.path).catch(() => null);
    if (!info?.isFile()) {
      return false;
    }
    if (await fileSha256(entry.path) !== expected.sha256) {
      return false;
    }
  }
  return true;
}

async function readReportTransaction(transactionPath, entries, canonicalPath) {
  let marker;
  try {
    marker = JSON.parse(await readFile(transactionPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error(`report transaction marker is invalid: ${transactionPath}`, { cause: error });
  }
  const expectedNames = entries.map((entry) => basename(entry.path)).sort();
  const markerNames = Array.isArray(marker?.files)
    ? marker.files.map((entry) => entry?.name).sort()
    : [];
  const previousNames = Array.isArray(marker?.previousFiles)
    ? marker.previousFiles.map((entry) => entry?.name)
    : [];
  const uniquePreviousNames = new Set(previousNames);
  const valid = (
    marker?.schemaVersion === "kova.reportTransaction.v3" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      marker.transaction ?? ""
    ) &&
    marker.canonical === basename(canonicalPath) &&
    Array.isArray(marker.previousFiles) &&
    markerNames.length === expectedNames.length &&
    markerNames.every((name, index) => name === expectedNames[index]) &&
    marker.files.every((entry) => /^[a-f0-9]{64}$/.test(entry?.sha256 ?? "")) &&
    uniquePreviousNames.size === previousNames.length &&
    previousNames.every((name) => expectedNames.includes(name)) &&
    marker.previousFiles.every((entry) => /^[a-f0-9]{64}$/.test(entry?.sha256 ?? ""))
  );
  if (!valid) {
    throw new Error(`report transaction marker is invalid: ${transactionPath}`);
  }
  return marker;
}

async function claimReportBackups(entries, marker, mode) {
  const previousFiles = new Map(marker.previousFiles.map((entry) => [entry.name, entry.sha256]));
  const claimed = [];
  for (const entry of entries) {
    const claimContainer = reportBackupClaimContainer(entry, marker);
    const claimPath = join(claimContainer, "backup");
    const backupExists = await pathExists(entry.backupPath);
    const containerExists = await pathExists(claimContainer);
    if (!backupExists && !containerExists) {
      continue;
    }
    if (!containerExists) {
      await mkdir(claimContainer, { recursive: false, mode: 0o700 });
      await syncDirectory(dirname(claimContainer));
    }
    await assertReportClaimContainer(claimContainer);
    const claimExists = await pathExists(claimPath);
    if (backupExists && claimExists) {
      throw new Error(`report backup has a conflicting replacement: ${entry.backupPath}`);
    }
    if (!backupExists && !claimExists) {
      const expectedHash = previousFiles.get(basename(entry.path));
      const priorFileRestored = (
        mode === "restore" &&
        expectedHash &&
        await regularFileMatches(entry.path, expectedHash)
      );
      if (mode !== "cleanup" && !priorFileRestored) {
        throw new Error(`report backup claim is incomplete: ${claimContainer}`);
      }
      await assertEmptyReportClaimContainer(claimContainer);
      await rmdir(claimContainer);
      await syncDirectory(dirname(claimContainer));
      continue;
    }
    if (backupExists) {
      await rename(entry.backupPath, claimPath);
      await syncDirectory(claimContainer);
      await syncDirectory(dirname(entry.backupPath));
    }
    const expectedHash = previousFiles.get(basename(entry.path));
    const info = await lstat(claimPath);
    if (
      !expectedHash ||
      !info.isFile() ||
      await fileSha256(claimPath) !== expectedHash
    ) {
      throw new Error(`report backup does not match transaction marker: ${claimPath}`);
    }
    claimed.push({ ...entry, claimContainer, claimPath, expectedHash });
  }
  return claimed;
}

async function regularFileMatches(path, expectedHash) {
  const info = await lstat(path).catch(() => null);
  return Boolean(info?.isFile() && await fileSha256(path) === expectedHash);
}

function reportBackupClaimContainer(entry, marker) {
  return `${entry.backupPath}.claim-${marker.transaction}`;
}

async function assertReportClaimContainer(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new Error(`report backup claim is invalid: ${path}`);
  }
  const names = await readdir(path);
  if (names.some((name) => name !== "backup")) {
    throw new Error(`report backup claim is invalid: ${path}`);
  }
}

async function assertEmptyReportClaimContainer(path) {
  await assertReportClaimContainer(path);
  if ((await readdir(path)).length !== 0) {
    throw new Error(`report backup claim is not empty: ${path}`);
  }
}

async function validateClaimedReportBackup(entry) {
  // The 0700 claim container and report lock exclude peer Kova writers.
  // Revalidate immediately before mutation; same-user hostile writers are outside the trust boundary.
  await assertReportClaimContainer(entry.claimContainer);
  if (!await regularFileMatches(entry.claimPath, entry.expectedHash)) {
    throw new Error(`report backup does not match transaction marker: ${entry.claimPath}`);
  }
}

async function reportBackupStateExists(entries) {
  const directories = [...new Set(entries.map((entry) => dirname(entry.backupPath)))];
  for (const entry of entries) {
    if (await pathExists(entry.backupPath)) {
      return true;
    }
  }
  for (const directory of directories) {
    const names = await readdir(directory).catch((error) => {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    if (entries.some((entry) => {
      const prefix = `${basename(entry.backupPath)}.claim-`;
      return names.some((name) => name.startsWith(prefix));
    })) {
      return true;
    }
  }
  return false;
}

async function fileSha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeDurableReportTransaction(path, content, entries) {
  const stagedPath = `${path}.tmp`;
  try {
    await writeDurableFile(stagedPath, content);
    await rename(stagedPath, path);
    await syncDirectories(entries);
  } finally {
    await rm(stagedPath, { force: true });
  }
}

async function writeDurableFile(path, content) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectories(entries) {
  if (process.platform === "win32") {
    return;
  }
  const directories = [...new Set(entries.map((entry) => dirname(entry.path)))];
  await Promise.all(directories.map((directory) => syncDirectory(directory)));
}

async function syncDirectory(directory) {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
