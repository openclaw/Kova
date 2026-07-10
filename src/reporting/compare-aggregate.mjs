// Compare-aggregate: shape compareReports() output for the scenario-spine
// primitives (scenariosRollup compare variant, scenarioRule, metricsTable
// compare variant, findingsBlock compare variant).
//
// compareReports() already groups records by (scenario,state) key and
// computes per-scenario regressions + per-metric baseline/current/delta.
// This module:
//   - rolls scenario rows up to one row per scenario id (collapsing state)
//   - picks the headline metric for each scenario
//   - shapes per-scenario metric rows for the compare table
//   - shapes finding rows with +/- signs
//
// Direction is always lower-better for the metrics we track today; see
// scenario-aggregate.metricDirection.

import { METRIC_LABELS, METRIC_UNITS, HEADLINE_METRICS, metricDirection } from "./scenario-aggregate.mjs";

const VERDICT_RANK = { FAIL: 0, BLOCKED: 0, REGRESSED: 1, NEW: 2, MISSING: 2, IMPROVED: 3, UNCHANGED: 4, OK: 5 };

// rollupScenarios(comparison) -> [{ id, verdict, baselineStatus, currentStatus,
//   regressionCount, totalMetrics, worst, samples }]
export function rollupScenarios(comparison) {
  const scenarios = comparison?.scenarios ?? [];
  const byId = new Map();
  for (const s of scenarios) {
    const id = s.scenario ?? s.key;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        states: [],
        regressionCount: 0,
        verdict: "UNCHANGED",
        baselineStatus: s.baselineStatus,
        currentStatus: s.currentStatus,
        worst: null,
        totalSamples: 0,
        failedSamples: 0,
      });
    }
    const acc = byId.get(id);
    acc.states.push(s);
    acc.regressionCount += s.regressions?.length ?? 0;
    acc.verdict = pickWorseVerdict(acc.verdict, s.status);
    acc.totalSamples += s.currentSampleCount ?? 0;
    acc.failedSamples += s.currentStatuses?.FAIL ?? 0;
    // Surface worst regression as the "worst metric" headline.
    const worst = pickWorstRegression(s.regressions);
    if (worst && (!acc.worst || worstSeverity(worst) > worstSeverity(acc.worst))) {
      acc.worst = worst;
    }
  }
  const rows = [...byId.values()].sort((a, b) => (VERDICT_RANK[a.verdict] ?? 9) - (VERDICT_RANK[b.verdict] ?? 9));
  return rows;
}

// pickAffectedScenarios(comparison) -> rollup rows with regressions/transitions
// only, in failure-first order.
export function pickAffectedScenarios(comparison) {
  return rollupScenarios(comparison).filter((r) =>
    r.regressionCount > 0 || r.verdict === "REGRESSED" || r.verdict === "NEW" || r.verdict === "MISSING"
  );
}

