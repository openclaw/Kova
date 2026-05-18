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
// table; threshold is omitted (compareReports uses tolerance, not absolute
// thresholds; status comes from regressions list).
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
    const deltaPct = (typeof b === "number" && b !== 0 && typeof cur === "number")
      ? ((cur - b) / Math.abs(b)) * 100
      : null;
    const reg = regressionByMetric.get(id);
    rows.push({
      id,
      label: compareMetricLabel(id),
      unit: METRIC_UNITS[parsed.base] ?? null,
      direction: metricDirection(parsed.base),
      baseline: b,
      current: cur,
      delta: deltaPct,
      threshold: reg?.tolerance ?? null,
      status: reg ? "OVER" : (deltaPct != null && deltaPct < -1 ? "PASS" : "—"),
      headline: HEADLINE_METRICS.includes(parsed.base),
      regressed: !!reg,
    });
  }

  rows.sort((a, b) => {
    // Regressed first
    if (a.regressed !== b.regressed) return a.regressed ? -1 : 1;
    // Then by signed delta magnitude (worse = bigger positive for lower-better)
    const aw = worseness(a);
    const bw = worseness(b);
    if (aw !== bw) return bw - aw;
    // Headline metrics tiebreak
    if (a.headline !== b.headline) return a.headline ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return rows.slice(0, limit);
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
  for (const f of fc.new ?? []) out.push(toFindingRow(f, "+"));
  for (const f of fc.resolved ?? []) out.push(toFindingRow(f, "-"));
  return out;
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
  if (row.delta == null) return -Infinity;
  return row.direction === "lower-better" ? row.delta : -row.delta;
}
