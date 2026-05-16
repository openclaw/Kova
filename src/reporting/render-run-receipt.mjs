// Final receipt panel for kova run and kova matrix run TTY output.

import {
  makeUi, heavyBand, ruleSection, card, sideBySide,
  badge, renderTable, visualWidth, repeat, withMargin,
} from "../ui/index.mjs";
import { relative } from "node:path";

const TARGET_WIDTH_FOR_DASHBOARD = 120;
const TOP_RECORDS = 12;

export function renderRunReceipt({ report, reportPath, jsonPath, summaryPath }, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  sections.push(renderBand(report, ui, { kind: "run" }));
  sections.push("");
  sections.push(renderKpiStrip(report, ui));

  const records = renderRecords(report, ui);
  if (records) { sections.push(""); sections.push(records); }

  sections.push("");
  sections.push(renderArtifacts({ reportPath, jsonPath, summaryPath }, ui));
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

  const records = renderRecords(report, ui);
  if (records) { sections.push(""); sections.push(records); }

  sections.push("");
  sections.push(renderArtifacts({ reportPath, jsonPath, summaryPath, bundlePath, retainedGateArtifacts }, ui));
  return withMargin(sections.join("\n"), ui.leftPad);
}

function renderBand(report, ui, { kind }) {
  const { g } = ui;
  const mode = String(report.mode ?? "dry-run").toUpperCase();
  const verdict = verdictForReport(report);
  const meta = [
    `mode: ${mode.toLowerCase()}`,
    report.target ? `target: ${report.target}` : null,
    report.runId ? `runId: ${report.runId}` : null,
  ].filter(Boolean).join(`  ${g.sep}  `);
  const title = kind === "matrix"
    ? (report.profile?.title ?? "KOVA MATRIX RUN")
    : "KOVA RUN";
  return heavyBand({
    badgeText: badge(verdict.label, verdict.tone, ui),
    status: verdict.status,
    title,
    meta,
    width: ui.width,
    ui,
  });
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
  const { c } = ui;
  const statuses = report.summary?.statuses ?? {};
  const total = report.summary?.total ?? 0;
  const pass = statuses.PASS ?? 0;
  const fail = statuses.FAIL ?? 0;
  const blocked = statuses.BLOCKED ?? 0;
  const skip = statuses.SKIP ?? 0;
  const dry = statuses["DRY-RUN"] ?? 0;

  const stack = ui.width < TARGET_WIDTH_FOR_DASHBOARD;
  const cardCount = 4;
  const cardWidth = stack
    ? Math.max(20, ui.width)
    : Math.max(20, Math.floor((ui.width - (cardCount - 1) * 2) / cardCount));

  const passDisplay = report.mode === "dry-run"
    ? card({ title: "Dry-run", width: cardWidth, ui, lines: [c.bold(String(dry)), c.dim("planned")] })
    : card({ title: "Passed",  width: cardWidth, ui, lines: [pass > 0 ? c.ok(c.bold(String(pass))) : c.dim("0"), c.dim("scenarios")] });

  const failDisplay = card({ title: "Failed", width: cardWidth, ui,
    lines: [
      fail > 0 ? c.err(c.bold(String(fail))) : c.dim("0"),
      c.dim(blocked > 0 ? `+${blocked} blocked` : (skip > 0 ? `+${skip} skipped` : "—")),
    ],
  });

  const perf = report.performance ?? {};
  const perfDisplay = card({ title: "Performance", width: cardWidth, ui,
    lines: [
      c.bold(`${perf.groupCount ?? 0} ${pluralize("group", perf.groupCount ?? 0)}`),
      perf.unstableGroupCount > 0
        ? c.warn(`${perf.unstableGroupCount} unstable`)
        : c.dim(`repeat=${perf.repeat ?? 1}`),
    ],
  });

  const totalDisplay = card({ title: opts.matrix ? "Entries" : "Total", width: cardWidth, ui,
    lines: [c.bold(String(total)), c.dim(report.mode === "dry-run" ? "planned" : "executed")],
  });

  return sideBySide([totalDisplay, passDisplay, failDisplay, perfDisplay], {
    width: ui.width, gap: 2, minWidth: TARGET_WIDTH_FOR_DASHBOARD,
  });
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

function renderRecords(report, ui) {
  const { c, g } = ui;
  const records = report.records ?? [];
  if (records.length === 0) return null;
  const top = records.slice(0, TOP_RECORDS);

  const rows = top.map((rec) => {
    const status = String(rec.status ?? "?").toUpperCase();
    let statusCol;
    if (status === "PASS")        statusCol = c.ok(status);
    else if (status === "FAIL")   statusCol = c.err(status);
    else if (status === "BLOCKED")statusCol = c.warn(status);
    else if (status === "SKIP")   statusCol = c.dim(status);
    else                          statusCol = c.dim(status);

    return {
      status:   statusCol,
      scenario: c.bold(typeof rec.scenario === "string" ? rec.scenario : (rec.scenario?.id ?? rec.scenarioId ?? "?")),
      state:    c.dim(typeof rec.state === "string" ? rec.state : (rec.state?.id ?? rec.stateId ?? "—")),
      note:     c.dim(rec.skipReason ?? rec.title ?? rec.scenario?.title ?? ""),
    };
  });

  const lines = [ruleSection("entries", ui.width, ui)];
  lines.push(indentBlock(renderTable({
    columns: [
      { key: "status",   header: c.dim("status"),   align: "left", minWidth: 7 },
      { key: "scenario", header: c.dim("scenario"), align: "left", minWidth: 24 },
      { key: "state",    header: c.dim("state"),    align: "left", minWidth: 16 },
      { key: "note",     header: c.dim("note"),     align: "left", minWidth: 16 },
    ],
    rows,
    gap: 2,
  }), 2));

  const more = records.length - top.length;
  if (more > 0) lines.push(`  ${c.dim(`+ ${more} more (use --json for full record list)`)}`);
  return lines.join("\n");
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

function pluralize(noun, n) { return n === 1 ? noun : `${noun}s`; }

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
