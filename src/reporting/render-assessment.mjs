// Default kova report renderer - the showcase surface.
// Consumes the existing buildReportSummary() model unchanged and emits a
// dashboard-rich ANSI assessment for stdout. Honors --color and --ascii.

import {
  makeUi, heavyBand, ruleSection, card, sideBySide,
  badge, gauge, statusGlyph, renderTable,
  formatPercent, computeDelta, classifyDelta,
  visualWidth, repeat,
} from "../ui/index.mjs";
import { buildReportSummary } from "./report.mjs";

const TARGET_WIDTH_FOR_DASHBOARD = 120;
const TOP_FINDINGS = 6;
const TOP_REGRESSIONS = 8;

export function renderAssessment(report, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const summary = buildReportSummary(report);
  return renderFromSummary(summary, ui);
}

// Exposed for tests and snapshot coverage.
export function renderFromSummary(summary, ui) {
  const width = ui.width;
  const sections = [];

  sections.push(renderBand(summary, ui));
  sections.push("");
  sections.push(renderKpiStrip(summary, ui));

  const findings = renderFindings(summary, ui);
  if (findings) { sections.push(""); sections.push(findings); }

  const perf = renderPerformance(summary, ui);
  if (perf) { sections.push(""); sections.push(perf); }

  const next = renderRecommendedNext(summary, ui);
  if (next) { sections.push(""); sections.push(next); }

  sections.push("");
  sections.push(renderFooter(summary, ui));

  return sections.join("\n");
}

function renderBand(summary, ui) {
  const verdict = String(summary.decision?.verdict ?? "UNKNOWN").toUpperCase();
  const shipLabel = deriveShipLabel(verdict, summary);
  const meta = formatBandMeta(summary, ui);

  return heavyBand({
    badgeText: badge(shipLabel, shipLabel, ui),
    status: verdict,
    title: "KOVA ASSESSMENT",
    meta,
    width: ui.width,
    ui,
  });
}

function deriveShipLabel(verdict, summary) {
  if (summary.gate?.verdict) return String(summary.gate.verdict).toUpperCase();
  switch (verdict) {
    case "PASS": return "SHIP";
    case "FAIL": return "DO_NOT_SHIP";
    case "INCOMPLETE": return "PARTIAL";
    case "BLOCKED": return "BLOCKED";
    case "DRY_RUN":
    case "DRY-RUN":
      return "DRY-RUN";
    default: return verdict;
  }
}

function formatBandMeta(summary, ui) {
  const sep = ` ${ui.g.sep} `;
  const parts = [];
  if (summary.run?.profile) parts.push(`profile: ${summary.run.profile}`);
  const primaryScenario = summary.samples?.[0]?.scenario;
  if (primaryScenario && summary.coverage?.scenarioCount === 1) parts.push(primaryScenario);
  if (summary.target) parts.push(summary.target);
  if (summary.runId) parts.push(summary.runId);
  if (summary.reportGeneratedAt) parts.push(formatTimestamp(summary.reportGeneratedAt));
  return parts.join(sep);
}

function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch { return iso; }
}

function renderKpiStrip(summary, ui) {
  const { c } = ui;
  const cardWidth = Math.max(28, Math.floor((ui.width - 4) / 3));

  const proof = buildProofKpi(summary, ui, cardWidth);
  const health = buildHealthKpi(summary, ui, cardWidth);
  const perf = buildPerformanceKpi(summary, ui, cardWidth);

  return sideBySide([proof, health, perf], { width: ui.width, gap: 2, minWidth: TARGET_WIDTH_FOR_DASHBOARD });
}

function buildProofKpi(summary, ui, width) {
  const { c } = ui;
  const total = summary.proof?.requiredTotal ?? 0;
  const missing = summary.proof?.requiredMissing ?? 0;
  const failed = summary.proof?.requiredFailed ?? 0;
  const satisfied = Math.max(0, total - missing - failed);
  const pct = total > 0 ? Math.round((satisfied / total) * 100) : null;
  const barColor = pct == null ? c.dim : pct >= 80 ? c.ok : pct >= 50 ? c.warn : c.err;

  const line1 = total > 0
    ? `${barColor(gauge(satisfied, total, 20, ui))} ${c.bold(pct + "%")}`
    : c.dim("no required proof tracked");
  const line2 = total > 0
    ? c.dim(`${satisfied} of ${total} requirements`)
    : c.dim("—");

  return card({ title: "Proof", width, lines: [line1, line2], ui });
}