// scenarioMetricRows(comparisonScenario, limit) -> rows shaped for metricsTable
// compare variant: { label, unit, direction, baseline, current, delta, threshold, status }
//
// Strategy: rank metrics by signed delta (worse first), then prefer ones in
// HEADLINE_METRICS or in the regressions list. Use percent delta for the
// table; tolerance comes from compareReports when a metric has a configured
// compare gate.
export function scenarioMetricRows(scenario, { limit = 6 } = {}) {
  const metrics = scenario?.metrics ?? {};
  const regressionByMetric = new Map((scenario?.regressions ?? [])
    .filter((r) => r.kind === "metric")
    .map((r) => [r.metric, r]));

  const rows = [];
  for (const [id, m] of Object.entries(metrics)) {
    const parsed = parseStatMetricId(id);
    const b = m.baseline;
    const cur = m.current;
    if (b == null && cur == null) continue;
    // Resource contracts can change what RSS/CPU/sample values mean. Retain
    // the raw values, but never rank or present their deltas as comparable.
    if (m?.comparable === false) {
      rows.push({
        id,
        label: compareMetricLabel(id),
        unit: METRIC_UNITS[parsed.base] ?? null,
        direction: metricDirection(parsed.base),
        baseline: b,
        current: cur,
        delta: null,
        absoluteDelta: null,
        threshold: typeof m.tolerance === "number" ? m.tolerance : null,
        status: "SKIPPED",
        headline: HEADLINE_METRICS.includes(parsed.base),
        regressed: false,
        comparable: false,
      });
      continue;
    }
    const deltaPct = (typeof b === "number" && b !== 0 && typeof cur === "number")
      ? ((cur - b) / Math.abs(b)) * 100
      : null;
    const absoluteDelta = typeof b === "number" && typeof cur === "number" ? cur - b : null;
    const reg = regressionByMetric.get(id);
    const tolerance = typeof m.tolerance === "number" ? m.tolerance : reg?.tolerance ?? null;
    const status = compareMetricStatus({
      regressed: !!reg,
      deltaPct,
      absoluteDelta,
      direction: metricDirection(parsed.base),
      tolerance,
    });
    rows.push({
      id,
      label: compareMetricLabel(id),
      unit: METRIC_UNITS[parsed.base] ?? null,
      direction: metricDirection(parsed.base),
      baseline: b,
      current: cur,
      delta: deltaPct,
      absoluteDelta,
      threshold: tolerance,
      status,
      headline: HEADLINE_METRICS.includes(parsed.base),
      regressed: !!reg,
      comparable: true,
    });
  }

  return rows
    .filter((row) => row.status !== "—" || row.regressed)
    .sort(compareMetricRowOrder)
    .slice(0, limit);
}

