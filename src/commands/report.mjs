import { readFile } from "node:fs/promises";
import { required, resolveFromCwd } from "../cli.mjs";
import { displayPath } from "../paths.mjs";
import { bundleReport } from "../reporting/artifacts.mjs";
import { compareReports, renderCompareFixerSummary, renderCompareSummary } from "../reporting/compare.mjs";
import { buildReportSummary, renderPasteSummary, renderReportSummary } from "../reporting/report.mjs";
import { renderAssessment } from "../reporting/render-assessment.mjs";
import { renderCompareAssessment } from "../reporting/render-compare.mjs";
import { renderBundleReceipt } from "../reporting/render-bundle.mjs";

const REPORT_SUBCOMMANDS = new Set(["summarize", "paste", "compare", "bundle"]);

export async function runReportCommand(flags) {
  const [subcommand, firstPath, secondPath] = flags._;

  // Default branch: `kova report <path>` (no subcommand) renders the
  // dashboard-rich assessment to stdout.
  if (subcommand && !REPORT_SUBCOMMANDS.has(subcommand)) {
    const report = await readReport(subcommand);
    if (flags.json) {
      console.log(JSON.stringify(buildReportSummary(report), null, 2));
      return;
    }
    console.log(renderAssessment(report, flags));
    return;
  }

  if (subcommand === "summarize") {
    const report = await readReport(required(firstPath, "report path"));
    if (flags.json) {
      console.log(JSON.stringify(buildReportSummary(report), null, 2));
      return;
    }
    if (flags.plain) {
      console.log(renderReportSummary(report));
      return;
    }
    console.log(renderAssessment(report, flags));
    return;
  }

  if (subcommand === "paste") {
    // Paste output stays plain text by design - it's meant to be copy-pasted
    // into chat tools, bug reports, or fixer prompts. Adding ANSI escapes
    // would defeat that purpose.
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

    if (flags.plain) {
      console.log(`Bundle: ${displayPath(receipt.outputPath)}`);
      console.log(`SHA256: ${displayPath(receipt.checksumPath)}`);
      return;
    }
    console.log(renderBundleReceipt(receipt, flags));
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

  if (flags.plain || flags.fixer) {
    console.log(flags.fixer ? renderCompareFixerSummary(comparison) : renderCompareSummary(comparison));
  } else {
    console.log(renderCompareAssessment(comparison, flags));
  }
  if (!comparison.ok) {
    process.exitCode = 1;
  }
}

async function readReport(path) {
  return JSON.parse(await readFile(resolveFromCwd(path), "utf8"));
}
