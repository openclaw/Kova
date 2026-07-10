// kova report compare <baseline> <current> — scenario-spine renderer.
//
// Layout:
//   ╔════ KOVA · report compare ════╗
//      [verdict]  N regressions · M improved · K affected · baseline → current
//      run meta strip (baseline / current / delta)
//
//   ─── scenarios ──────────────────────────────────────────────────────────
//      scenario   samples   verdict      Δ      worst metric
//
//   ─── <scenario> ───────────────── [REGRESSED] · transition ───
//      Findings  (sign-prefixed)
//      Metrics   (baseline → current · Δ · status)
//
//   ─── next ───
//      → kova report <current>
//      → kova report compare <current> <newer>
//
// Source data is the comparison object from compareReports() unchanged.

import {
  makeUi, ruleSection, renderKovaHeader, withMargin,
  metricsTable, scenariosRollup, scenarioRule, findingsBlock,
} from "../ui/index.mjs";

import {
  rollupScenarios, pickAffectedScenarios, scenarioMetricRows,
  shapeFindingsForCompare, runVerdict, compareMetricRowOrder,
} from "./compare-aggregate.mjs";
import { METRIC_LABELS } from "./scenario-aggregate.mjs";

const TOP_AFFECTED_SCENARIOS = 8;
const TOP_METRICS_PER_SCENARIO = 6;
const TOP_FINDINGS = 12;
const TOP_RESOURCE_MISMATCHES = 6;
const TOP_SKIPPED_RESOURCE_METRICS = 6;

export function renderCompareAssessment(comparison, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  return withMargin(renderCompareFromComparison(comparison, ui, { full: !!flags.full }), ui.leftPad);
}

export function renderCompareFromComparison(comparison, ui, opts = {}) {
  const isFull = !!opts.full;
  const sections = [];

  sections.push(renderHeader(comparison, ui));
  sections.push("");
  sections.push(renderMetaStrip(comparison, ui));

  const resourceComparison = renderResourceComparison(comparison, ui, isFull);
  if (resourceComparison) { sections.push(""); sections.push(resourceComparison); }

  const rollup = renderRollup(comparison, ui);
  if (rollup) { sections.push(""); sections.push(rollup); }

  const scenarios = renderAffectedScenarios(comparison, ui, isFull);
  if (scenarios) { sections.push(""); sections.push(scenarios); }

  const findings = renderFindings(comparison, ui, isFull);
  if (findings) { sections.push(""); sections.push(findings); }

  sections.push("");
  sections.push(renderNext(comparison, ui));
  return sections.join("\n");
}

// ─── header band ─────────────────────────────────────────────────────────────

function renderHeader(comparison, ui) {
  const verdict = runVerdict(comparison);
  const regressions = comparison.regressionCount ?? 0;
  const improvements = comparison.improvementCount ?? 0;
  const affected = pickAffectedScenarios(comparison).length;
  const resourceMismatches = comparison.resourceContractMismatchCount ?? 0;

  const parts = [];
  if (regressions > 0) parts.push(`${regressions} regression${regressions === 1 ? "" : "s"}`);
  if (improvements > 0) parts.push(`${improvements} improved`);
  if (affected > 0) parts.push(`${affected} affected`);
  if (resourceMismatches > 0) parts.push(`${resourceMismatches} resource contract mismatch${resourceMismatches === 1 ? "" : "es"}`);
  if (parts.length === 0) parts.push("no changes");
  const headline = parts.join(` ${ui.g.sep} `);

  return renderKovaHeader({
    surface: "report compare",
    verdict: badgeVerdict(verdict),
    headline,
    meta: formatTargetArrow(comparison, ui),
    ui,
  });
}

function badgeVerdict(verdict) {
  // renderKovaHeader expects a short status word; map compare-only verdicts
  // onto the palette it already understands.
  if (verdict === "REGRESSED" || verdict === "FAIL") return "FAIL";
  if (verdict === "IMPROVED") return "PASS";
  if (verdict === "UNCHANGED") return "DRY-RUN";
  return verdict;
}

function formatTargetArrow(comparison, ui) {
  const b = truncateTarget(comparison.baseline?.target ?? "—", ui);
  const c = truncateTarget(comparison.current?.target ?? "—", ui);
  return `${b} ${ui.g.arrow} ${c}`;
}

function truncateTarget(target, ui) {
  const t = String(target ?? "");
  if (t.length <= 30) return t;
  const ell = ui && ui.ascii ? "..." : "…";
  const colonIdx = t.indexOf(":");
  if (colonIdx >= 0 && colonIdx < 20) {
    const prefix = t.slice(0, colonIdx + 1);
    const tail = t.slice(-(30 - prefix.length - ell.length));
    return `${prefix}${ell}${tail}`;
  }
  return t.slice(0, 30 - ell.length) + ell;
}

// ─── meta strip ──────────────────────────────────────────────────────────────

