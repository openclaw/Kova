import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { required, resolveFromCwd } from "../cli.mjs";
import { bundleReport } from "../reporting/artifacts.mjs";
import { compareReports, renderCompareFixerSummary, renderCompareSummary } from "../reporting/compare.mjs";
import { renderPasteSummary, renderReportSummary } from "../reporting/report.mjs";

export async function runReportCommand(flags) {
  const [subcommand, firstPath, secondPath] = flags._;

  if (subcommand === "summarize") {
    const report = await readReport(required(firstPath, "report path"));
    if (flags.json) {
      console.log(JSON.stringify({
        schemaVersion: "kova.report.summary.v1",
        generatedAt: new Date().toISOString(),
        summary: renderReportSummary(report, { structured: true })
      }, null, 2));
      return;
    }

    console.log(renderReportSummary(report));
    return;
  }

  if (subcommand === "paste") {
    const report = await readReport(required(firstPath, "report path"));
    console.log(renderPasteSummary(report));
    return;
  }

  if (subcommand === "compare") {
    await compareReportsCommand(required(firstPath, "baseline report path"), required(secondPath, "current report path"), flags);
    return;
  }

  if (subcommand === "bundle") {
    const receipt = await bundleReport(required(firstPath, "report path"), {
      outputDir: flags.output_dir
    });

    if (flags.json) {
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }

    console.log(`Bundle: ${relative(process.cwd(), receipt.outputPath)}`);
    console.log(`SHA256: ${relative(process.cwd(), receipt.checksumPath)}`);
    return;
  }

  throw new Error(`unknown report command: ${subcommand ?? ""}`);
}

async function compareReportsCommand(baselinePath, currentPath, flags) {
  const baseline = await readReport(baselinePath);
  const current = await readReport(currentPath);
  const thresholds = flags.thresholds ? await readReport(flags.thresholds) : null;
  const comparison = compareReports(baseline, current, { thresholds });

  if (flags.json) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }

  console.log(flags.fixer ? renderCompareFixerSummary(comparison) : renderCompareSummary(comparison));
  if (!comparison.ok) {
    throw new Error("comparison found regressions");
  }
}

async function readReport(path) {
  return JSON.parse(await readFile(resolveFromCwd(path), "utf8"));
}
