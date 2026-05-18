import { readFile } from "node:fs/promises";
import { required } from "../cli.mjs";
import { displayPath } from "../paths.mjs";
import { bundleReport } from "../reporting/artifacts.mjs";
import { compareReports, renderCompareFixerSummary, renderCompareSummary } from "../reporting/compare.mjs";
import { buildReportSummary, renderPasteSummary, renderReportSummary } from "../reporting/report.mjs";
import { renderAssessment } from "../reporting/render-assessment.mjs";
import { renderCompareAssessment } from "../reporting/render-compare.mjs";
import { renderBundleReceipt } from "../reporting/render-bundle.mjs";
import { listStoredReports, readReportReference, resolveReportReference, resolveUserPath } from "../reporting/report-store.mjs";

const REPORT_SUBCOMMANDS = new Set(["summarize", "paste", "compare", "bundle", "list"]);

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

  if (subcommand === "list") {
    await listReportsCommand(flags);
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
    const reportPath = await resolveReportReference(required(firstPath, "report path"));
    const receipt = await bundleReport(reportPath, {
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

export async function runReportsCommand(flags) {
  await listReportsCommand(flags);
}

async function listReportsCommand(flags) {
  const reports = await listStoredReports({ limit: flags.limit });
  if (flags.json) {
    console.log(JSON.stringify({
      schemaVersion: "kova.reports.v1",
      reports
    }, null, 2));
    return;
  }
  console.log(renderReportsList(reports));
}

async function compareReportsCommand(baselinePath, currentPath, flags) {
  const baseline = await readReport(baselinePath);
  const current = await readReport(currentPath);
  const thresholds = flags.thresholds ? JSON.parse(await readFile(resolveUserPath(flags.thresholds), "utf8")) : null;
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
  return readReportReference(path);
}

function renderReportsList(reports) {
  if (reports.length === 0) {
    return "No Kova reports found.";
  }
  const rows = reports.map((report) => ({
    runId: report.runId,
    status: report.status,
    target: report.target ?? "-",
    profile: report.profile ?? "-",
    scenarios: String(report.scenarios ?? 0),
    generatedAt: formatGeneratedAt(report.generatedAt),
    path: displayPath(report.path)
  }));
  const headers = ["runId", "status", "target", "profile", "scenarios", "generated"];
  const widths = {
    runId: Math.max(headers[0].length, ...rows.map((row) => row.runId.length)),
    status: Math.max(headers[1].length, ...rows.map((row) => row.status.length)),
    target: Math.min(34, Math.max(headers[2].length, ...rows.map((row) => row.target.length))),
    profile: Math.max(headers[3].length, ...rows.map((row) => row.profile.length)),
    scenarios: Math.max(headers[4].length, ...rows.map((row) => row.scenarios.length)),
    generatedAt: Math.max(headers[5].length, ...rows.map((row) => row.generatedAt.length))
  };
  const lines = [
    [
      pad("runId", widths.runId),
      pad("status", widths.status),
      pad("target", widths.target),
      pad("profile", widths.profile),
      pad("scenarios", widths.scenarios),
      pad("generated", widths.generatedAt)
    ].join("  ")
  ];
  for (const row of rows) {
    lines.push([
      pad(row.runId, widths.runId),
      pad(row.status, widths.status),
      pad(truncate(row.target, widths.target), widths.target),
      pad(row.profile, widths.profile),
      pad(row.scenarios, widths.scenarios),
      pad(row.generatedAt, widths.generatedAt)
    ].join("  "));
  }
  lines.push("");
  lines.push("Use: kova report <runId>");
  return lines.join("\n");
}

function formatGeneratedAt(value) {
  if (!value) {
    return "-";
  }
  return String(value).replace(/\.\d+Z$/, "Z");
}

function pad(value, width) {
  return String(value).padEnd(width, " ");
}

function truncate(value, width) {
  const text = String(value);
  if (text.length <= width) {
    return text;
  }
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}