function renderMetaStrip(comparison, ui) {
  const { c, g } = ui;
  const baseline = comparison.baseline ?? {};
  const current = comparison.current ?? {};
  const regressions = comparison.regressionCount ?? 0;
  const improvements = comparison.improvementCount ?? 0;
  const affected = pickAffectedScenarios(comparison).length;
  const resourceMismatches = comparison.resourceContractMismatchCount ?? 0;
  const skippedResourceMetrics = comparison.skippedMetricCount ?? 0;

  const rows = [
    ["baseline", truncateTarget(baseline.target ?? "—", ui), baseline.runId ?? ""],
    ["current",  truncateTarget(current.target ?? "—", ui),  current.runId ?? ""],
  ];
  const labelW = 10;
  const targetW = Math.max(8, ...rows.map((r) => r[1].length));
  const lines = rows.map(([label, target, runId]) => {
    const pad1 = " ".repeat(Math.max(1, labelW - label.length));
    const pad2 = " ".repeat(Math.max(2, targetW + 4 - target.length));
    return `  ${c.dim(label)}${pad1}${target}${pad2}${c.dim(runId)}`;
  });

  const deltaParts = [];
  if (regressions > 0) deltaParts.push(c.err(`${regressions} regression${regressions === 1 ? "" : "s"}`));
  if (improvements > 0) deltaParts.push(c.ok(`+${improvements} improved`));
  if (regressions === 0 && improvements === 0 && resourceMismatches === 0) deltaParts.push(c.dim("no changes"));
  if (affected > 0) deltaParts.push(c.dim(`${affected} scenario${affected === 1 ? "" : "s"} affected`));
  if (resourceMismatches > 0) {
    deltaParts.push(c.warn(`${resourceMismatches} resource contract mismatch${resourceMismatches === 1 ? "" : "es"}`));
    deltaParts.push(c.dim(`${skippedResourceMetrics} metric${skippedResourceMetrics === 1 ? "" : "s"} skipped`));
  }
  const sep = `  ${c.dim(g.sep)}  `;
  lines.push(`  ${c.dim("delta")}${" ".repeat(Math.max(1, labelW - "delta".length))}${deltaParts.join(sep)}`);

  return lines.join("\n");
}

// ─── resource comparison contract ───────────────────────────────────────────

function renderResourceComparison(comparison, ui, isFull) {
  const all = (comparison.scenarios ?? []).filter((scenario) => scenario.resourceComparison?.compatible === false);
  if (all.length === 0) return null;

  const visible = isFull ? all : all.slice(0, TOP_RESOURCE_MISMATCHES);
  const skippedCount = comparison.skippedMetricCount ?? all.reduce(
    (count, scenario) => count + (scenario.skippedMetrics?.length ?? 0),
    0
  );
  const lines = [
    ruleSection("resource contracts", ui.width, ui),
    "",
    `  ${ui.c.warn(ui.g.warn)} ${all.length} mismatch${all.length === 1 ? "" : "es"} ${ui.c.dim(ui.g.sep)} ${skippedCount} metric${skippedCount === 1 ? "" : "s"} skipped`
  ];

  for (const scenario of visible) {
    const resource = scenario.resourceComparison;
    const metrics = scenario.skippedMetrics ?? [];
    const shownMetrics = isFull ? metrics : metrics.slice(0, TOP_SKIPPED_RESOURCE_METRICS);
    const hiddenMetricCount = metrics.length - shownMetrics.length;
    const metricText = [
      shownMetrics.join(", "),
      hiddenMetricCount > 0 ? `+${hiddenMetricCount} more` : null
    ].filter(Boolean).join(", ") || "none";
    lines.push(`  ${ui.c.head(scenario.key)}`);
    lines.push(`    ${ui.c.dim("contract")} ${formatResourceIdentity(resource.baseline)} ${ui.g.arrow} ${formatResourceIdentity(resource.current)}`);
    lines.push(`    ${ui.c.dim("skipped ")} ${metricText}`);
  }

  const hiddenMismatchCount = all.length - visible.length;
  if (hiddenMismatchCount > 0) {
    lines.push(`  ${ui.c.dim(`+ ${hiddenMismatchCount} more resource contract mismatch${hiddenMismatchCount === 1 ? "" : "es"} (--full)`)}`);
  }
  return lines.join("\n");
}

function formatResourceIdentity(identity) {
  if (!identity) return "missing";
  const value = `${identity.measurementScope ?? "unknown-scope"}/${identity.headlineContract ?? "unknown-contract"}`;
  return identity.mixed ? `${value} (mixed)` : value;
}

// ─── scenarios roll-up ───────────────────────────────────────────────────────

function renderRollup(comparison, ui) {
  const rows = rollupScenarios(comparison).map((r) => ({
    id: r.id,
    passed: Math.max(0, (r.totalSamples ?? 0) - (r.failedSamples ?? 0)) || undefined,
    total: r.totalSamples || undefined,
    verdict: r.verdict,
    delta: formatScenarioDelta(r),
    worst: formatWorstRegression(r.worst),
  }));
  if (rows.length === 0) return null;
  const sec = [ruleSection("scenarios", ui.width, ui), "", scenariosRollup({ rows, compare: true, ui })];
  return sec.join("\n");
}