function buildHealthKpi(summary, ui, width) {
  const { c, g } = ui;
  const blocking = summary.decision?.blockingFindingCount ?? 0;
  const warning = summary.decision?.warningFindingCount ?? 0;
  let state, line2;
  if (blocking > 0) { state = c.err("unhealthy"); line2 = c.dim(`${blocking} blocking ${g.sep} ${warning} warning`); }
  else if (warning > 0) { state = c.warn("watch"); line2 = c.dim(`${warning} warning`); }
  else { state = c.ok("stable"); line2 = c.dim("no blocking findings"); }

  const filled = blocking > 0 ? 6 : warning > 0 ? 14 : 20;
  const barColor = blocking > 0 ? c.err : warning > 0 ? c.warn : c.ok;
  const line1 = `${barColor(gauge(filled, 20, 20, ui))} ${c.bold(stateLabel(blocking, warning))}`;

  return card({ title: "Health", width, lines: [line1, line2], ui });
}

function stateLabel(blocking, warning) {
  if (blocking > 0) return "unhealthy";
  if (warning > 0) return "watch";
  return "stable";
}

function buildPerformanceKpi(summary, ui, width) {
  const { c } = ui;
  const perf = summary.performance;
  if (!perf) {
    return card({ title: "Performance", width, lines: [c.dim("no performance data"), c.dim("—")], ui });
  }
  const groups = perf.groupCount ?? 0;
  const unstable = perf.unstableGroupCount ?? 0;
  const regressions = perf.baselineRegressionCount ?? 0;

  let state, filled, barColor;
  if (regressions > 0) { state = `${regressions} regression${regressions === 1 ? "" : "s"}`; filled = 6; barColor = c.err; }
  else if (unstable > 0) { state = `${unstable} unstable`; filled = 12; barColor = c.warn; }
  else if (groups > 0) { state = "on target"; filled = 20; barColor = c.ok; }
  else { state = "no samples"; filled = 0; barColor = c.dim; }

  const line1 = `${barColor(gauge(filled, 20, 20, ui))} ${c.bold(state)}`;
  const line2 = c.dim(`${groups} group${groups === 1 ? "" : "s"} ${ui.g.sep} ${summary.coverage?.recordCount ?? 0} record${(summary.coverage?.recordCount ?? 0) === 1 ? "" : "s"}`);

  return card({ title: "Performance", width, lines: [line1, line2], ui });
}

function renderFindings(summary, ui) {
  const { c, g } = ui;
  const findings = summary.findings ?? [];
  if (findings.length === 0) return null;

  const top = findings.slice(0, TOP_FINDINGS);
  const lines = [ruleSection("findings", ui.width, ui)];

  for (const f of top) {
    const sev = severityToStatus(f.severity);
    const glyph = colorize(c, sev, statusGlyph(g, sev));
    const scope = formatFindingScope(f);
    const summaryText = String(f.summary ?? "").trim();
    const evidence = (f.evidence ?? []).slice(0, 2).join("; ");
    const owner = f.ownerArea ? c.dim(` ${g.sep} ${f.ownerArea}`) : "";
    const evidenceText = evidence ? "  " + c.dim(evidence) : "";

    lines.push(`  ${glyph} ${c.bold(truncatePlain(summaryText, ui.width - 20))}${owner}`);
    if (scope || evidenceText) {
      const meta = [scope ? c.dim(scope) : null, evidenceText ? evidenceText.trim() : null].filter(Boolean).join("  ");
      lines.push(`    ${meta}`);
    }
  }

  const more = findings.length - top.length;
  if (more > 0) lines.push(`  ${c.dim(`+ ${more} more finding${more === 1 ? "" : "s"} in JSON report`)}`);

  return lines.join("\n");
}

