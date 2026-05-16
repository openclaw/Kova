// Groups flat report records into scenario-spine shape consumed by the
// scenario-block primitives. One scenario can hold N samples (records
// with the same scenario id). Per-scenario we compute:
//
//   - verdict (any sample FAIL → FAIL; any BLOCKED → BLOCKED; else PASS)
//   - sample/pass counts
//   - phases: per-phase median elapsed across samples (when present)
//   - metrics: violated metrics + a curated set of headline measurements,
//     each summarized across samples (median/σ/p95/max) with status from
//     threshold vs aggregated value
//   - findings filtered to this scenario
//
// Output is what the UI primitives expect, so the renderer is just glue.

import { summarizeSamples, classifyConfidence } from "../ui/confidence.mjs";

// Metrics we always surface (when present) as scenario headline metrics,
// even if they have no threshold attached. Order = display order.
const HEADLINE_METRICS = [
  "agentTurnMs",
  "coldReadyMs",
  "warmReadyMs",
  "timeToListeningMs",
  "timeToHealthReadyMs",
  "healthP95Ms",
  "peakRssMb",
  "cpuPercentMax",
  "eventLoopDelayMs",
];

const METRIC_LABELS = {
  agentTurnMs: "agent.turn.ms",
  coldReadyMs: "cold.ready.ms",
  warmReadyMs: "warm.ready.ms",
  timeToListeningMs: "listening.ms",
  timeToHealthReadyMs: "health.ready.ms",
  healthP95Ms: "health.p95.ms",
  peakRssMb: "peak.rss.mb",
  cpuPercentMax: "cpu.max.%",
  eventLoopDelayMs: "event-loop.max.ms",
};

const METRIC_UNITS = {
  agentTurnMs: "ms",
  coldReadyMs: "ms",
  warmReadyMs: "ms",
  timeToListeningMs: "ms",
  timeToHealthReadyMs: "ms",
  healthP95Ms: "ms",
  peakRssMb: "MB",
  cpuPercentMax: "%",
  eventLoopDelayMs: "ms",
};

// aggregateScenarios(report) -> [{ id, title, verdict, samples, passed,
//   phases, metrics, findings, ownerArea, confidence }]
export function aggregateScenarios(report, findings = []) {
  const records = report?.records ?? [];
  const findingsByScenario = groupFindingsByScenario(findings);

  const byScenario = new Map();
  for (const r of records) {
    const id = r.scenario ?? "(unknown)";
    if (!byScenario.has(id)) byScenario.set(id, []);
    byScenario.get(id).push(r);
  }

  const out = [];
  for (const [id, samples] of byScenario) {
    const passed = samples.filter((s) => s.status === "PASS").length;
    const failed = samples.filter((s) => s.status === "FAIL").length;
    const blocked = samples.filter((s) => s.status === "BLOCKED").length;
    const dryRun = samples.filter((s) => s.status === "DRY-RUN").length;
    const verdict = blocked > 0
      ? "BLOCKED"
      : failed > 0
        ? "FAIL"
        : dryRun === samples.length
          ? "DRY-RUN"
          : passed === samples.length
            ? "PASS"
            : "INCOMPLETE";
    const first = samples[0];

    out.push({
      id,
      title: first.title ?? id,
      surface: first.surface ?? null,
      ownerArea: first.likelyOwner ?? null,
      verdict,
      total: samples.length,
      passed,
      phases: aggregatePhases(samples),
      metrics: aggregateMetrics(samples),
      findings: findingsByScenario.get(id) ?? [],
      worst: findWorstViolation(samples),
    });
  }

  // Failure-first: failed/blocked first, then incomplete, then pass
  out.sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict));
  return out;
}

function verdictRank(v) {
  switch (v) {
    case "FAIL": return 0;
    case "BLOCKED": return 1;
    case "INCOMPLETE": return 2;
    case "PASS": return 3;
    default: return 4;
  }
}

