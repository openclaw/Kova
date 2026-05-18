import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
      if (await anyPathExists(Object.values(outputPaths))) {
        await releaseReportOutputLock(lockPath);
        continue;
      }
      return { runId, outputPaths, lockPath };
    } catch (error) {
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
  await writeFile(report.outputPaths.markdown, renderMarkdownReport(report), "utf8");
  await writeFile(report.outputPaths.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(report.outputPaths.summary, `${JSON.stringify(buildReportSummary(report), null, 2)}\n`, "utf8");
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
