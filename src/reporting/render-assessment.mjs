// Default kova report renderer - the showcase surface.
// Consumes the existing buildReportSummary() model unchanged and emits a
// dashboard-rich ANSI assessment for stdout. Honors --color and --ascii.

import {
  makeUi, ruleSection, renderKovaHeader, kpiStrip,
  gauge, statusGlyph, renderTable,
  formatPercent, computeDelta, classifyDelta,
  visualWidth, repeat, wrap, withMargin,
} from "../ui/index.mjs";
import { buildReportSummary } from "./report.mjs";

const TOP_FINDINGS = 6;
const TOP_REGRESSIONS = 8;

export function renderAssessment(report, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const summary = buildReportSummary(report);
  return withMargin(renderFromSummary(summary, ui), ui.leftPad);
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
  const headline = buildHeadline(summary, ui);
  const meta = formatBandMeta(summary, ui);

  return renderKovaHeader({
    surface: "report",
    verdict: shipLabel,
    headline,
    meta,
    ui,
  });
}

function buildHeadline(summary, ui) {
  const sep = ` ${ui.g.sep} `;
  const blocking = summary.decision?.blockingFindingCount ?? 0;
  const warning = summary.decision?.warningFindingCount ?? 0;
  const regressions = summary.performance?.baselineRegressionCount ?? 0;
  const parts = [];
  if (blocking > 0) parts.push(`${blocking} blocking`);
  if (warning > 0) parts.push(`${warning} warning`);
  if (regressions > 0) parts.push(`${regressions} perf regression${regressions === 1 ? "" : "s"}`);
  if (parts.length === 0) {
    const proofTotal = summary.proof?.requiredTotal ?? 0;
    return proofTotal > 0 ? "all checks passed" : "ready";
  }
  return parts.join(sep);
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
  return kpiStrip([
    buildProofKpi(summary),
    buildHealthKpi(summary),
    buildPerformanceKpi(summary),
  ], ui);
}

function buildProofKpi(summary) {
  const total = summary.proof?.requiredTotal ?? 0;
  const missing = summary.proof?.requiredMissing ?? 0;
  const failed = summary.proof?.requiredFailed ?? 0;
  const satisfied = Math.max(0, total - missing - failed);
  if (total === 0) {
    return { label: "Proof", value: "n/a", hint: "no required proof tracked", tone: "dim" };
  }
  const pct = Math.round((satisfied / total) * 100);
  const tone = pct >= 80 ? "ok" : pct >= 50 ? "warn" : "err";
  return {
    label: "Proof",
    value: `${pct}%`,
    hint: `${satisfied}/${total}`,
    tone,
    bar: { filled: satisfied, total },
  };
}

function buildHealthKpi(summary) {
  const blocking = summary.decision?.blockingFindingCount ?? 0;
  const warning = summary.decision?.warningFindingCount ?? 0;
  if (blocking > 0) {
    return {
      label: "Health", value: "unhealthy",
      hint: `${blocking} blocking · ${warning} warning`,
      tone: "err",
      bar: { filled: 3, total: 10 },
    };
  }
  if (warning > 0) {
    return {
      label: "Health", value: "watch", hint: `${warning} warning`,
      tone: "warn",
      bar: { filled: 7, total: 10 },
    };
  }
  return {
    label: "Health", value: "stable", hint: "no blocking findings",
    tone: "ok",
    bar: { filled: 10, total: 10 },
  };
}

function buildPerformanceKpi(summary) {
  const perf = summary.performance;
  if (!perf) {
    return { label: "Performance", value: "n/a", hint: "no performance data", tone: "dim" };
  }
  const groups = perf.groupCount ?? 0;
  const unstable = perf.unstableGroupCount ?? 0;
  const regressions = perf.baselineRegressionCount ?? 0;
  const recordCount = summary.coverage?.recordCount ?? 0;
  const hint = `${groups}g · ${recordCount}r`;
  if (regressions > 0) {
    return {
      label: "Performance",
      value: `${regressions} regression${regressions === 1 ? "" : "s"}`,
      hint, tone: "err",
      bar: { filled: 3, total: 10 },
    };
  }
  if (unstable > 0) {
    return {
      label: "Performance", value: `${unstable} unstable`, hint, tone: "warn",
      bar: { filled: 6, total: 10 },
    };
  }
  if (groups > 0) {
    return {
      label: "Performance", value: "on target", hint, tone: "ok",
      bar: { filled: 10, total: 10 },
    };
  }
  return { label: "Performance", value: "no samples", hint, tone: "dim" };
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

    lines.push(`  ${glyph} ${c.bold(truncatePlain(summaryText, ui.width - 20))}${owner}`);
    if (scope || evidence) {
      const parts = [scope, evidence].filter(Boolean).join("  ");
      const indentW = 4;
      const avail = Math.max(20, ui.width - indentW);
      const wrapped = wrap(parts, avail);
      for (const w of wrapped) lines.push(repeat(" ", indentW) + c.dim(w));
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

  const head = `  ${c.head(g.play)} ${c.bold(rec.scenario ?? "next scenario")}`;
  if (rec.reason) {
    const reasonText = `${g.sep} ${rec.reason}`;
    const avail = Math.max(20, ui.width - visualWidth(head) - 3);
    const wrapped = wrap(reasonText, avail);
    lines.push(head + " " + c.dim(wrapped[0] ?? ""));
    for (const cont of wrapped.slice(1)) {
      lines.push(repeat(" ", visualWidth(head) + 1) + c.dim(cont));
    }
  } else {
    lines.push(head);
  }

  if (rec.command) {
    const prefix = `  ${c.dim("$")} `;
    const indentWidth = visualWidth(prefix);
    const avail = Math.max(20, ui.width - indentWidth);
    const wrapped = wrap(rec.command, avail);
    lines.push(prefix + c.met(wrapped[0] ?? ""));
    for (const cont of wrapped.slice(1)) {
      lines.push(repeat(" ", indentWidth) + c.met(cont));
    }
  }
  return lines.join("\n");
}

function renderFooter(summary, ui) {
  const { c, g } = ui;
  const recordCount = summary.coverage?.recordCount ?? 0;
  const scenarioCount = summary.coverage?.scenarioCount ?? 0;
  const parts = [
    `run ${summary.runId ?? "?"}`,
    `${recordCount} record${recordCount === 1 ? "" : "s"}`,
    `${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"}`,
  ];
  if (summary.runId) parts.push(`kova report bundle ${summary.runId}`);
  return c.dim(`Kova ${g.sep} report ${g.sep} ${parts.join(` ${g.sep} `)}`);
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