export function compareMetricRowOrder(a, b) {
  const statusDelta = compareStatusRank(a) - compareStatusRank(b);
  if (statusDelta !== 0) return statusDelta;
  const scoreDelta = compareStatusScore(b) - compareStatusScore(a);
  if (scoreDelta !== 0) return scoreDelta;
  if (a.headline !== b.headline) return a.headline ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function compareMetricStatus({ regressed, deltaPct, absoluteDelta, direction, tolerance }) {
  if (regressed) return "OVER";
  const delta = deltaPct ?? absoluteDelta;
  if (typeof delta !== "number" || !Number.isFinite(delta)) return "—";
  if (!isMeaningfulDelta(deltaPct, absoluteDelta)) return "—";
  const worse = direction === "lower-better" ? delta > 0 : delta < 0;
  const better = direction === "lower-better" ? delta < 0 : delta > 0;
  if (typeof tolerance === "number" && Number.isFinite(tolerance)) {
    if (worse) {
      return Math.abs(absoluteDelta ?? delta) > tolerance ? "OVER" : "PASS";
    }
    if (better) return "PASS";
    return "—";
  }
  if (worse) return "WATCH";
  if (better) return "PASS";
  return "—";
}

function isMeaningfulDelta(deltaPct, absoluteDelta) {
  if (typeof deltaPct === "number" && Number.isFinite(deltaPct)) {
    return Math.abs(deltaPct) >= 1;
  }
  return typeof absoluteDelta === "number" && Number.isFinite(absoluteDelta) && absoluteDelta !== 0;
}

function compareStatusRank(row) {
  switch (row.status) {
    case "OVER": return 0;
    case "WATCH": return 1;
    case "PASS": return 2;
    case "SKIPPED": return 3;
    default: return 4;
  }
}

function compareStatusScore(row) {
  const score = Math.abs(worseness(row));
  return Number.isFinite(score) ? score : 0;
}

function parseStatMetricId(id) {
  const suffix = id.match(/^(.*)\.(median|max|p95)$/);
  if (!suffix) {
    return { base: id, stat: "median" };
  }
  return { base: suffix[1], stat: suffix[2] };
}

function compareMetricLabel(id) {
  const { base, stat } = parseStatMetricId(id);
  const baseLabel = METRIC_LABELS[base] ?? base;
  if (stat === "median") {
    return baseLabel;
  }
  return `${baseLabel}.${stat}`;
}

// shapeFindingsForCompare(comparison) -> [{ severity, summary, scope, ownerArea, sign }]
export function shapeFindingsForCompare(comparison) {
  const fc = comparison?.findingChanges ?? {};
  const out = [];
  for (const f of regressionFindings(comparison)) out.push(f);
  for (const f of fc.new ?? []) out.push(toFindingRow(f, "+"));
  for (const f of fc.resolved ?? []) out.push(toFindingRow(f, "-"));
  return out;
}

function regressionFindings(comparison) {
  const out = [];
  for (const scenario of comparison?.scenarios ?? []) {
    for (const regression of scenario.regressions ?? []) {
      out.push({
        sign: "+",
        severity: regression.kind === "coverage" ? "warning" : "fail",
        summary: regressionSummary(regression),
        scope: [scenario.scenario ?? scenario.key, scenario.state].filter(Boolean).join("/") || null,
        scenario: scenario.scenario ?? null,
        state: scenario.state ?? null,
        ownerArea: null,
        evidence: regressionEvidence(regression),
      });
    }
  }
  return out;
}

function regressionSummary(regression) {
  if (regression.kind === "metric") {
    const label = compareMetricLabel(regression.metric);
    const delta = typeof regression.delta === "number" ? signedNumber(regression.delta) : null;
    const values = `${formatPlainValue(regression.baseline)} -> ${formatPlainValue(regression.current)}`;
    return `${label}${delta ? ` ${delta}` : ""} (${values})`;
  }
  return regression.message ?? `${regression.kind ?? "compare"} regression`;
}

function regressionEvidence(regression) {
  const evidence = [];
  if (regression.kind === "metric" && regression.tolerance !== null && regression.tolerance !== undefined) {
    evidence.push(`tolerance ${regression.tolerance}`);
  }
  if (regression.message) {
    evidence.push(regression.message);
  }
  return evidence;
}

function signedNumber(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return `${value > 0 ? "+" : ""}${formatPlainValue(value)}`;
}

function formatPlainValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value == null ? "unknown" : String(value);
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function toFindingRow(f, sign) {
  return {
    sign,
    severity: f.severity ?? "warning",
    summary: f.summary ?? f.message ?? "",
    scope: f.scope ?? null,
    scenario: f.scenario ?? null,
    state: f.state ?? null,
    ownerArea: f.ownerArea ?? f.owner ?? null,
    evidence: f.evidence ?? [],
  };
}

// runVerdict(comparison) -> "FAIL" | "IMPROVED" | "UNCHANGED" | "PASS"
export function runVerdict(comparison) {
  if (!comparison?.ok) return "FAIL";
  if ((comparison.improvementCount ?? 0) > 0) return "IMPROVED";
  return "UNCHANGED";
}

// ---- internals ----

function pickWorseVerdict(a, b) {
  return (VERDICT_RANK[a] ?? 9) <= (VERDICT_RANK[b] ?? 9) ? a : b;
}

function pickWorstRegression(regs) {
  if (!regs || regs.length === 0) return null;
  // Prefer status regressions, then metric regressions with highest over-tolerance ratio.
  const status = regs.find((r) => r.kind === "status");
  if (status) return status;
  const metrics = regs.filter((r) => r.kind === "metric");
  if (metrics.length === 0) return regs[0];
  return metrics.slice().sort((a, b) => {
    const ra = (a.delta ?? 0) / (a.tolerance || 1);
    const rb = (b.delta ?? 0) / (b.tolerance || 1);
    return rb - ra;
  })[0];
}

function worstSeverity(reg) {
  if (!reg) return 0;
  if (reg.kind === "status") return 100;
  if (reg.kind === "metric") return (reg.delta ?? 0) / (reg.tolerance || 1);
  if (reg.kind === "coverage") return 50;
  return 1;
}

function worseness(row) {
  const delta = row.delta ?? row.absoluteDelta;
  if (delta == null) return -Infinity;
  return row.direction === "lower-better" ? delta : -delta;
}