function formatScenarioDelta(r) {
  if (r.regressionCount > 0) return `+${r.regressionCount}`;
  if (r.verdict === "IMPROVED") return "-0";
  return "";
}

function formatWorstRegression(reg) {
  if (!reg) return null;
  if (reg.kind === "status") {
    const label = reg.message && reg.message.length <= 60
      ? reg.message
      : `${reg.baseline ?? "?"} → ${reg.current ?? "?"}`;
    return { label, tone: "err" };
  }
  if (reg.kind === "metric") {
    const label = compareMetricLabel(reg.metric);
    const ratio = reg.tolerance ? (reg.delta / reg.tolerance) : null;
    const note = ratio != null && Number.isFinite(ratio)
      ? `${ratio.toFixed(1)}× tol`
      : "regressed";
    return { label, note, tone: "err" };
  }
  if (reg.kind === "coverage") {
    const label = reg.message && reg.message.length <= 60 ? reg.message : "coverage gap";
    return { label, tone: "warn" };
  }
  const msg = reg.message ?? "";
  return { label: msg.length > 60 ? `${msg.slice(0, 57)}…` : msg, tone: "err" };
}

function compareMetricLabel(metric) {
  const value = metric ?? "metric";
  const suffix = String(value).match(/^(.*)\.(median|max|p95)$/);
  if (!suffix) {
    return METRIC_LABELS[value] ?? value;
  }
  const base = METRIC_LABELS[suffix[1]] ?? suffix[1];
  return `${base}.${suffix[2]}`;
}

// ─── findings ────────────────────────────────────────────────────────────────

function renderFindings(comparison, ui, isFull) {
  const findings = shapeFindingsForCompare(comparison);
  if (findings.length === 0) return null;
  const block = findingsBlock({ findings, compare: true, ui, limit: isFull ? null : TOP_FINDINGS });
  if (!block) return null;
  return [ruleSection("findings", ui.width, ui), "", block].join("\n");
}

// ─── per-scenario regression blocks ──────────────────────────────────────────

function renderAffectedScenarios(comparison, ui, isFull) {
  const all = pickAffectedScenarios(comparison);
  const affected = isFull ? all : all.slice(0, TOP_AFFECTED_SCENARIOS);
  if (affected.length === 0) return null;
  const out = [];
  for (const r of affected) {
    out.push(scenarioRule({
      id: r.id,
      verdict: r.verdict,
      samples: formatTransition(r),
      ui,
    }));
    const scenarioStates = (comparison.scenarios ?? []).filter((s) => (s.scenario ?? s.key) === r.id);
    const rows = mergeMetricRows(scenarioStates, isFull ? Infinity : TOP_METRICS_PER_SCENARIO);
    if (rows.length > 0) {
      out.push("");
      out.push(metricsTable({ rows, compare: true, ui }));
    }
    out.push("");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const hidden = all.length - affected.length;
  if (hidden > 0) {
    out.push("");
    out.push(`  ${ui.c.dim(`+ ${hidden} more affected scenario${hidden === 1 ? "" : "s"} (--full)`)}`);
  }
  return out.join("\n");
}

function formatTransition(r) {
  // Show "FAIL → FAIL" or "PASS → FAIL" as the sample-count label.
  if (r.baselineStatus || r.currentStatus) {
    return `${r.baselineStatus ?? "—"} → ${r.currentStatus ?? "—"}`;
  }
  return null;
}

function mergeMetricRows(scenarioStates, limit) {
  // When a scenario has multiple state buckets, merge by metric id taking
  // the worst regression. compareReports already separates by state, so we
  // just collapse here for the single per-scenario block.
  const byMetric = new Map();
  for (const s of scenarioStates) {
    for (const row of scenarioMetricRows(s, { limit: limit * 2 })) {
      const existing = byMetric.get(row.id);
      if (!existing || compareMetricRowOrder(row, existing) < 0) {
        byMetric.set(row.id, row);
      }
    }
  }
  return [...byMetric.values()]
    .sort(compareMetricRowOrder)
    .slice(0, limit);
}

// ─── next hint ───────────────────────────────────────────────────────────────

function renderNext(comparison, ui) {
  const { c, g } = ui;
  const hints = [];
  const currentRun = comparison.current?.runId;
  const baselineRun = comparison.baseline?.runId;
  if (currentRun) hints.push(`kova report ${currentRun}`);
  if (baselineRun && currentRun) hints.push(`kova report bundle ${currentRun}`);
  if (hints.length === 0) return "";
  const lines = [ruleSection("next", ui.width, ui), ""];
  for (const h of hints) lines.push(`  ${c.dim(g.arrow)} ${h}`);
  return lines.join("\n");
}