function aggregatePhases(samples) {
  // The phase definition lives on every sample; per-sample results carry
  // command timing. We compute the median elapsed per phase across samples.
  const first = samples[0];
  if (!first?.phases || first.phases.length === 0) return [];

  return first.phases.map((phaseDef) => {
    const phaseId = phaseDef.id;
    const elapsedSamples = [];
    let anyFail = false;
    for (const s of samples) {
      const sp = (s.phases ?? []).find((p) => p.id === phaseId);
      const results = sp?.results ?? [];
      const total = results.reduce((acc, r) => acc + (Number(r.durationMs) || 0), 0);
      if (total > 0) elapsedSamples.push(total);
      if (results.some((r) => r.status === "FAIL" || r.exitCode > 0)) anyFail = true;
    }
    const stats = summarizeSamples(elapsedSamples);
    return {
      id: phaseId,
      status: anyFail ? "FAIL" : elapsedSamples.length > 0 ? "PASS" : "SKIPPED",
      elapsedMs: stats.median,
    };
  });
}

function aggregateMetrics(samples) {
  // Collect every metric mentioned in a violation, plus the curated
  // headline metrics that have at least one numeric value present.
  const metrics = new Map();

  // Violated metrics first (with threshold + status)
  for (const s of samples) {
    for (const v of s.violations ?? []) {
      if (v.kind !== "threshold" || !v.metric) continue;
      const key = v.metric;
      if (!metrics.has(key)) {
        metrics.set(key, {
          label: METRIC_LABELS[key] ?? key,
          unit: METRIC_UNITS[key] ?? null,
          direction: "lower-better",
          threshold: parseThreshold(v.expected),
          status: "FAIL",
        });
      }
    }
  }

  // Headline metrics — append when present, default status PASS
  for (const key of HEADLINE_METRICS) {
    if (metrics.has(key)) continue;
    const values = samples.map((s) => s.measurements?.[key]).filter((v) => v != null);
    if (values.length === 0) continue;
    metrics.set(key, {
      label: METRIC_LABELS[key] ?? key,
      unit: METRIC_UNITS[key] ?? null,
      direction: "lower-better",
      threshold: null,
      status: "PASS",
    });
  }

  const rows = [];
  for (const [key, meta] of metrics) {
    const values = samples.map((s) => s.measurements?.[key]).filter((v) => v != null && Number.isFinite(Number(v)));
    if (values.length === 0) continue;
    const stats = summarizeSamples(values);
    rows.push({
      key,
      label: meta.label,
      unit: meta.unit,
      direction: meta.direction,
      value: stats.n === 1 ? stats.median : null,
      stats: stats.n > 1 ? { median: stats.median, stdev: stats.stdev, p95: stats.p95, max: stats.max } : null,
      threshold: meta.threshold,
      status: meta.status,
    });
  }
  return rows;
}

function parseThreshold(expected) {
  if (expected == null) return null;
  if (typeof expected === "number") return expected;
  const m = String(expected).match(/(-?[\d.]+)/);
  return m ? Number(m[1]) : null;
}

function findWorstViolation(samples) {
  for (const s of samples) {
    const v = (s.violations ?? [])[0];
    if (v) {
      return {
        label: v.message ?? v.metric ?? "violation",
        tone: "err",
      };
    }
  }
  return null;
}

function groupFindingsByScenario(findings) {
  const out = new Map();
  for (const f of findings ?? []) {
    const key = f.scenario ?? "(global)";
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(f);
  }
  return out;
}

// Aggregate scenario-level confidence from all numeric headline metrics
// (worst CV wins, so the verdict line reflects the noisiest signal).
export function scenarioConfidence(scenario) {
  let worst = null;
  let n = 0;
  for (const m of scenario.metrics ?? []) {
    if (!m.stats) continue;
    const cv = m.stats.stdev != null && m.stats.median ? Math.abs(m.stats.stdev / m.stats.median) : null;
    if (cv != null && (worst == null || cv > worst)) worst = cv;
  }
  n = scenario.total ?? 1;
  return classifyConfidence({ n, cv: worst });
}

// Run-wide confidence (worst CV across all scenarios).
export function runConfidence(scenarios) {
  let n = 0;
  let worst = null;
  for (const sc of scenarios) {
    n = Math.max(n, sc.total ?? 1);
    for (const m of sc.metrics ?? []) {
      if (!m.stats || m.stats.median == null || m.stats.stdev == null || m.stats.median === 0) continue;
      const cv = Math.abs(m.stats.stdev / m.stats.median);
      if (worst == null || cv > worst) worst = cv;
    }
  }
  return classifyConfidence({ n, cv: worst });
}
