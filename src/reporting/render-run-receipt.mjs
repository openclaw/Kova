// Final receipt panel for kova run and kova matrix run TTY output.
//
// Receipt is the quick "what just ran" printout. It does NOT replace
// `kova report` — its job is to confirm the run, surface artifacts, and
// point the user at the full report. No --full variant; receipts are
// always compact.

import {
  makeUi, ruleSection, renderKovaHeader, kpiStrip,
  scenariosRollup, withMargin,
} from "../ui/index.mjs";
import { aggregateScenarios } from "./scenario-aggregate.mjs";
import { relative } from "node:path";

export function renderRunReceipt({ report, reportPath, jsonPath, summaryPath }, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  sections.push(renderBand(report, ui, { kind: "run" }));
  sections.push("");
  sections.push(renderKpiStrip(report, ui));

  sections.push("");
  sections.push(renderArtifacts({ reportPath, jsonPath, summaryPath }, ui));

  const scenarios = renderScenarios(report, ui);
  if (scenarios) { sections.push(""); sections.push(scenarios); }

  sections.push("");
  sections.push(renderNext({ reportPath, jsonPath }, ui));
  return withMargin(sections.join("\n"), ui.leftPad);
}

export function renderMatrixRunReceipt({ report, reportPath, jsonPath, summaryPath, bundlePath, retainedGateArtifacts }, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  sections.push(renderBand(report, ui, { kind: "matrix" }));
  sections.push("");
  sections.push(renderKpiStrip(report, ui, { matrix: true }));

  const gate = renderGate(report.gate, ui);
  if (gate) { sections.push(""); sections.push(gate); }

  sections.push("");
  sections.push(renderArtifacts({ reportPath, jsonPath, summaryPath, bundlePath, retainedGateArtifacts }, ui));

  const scenarios = renderScenarios(report, ui, { matrix: true });
  if (scenarios) { sections.push(""); sections.push(scenarios); }

  sections.push("");
  sections.push(renderNext({ reportPath, jsonPath, bundlePath }, ui));
  return withMargin(sections.join("\n"), ui.leftPad);
}

function renderBand(report, ui, { kind }) {
  const { g } = ui;
  const mode = String(report.mode ?? "dry-run").toLowerCase();
  const verdict = verdictForReport(report);
  const meta = [
    `mode: ${mode}`,
    report.target ? `target: ${report.target}` : null,
    report.runId ? `runId: ${report.runId}` : null,
  ].filter(Boolean).join(` ${g.sep} `);
  const surface = kind === "matrix" ? "matrix run" : "run";
  const headline = buildRunHeadline(report);
  return renderKovaHeader({ surface, verdict: verdict.label, headline, meta, ui });
}

function buildRunHeadline(report) {
  const statuses = report.summary?.statuses ?? {};
  const total = report.summary?.total ?? 0;
  const pass = statuses.PASS ?? 0;
  const fail = statuses.FAIL ?? 0;
  const dry = statuses["DRY-RUN"] ?? 0;
  if (report.mode === "dry-run") return `${dry || total} planned`;
  if (fail > 0) return `${fail} failed of ${total}`;
  if (pass === total && total > 0) return `${total} passed`;
  return `${pass}/${total} passed`;
}

function verdictForReport(report) {
  if (report.gate?.verdict) {
    const v = String(report.gate.verdict).toUpperCase();
    if (v === "SHIP") return { label: "SHIP", tone: "PASS", status: "PASS" };
    if (v === "DO_NOT_SHIP") return { label: "DO_NOT_SHIP", tone: "FAIL", status: "FAIL" };
    return { label: v, tone: "INCOMPLETE", status: v };
  }
  const statuses = report.summary?.statuses ?? {};
  const mode = String(report.mode ?? "").toLowerCase();
  if (mode === "dry-run" || statuses["DRY-RUN"]) {
    return { label: "DRY-RUN", tone: "INCOMPLETE", status: "PLANNED" };
  }
  if (statuses.FAIL) return { label: "DO_NOT_SHIP", tone: "FAIL", status: "FAIL" };
  if (statuses.BLOCKED) return { label: "BLOCKED", tone: "INCOMPLETE", status: "BLOCKED" };
  if (statuses.PASS) return { label: "SHIP", tone: "PASS", status: "PASS" };
  return { label: "DONE", tone: "INCOMPLETE", status: "DONE" };
}

