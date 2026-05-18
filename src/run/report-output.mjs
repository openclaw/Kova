import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildReportSummary, renderMarkdownReport } from "../reporting/report.mjs";

export function buildReportOutputPaths(reportRoot, runId, suffix = null) {
  const basename = suffix ? `${runId}-${suffix}` : runId;
  return {
    markdown: join(reportRoot, `${basename}.md`),
    json: join(reportRoot, `${basename}.json`),
    summary: join(reportRoot, `${basename}.summary.json`)
  };
}

export async function writeReportOutputs(reportRoot, report) {
  await mkdir(reportRoot, { recursive: true });
  await writeFile(report.outputPaths.markdown, renderMarkdownReport(report), "utf8");
  await writeFile(report.outputPaths.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(report.outputPaths.summary, `${JSON.stringify(buildReportSummary(report), null, 2)}\n`, "utf8");
}
