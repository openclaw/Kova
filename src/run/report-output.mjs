import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
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
  const staged = entries.map((entry) => ({
    ...entry,
    stagedPath: join(dirname(entry.path), `.${transaction}-${basename(entry.path)}.tmp`),
    backupPath: join(dirname(entry.path), `.${transaction}-${basename(entry.path)}.bak`)
  }));
  const backups = [];
  const published = [];
  let preserveBackups = false;

  try {
    for (const entry of staged) {
      await writeDurableFile(entry.stagedPath, entry.content);
    }

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

    const publishOrder = [
      ...staged.filter((entry) => entry.path !== canonicalPath),
      ...staged.filter((entry) => entry.path === canonicalPath)
    ];
    for (const entry of publishOrder) {
      await rename(entry.stagedPath, entry.path);
      published.push(entry);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of published.toReversed()) {
      await rm(entry.path, { force: true }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    for (const entry of backups.toReversed()) {
      await rename(entry.backupPath, entry.path).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      preserveBackups = true;
      throw new AggregateError([error, ...rollbackErrors], "report publication failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await Promise.all(staged.map((entry) => rm(entry.stagedPath, { force: true })));
    if (!preserveBackups) {
      await Promise.all(staged.map((entry) => rm(entry.backupPath, { force: true })));
    }
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