function renderKpiStrip(report, ui, opts = {}) {
  const statuses = report.summary?.statuses ?? {};
  const total = report.summary?.total ?? 0;
  const pass = statuses.PASS ?? 0;
  const fail = statuses.FAIL ?? 0;
  const blocked = statuses.BLOCKED ?? 0;
  const skip = statuses.SKIP ?? 0;
  const dry = statuses["DRY-RUN"] ?? 0;
  const perf = report.performance ?? {};

  const passItem = report.mode === "dry-run"
    ? { label: "Dry-run", value: String(dry), hint: "planned", tone: "neutral", bar: { filled: dry, total: Math.max(total, dry) } }
    : { label: "Passed", value: String(pass), hint: "scenarios", tone: pass > 0 ? "ok" : "dim", bar: { filled: pass, total: Math.max(total, pass) } };

  const failHint = blocked > 0 ? `+${blocked} blocked` : (skip > 0 ? `+${skip} skipped` : null);
  const failItem = {
    label: "Failed", value: String(fail), hint: failHint, tone: fail > 0 ? "err" : "dim",
    bar: { filled: fail, total: Math.max(total, fail) },
  };

  const perfHint = perf.unstableGroupCount > 0
    ? `${perf.unstableGroupCount} unstable`
    : `repeat=${perf.repeat ?? 1}`;
  const perfItem = {
    label: "Performance",
    value: `${perf.groupCount ?? 0} ${pluralize("group", perf.groupCount ?? 0)}`,
    hint: perfHint,
    tone: perf.unstableGroupCount > 0 ? "warn" : "neutral",
  };

  const totalItem = {
    label: opts.matrix ? "Entries" : "Total",
    value: String(total),
    hint: report.mode === "dry-run" ? "planned" : "executed",
    tone: "neutral",
  };

  return kpiStrip([totalItem, passItem, failItem, perfItem], ui);
}

function renderGate(gate, ui) {
  if (!gate) return null;
  const { c, g } = ui;
  const lines = [ruleSection("gate", ui.width, ui)];
  const verdict = String(gate.verdict ?? "").toUpperCase();
  const verdictColor = verdict === "SHIP" ? c.ok : verdict === "DO_NOT_SHIP" ? c.err : c.warn;

  lines.push(`  ${c.dim("Verdict")}    ${verdictColor(c.bold(verdict))}${gate.outcome ? c.dim(`  ${g.sep} ${gate.outcome}`) : ""}`);
  if (gate.profileId)  lines.push(`  ${c.dim("Profile")}    ${gate.profileId}${gate.policyId ? c.dim(`  ${g.sep} policy ${gate.policyId}`) : ""}`);
  const counts = [
    gate.blockingCount != null  ? `${gate.blockingCount} blocking` : null,
    gate.warningCount != null   ? `${gate.warningCount} warning` : null,
    gate.missingRequiredCount   ? `${gate.missingRequiredCount} missing required` : null,
  ].filter(Boolean).join(`  ${g.sep}  `);
  if (counts) lines.push(`  ${c.dim("Findings")}   ${counts}`);
  return lines.join("\n");
}

function renderScenarios(report, ui, opts = {}) {
  if (!report?.records || report.records.length === 0) return null;
  const scenarios = aggregateScenarios(report);
  if (scenarios.length === 0) return null;

  const rows = scenarios.map((s) => ({
    id: s.id,
    target: opts.matrix ? (s.target ?? report.target ?? null) : null,
    passed: s.passed,
    total: s.total,
    verdict: s.verdict,
    worst: s.worst ? { label: s.worst.message ?? s.worst.metric ?? "violation", tone: "err" } : null,
  }));

  return [
    ruleSection("scenarios", ui.width, ui),
    "",
    scenariosRollup({ rows, matrix: !!opts.matrix, ui }),
  ].join("\n");
}

function renderArtifacts({ reportPath, jsonPath, summaryPath, bundlePath, retainedGateArtifacts }, ui) {
  const { c, g } = ui;
  const cwd = process.cwd();
  const rel = (p) => p ? relative(cwd, p) || p : null;
  const lines = [ruleSection("artifacts", ui.width, ui)];
  if (reportPath)   lines.push(`  ${c.head(g.diamond)} ${c.dim("markdown   ")} ${rel(reportPath)}`);
  if (jsonPath)     lines.push(`  ${c.head(g.diamond)} ${c.dim("json       ")} ${rel(jsonPath)}`);
  if (summaryPath)  lines.push(`  ${c.head(g.diamond)} ${c.dim("summary    ")} ${rel(summaryPath)}`);
  if (bundlePath)   lines.push(`  ${c.head(g.diamond)} ${c.dim("bundle     ")} ${rel(bundlePath)}`);
  if (retainedGateArtifacts?.outputDir) {
    lines.push(`  ${c.warn(g.warn)} ${c.dim("retained   ")} ${rel(retainedGateArtifacts.outputDir)}`);
  }
  return lines.join("\n");
}

function renderNext({ reportPath, jsonPath, bundlePath }, ui) {
  const { c, g } = ui;
  const cwd = process.cwd();
  const rel = (p) => p ? (relative(cwd, p) || p) : null;
  const hints = [];
  const reportTarget = rel(jsonPath ?? reportPath);
  if (reportTarget) hints.push(`kova report ${reportTarget}`);
  if (bundlePath)   hints.push(`kova report bundle ${rel(bundlePath)}`);
  if (hints.length === 0) return "";
  const lines = [ruleSection("next", ui.width, ui), ""];
  for (const h of hints) lines.push(`  ${c.dim(g.arrow)} ${h}`);
  return lines.join("\n");
}

function pluralize(noun, n) { return n === 1 ? noun : `${noun}s`; }