function formatFindingScope(f) {
  const parts = [];
  if (f.scenario) parts.push(f.scenario);
  if (f.state) parts.push(f.state);
  return parts.join("/");
}

function severityToStatus(sev) {
  switch (String(sev).toLowerCase()) {
    case "blocking":
    case "fail":
      return "FAIL";
    case "incomplete":
      return "INCOMPLETE";
    case "blocked":
      return "BLOCKED";
    case "warning":
    case "diagnostic-gap":
      return "INCOMPLETE";
    default:
      return "SKIPPED";
  }
}

function colorize(c, status, text) {
  switch (status) {
    case "PASS": case "SHIP": return c.ok(text);
    case "FAIL": case "DO_NOT_SHIP": return c.err(text);
    case "INCOMPLETE": case "PARTIAL": return c.warn(text);
    case "BLOCKED": return c.block(text);
    default: return c.dim(text);
  }
}

function renderPerformance(summary, ui) {
  const { c } = ui;
  const regressions = summary.performance?.regressions ?? [];
  if (regressions.length === 0) return null;

  const rows = regressions.slice(0, TOP_REGRESSIONS).map((r) => {
    const baseline = r.baselineMedian ?? r.baselineP95;
    const current = r.currentMedian ?? r.currentP95;
    const delta = computeDelta(baseline, current);
    const cls = classifyDelta(delta, { direction: "lower-better" });
    const deltaText = delta == null ? "—" : formatPercent(delta, { withSign: true });
    const deltaColored = cls === "better" ? c.pos(deltaText) : cls === "worse" ? c.neg(deltaText) : c.dim(deltaText);
    const verdictText = cls === "better" ? c.pos("better") : cls === "worse" ? c.neg("worse") : c.dim("stable");
    return {
      metric: c.bold(r.metric ?? "(unknown)"),
      baseline: formatMetricValue(baseline),
      current: formatMetricValue(current),
      delta: deltaColored,
      verdict: verdictText,
    };
  });

  const header = ruleSection("performance", ui.width, ui);
  const table = renderTable({
    columns: [
      { key: "metric",   header: c.dim("metric"),   align: "left",  minWidth: 28 },
      { key: "baseline", header: c.dim("baseline"), align: "right", minWidth: 10 },
      { key: "current",  header: c.dim("current"),  align: "right", minWidth: 10 },
      { key: "delta",    header: c.dim("Δ"),        align: "right", minWidth: 8 },
      { key: "verdict",  header: c.dim("verdict"),  align: "left",  minWidth: 8 },
    ],
    rows,
    gap: 3,
  });
  return [header, indentBlock(table, 2)].join("\n");
}

function formatMetricValue(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  if (Number.isInteger(n) && Math.abs(n) < 10000) return String(n);
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US");
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function renderRecommendedNext(summary, ui) {
  const { c, g } = ui;
  const rec = summary.recommendedNextScenario;
  if (!rec) return null;
  const lines = [ruleSection("recommended next", ui.width, ui)];
  lines.push(`  ${c.head(g.play)} ${c.bold(rec.scenario ?? "next scenario")}${rec.reason ? c.dim(`  ${g.sep} ` + rec.reason) : ""}`);
  if (rec.command) lines.push(`  ${c.dim("$")} ${c.met(rec.command)}`);
  return lines.join("\n");
}

function renderFooter(summary, ui) {
  const { c, g } = ui;
  const lines = [];
  const recordCount = summary.coverage?.recordCount ?? 0;
  const scenarioCount = summary.coverage?.scenarioCount ?? 0;
  lines.push(c.dim(`Evidence  ${g.sep}  run ${summary.runId ?? "?"} ${g.sep} ${recordCount} record${recordCount === 1 ? "" : "s"} ${g.sep} ${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"}`));
  if (summary.runId) lines.push(c.dim(`Bundle    ${g.sep}  kova report bundle ${summary.runId}`));
  return lines.join("\n");
}

function truncatePlain(text, max) {
  if (max <= 4) return text;
  if (visualWidth(text) <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
