import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  const transaction = randomUUID();
  const transactionPath = join(
    dirname(canonicalPath),
    `.${basename(canonicalPath)}.kova-transaction`
  );
  const staged = entries.map((entry) => ({
    ...entry,
    stagedPath: join(dirname(entry.path), `.${transaction}-${basename(entry.path)}.tmp`),
    backupPath: join(dirname(entry.path), `.${basename(entry.path)}.kova-backup`)
  }));
  const backups = [];
  const published = [];
  let preserveBackups = false;
  let committed = false;

  await recoverReportFileSet(staged, canonicalPath, transactionPath);
  try {
    for (const entry of staged) {
      await writeDurableFile(entry.stagedPath, entry.content);
    }
    // Hash the complete generation before moving the old files. Recovery must
    // not mistake a mixed set left by an incomplete rollback for a commit.
    await writeDurableFile(
      transactionPath,
      `${JSON.stringify(await buildReportTransaction(staged, canonicalPath), null, 2)}\n`
    );
    await syncDirectories(staged);

    // Remove the canonical JSON first and publish it last. Report readers use
    // that file as the commit marker and never observe a newly partial set.
    const backupOrder = [
      ...staged.filter((entry) => entry.path === canonicalPath),
      ...staged.filter((entry) => entry.path !== canonicalPath)
    ];
    for (const entry of backupOrder) {
      if (await pathExists(entry.path)) {
        await rename(entry.path, entry.backupPath);
        backups.push(entry);
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
    const companionBackups = backups
      .filter((entry) => entry.path !== canonicalPath)
      .toReversed();
    for (const entry of companionBackups) {
      await rename(entry.backupPath, entry.path).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    const canonicalBackup = backups.find((entry) => entry.path === canonicalPath);
    if (rollbackErrors.length === 0 && canonicalBackup) {
      await rename(canonicalBackup.backupPath, canonicalBackup.path)
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
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
      await removeReportBackupsAndMarker(staged, transactionPath).catch(() => {});
    } else if (!preserveBackups) {
      await removeReportBackupsAndMarker(staged, transactionPath);
    }
  }
}

async function recoverReportFileSet(entries, canonicalPath, transactionPath) {
  const marker = await readReportTransaction(transactionPath, entries, canonicalPath);
  const backupEntries = [];
  for (const entry of entries) {
    if (!await pathExists(entry.backupPath)) {
      continue;
    }
    const info = await lstat(entry.backupPath);
    if (!info.isFile()) {
      throw new Error(`report backup is not a regular file: ${entry.backupPath}`);
    }
    backupEntries.push(entry);
  }
  if (!marker && backupEntries.length === 0) {
    return;
  }

  if (marker && await currentReportMatchesTransaction(entries, marker)) {
    await removeReportBackupsAndMarker(entries, transactionPath);
    return;
  }

  if (marker) {
    await restorePreviousReportSet(entries, backupEntries, marker, canonicalPath);
  } else {
    await restoreLegacyReportBackups(backupEntries, canonicalPath);
  }
  await syncDirectories(entries);
  await rm(transactionPath, { force: true });
  await syncDirectories(entries);
}

async function restorePreviousReportSet(entries, backupEntries, marker, canonicalPath) {
  const previousFiles = new Map(marker.previousFiles.map((entry) => [entry.name, entry.sha256]));
  const backedUpNames = new Set(backupEntries.map((entry) => basename(entry.path)));
  for (const entry of entries) {
    const name = basename(entry.path);
    const previousHash = previousFiles.get(name);
    if (backedUpNames.has(name)) {
      if (!previousHash || await fileSha256(entry.backupPath) !== previousHash) {
        throw new Error(`report backup does not match transaction marker: ${entry.backupPath}`);
      }
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

  await restoreLegacyReportBackups(backupEntries, canonicalPath);
}

async function restoreLegacyReportBackups(backupEntries, canonicalPath) {
  const restoreOrder = [
    ...backupEntries.filter((entry) => entry.path !== canonicalPath),
    ...backupEntries.filter((entry) => entry.path === canonicalPath)
  ];
  for (const entry of restoreOrder) {
    await rm(entry.path, { force: true });
    await rename(entry.backupPath, entry.path);
  }
}

async function removeReportBackupsAndMarker(entries, transactionPath) {
  // Keep the transaction marker durable until backup deletion is durable.
  // Otherwise recovery cannot distinguish a committed generation from a mix.
  await Promise.all(entries.map((entry) => rm(entry.backupPath, { force: true })));
  await syncDirectories(entries);
  await rm(transactionPath, { force: true });
  await syncDirectories(entries);
}

async function buildReportTransaction(entries, canonicalPath) {
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
    schemaVersion: "kova.reportTransaction.v2",
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
    marker?.schemaVersion === "kova.reportTransaction.v2" &&
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

async function fileSha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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
  await Promise.all(directories.map(async (directory) => {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }));
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
