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

import { measurementMetricValue } from "../health.mjs";
import { summarizeSamples, classifyConfidence } from "../ui/confidence.mjs";

// Metrics we always surface (when present) as scenario headline metrics,
// even if they have no threshold attached. Order = display order.
export const HEADLINE_METRICS = [
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

export const METRIC_LABELS = {
  agentTurnMs: "agent.turn.ms",
  coldReadyMs: "cold.ready.ms",
  warmReadyMs: "warm.ready.ms",
  timeToListeningMs: "listening.ms",
  timeToHealthReadyMs: "health.ready.ms",
  healthP95Ms: "health.p95.ms",
  readinessListeningMs: "readiness.listen.ms",
  readinessHealthReadyMs: "readiness.health.ms",
  startupHealthP95Ms: "start.health.p95.ms",
  postReadyHealthP95Ms: "post.health.p95.ms",
  startupHealthFailures: "start.health.failures",
  postReadyHealthFailures: "post.health.failures",
  finalHealthFailures: "final.health.failures",
  peakRssMb: "gateway.rss.mb",
  cpuPercentMax: "cpu.max.%",
  eventLoopDelayMs: "event-loop.max.ms",
  openclawEventLoopMaxMs: "timeline.loop.ms",
  openclawTimelineEventCount: "timeline.events",
  openclawTimelineParseErrors: "timeline.parse.errors",
  openclawSlowestSpanMs: "timeline.slowest.ms",
  openclawRepeatedSpanCount: "repeated.spans",
  openclawProviderRequestMaxMs: "timeline.provider.max.ms",
  openclawChildProcessFailedCount: "timeline.child.failures",
  statusMs: "status.ms",
  pluginsListMs: "plugins.list.ms",
  modelsListMs: "models.list.ms",
  resourceSampleCount: "resource.samples",
  resourceCpuPercentMaxTracked: "tracked.total.cpu.%",
  resourcePeakTrackedRssMb: "tracked.total.rss.mb",
  resourcePeakCommandTreeRssMb: "command.tree.rss.mb",
  resourcePeakGatewayRssMb: "gateway.rss.mb",
};

export const METRIC_UNITS = {
  agentTurnMs: "ms",
  coldReadyMs: "ms",
  warmReadyMs: "ms",
  timeToListeningMs: "ms",
  timeToHealthReadyMs: "ms",
  healthP95Ms: "ms",
  readinessListeningMs: "ms",
  readinessHealthReadyMs: "ms",
  startupHealthP95Ms: "ms",
  postReadyHealthP95Ms: "ms",
  startupHealthFailures: "",
  postReadyHealthFailures: "",
  finalHealthFailures: "",
  peakRssMb: "MB",
  cpuPercentMax: "%",
  eventLoopDelayMs: "ms",
  openclawEventLoopMaxMs: "ms",
  openclawTimelineEventCount: "",
  openclawTimelineParseErrors: "",
  openclawSlowestSpanMs: "ms",
  openclawRepeatedSpanCount: "",
  openclawProviderRequestMaxMs: "ms",
  openclawChildProcessFailedCount: "",
  statusMs: "ms",
  pluginsListMs: "ms",
  modelsListMs: "ms",
  resourceSampleCount: "",
  resourceCpuPercentMaxTracked: "%",
  resourcePeakTrackedRssMb: "MB",
  resourcePeakCommandTreeRssMb: "MB",
  resourcePeakGatewayRssMb: "MB",
};

// Direction lookup: for everything we track, lower is better.
// We expose this so callers (compare renderer) can color deltas correctly
// without re-encoding the rule.
export function metricDirection(_id) {
  return "lower-better";
}

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
      fixtureAccounting: aggregateFixtureAccounting(samples),
      findings: findingsByScenario.get(id) ?? [],
      proves: deriveProves(first, verdict),
      worst: findWorstViolation(samples),
    });
  }

  // Failure-first: failed/blocked first, then incomplete, then pass
  out.sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict));
  return out;
}

function aggregateFixtureAccounting(samples) {
  const accountings = samples
    .map((sample) => sample.stateFixtureAccounting)
    .filter((accounting) => accounting && typeof accounting === "object");
  if (accountings.length === 0) {
    return null;
  }

  const latest = accountings[accountings.length - 1];
  return {
    schemaVersion: "kova.fixtureAccountingScenarioSummary.v1",
    sampleCount: accountings.length,
    stateId: latest.stateId ?? null,
    kind: latest.kind ?? null,
    files: latest.files ?? [],
    findings: latest.findings ?? [],
    artifactPath: latest.artifactPath ?? null,
  };
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
      if (results.some((r) => commandResultFailed(r))) anyFail = true;
    }
    const stats = summarizeSamples(elapsedSamples);
    return {
      id: phaseId,
      status: anyFail ? "FAIL" : elapsedSamples.length > 0 ? "PASS" : "SKIPPED",
      elapsedMs: stats.median,
    };
  });
}

function commandResultFailed(result) {
  if (!result) {
    return false;
  }
  if (result.timedOut === true) {
    return true;
  }
  if (typeof result.status === "number") {
    return result.status !== 0;
  }
  if (typeof result.exitCode === "number") {
    return result.exitCode !== 0;
  }
  const status = String(result.status ?? "").toUpperCase();
  return status === "FAIL" || status === "FAILED" || status === "ERROR";
}

function aggregateMetrics(samples) {
  // Collect every metric mentioned in a violation, plus the curated
  // headline metrics that have at least one numeric value present.
  const metrics = new Map();
  // Role-scoped violations attach as child rows under their parent metric
  // (e.g. resourceByRole.runtime-management.peakRssMb is a child of peakRssMb).
  // Surfacing them in the metrics table prevents the contradictory shape
  // where the top-level metric reads PASS while findings say FAIL.
  const roleChildren = new Map(); // parentKey -> Map<role, {role, threshold, actual}>

  // Violated metrics first (with threshold + status)
  for (const s of samples) {
    for (const v of s.violations ?? []) {
      if (!v.metric) continue;
      const roleMatch = v.metric.match(/^resourceByRole\.([^.]+)\.(.+)$/);
      if (roleMatch) {
        const [, role, parentKey] = roleMatch;
        // Ensure the parent metric appears in the table so the children
        // have a row to nest under, even if its sample-level status PASSed.
        if (!metrics.has(parentKey)) {
          metrics.set(parentKey, {
            label: metricLabel(parentKey, samples),
            unit: METRIC_UNITS[parentKey] ?? null,
            direction: "lower-better",
            threshold: null,
            status: "PASS",
          });
        }
        if (!roleChildren.has(parentKey)) roleChildren.set(parentKey, new Map());
        const byRole = roleChildren.get(parentKey);
        if (!byRole.has(role)) {
          const actualNum = typeof v.actual === "number" ? v.actual : Number(v.actual);
          byRole.set(role, {
            role,
            threshold: parseThreshold(v.expected),
            actual: Number.isFinite(actualNum) ? actualNum : null,
          });
        }
        continue;
      }
      if (v.kind !== "threshold") continue;
      const key = v.metric;
      if (!metrics.has(key)) {
        metrics.set(key, {
          label: metricLabel(key, samples),
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
    const values = samples.map((s) => measurementMetricValue(s.measurements ?? {}, key)).filter((v) => v != null);
    if (values.length === 0) continue;
    metrics.set(key, {
      label: metricLabel(key, samples),
      unit: METRIC_UNITS[key] ?? null,
      direction: "lower-better",
      threshold: null,
      status: "PASS",
    });
  }

  const rows = [];
  for (const [key, meta] of metrics) {
    const values = samples.map((s) => measurementMetricValue(s.measurements ?? {}, key)).filter((v) => v != null && Number.isFinite(Number(v)));
    if (values.length === 0 && !roleChildren.has(key)) continue;
    const stats = values.length > 0 ? summarizeSamples(values) : null;
    const hasFailedRoleChild = roleChildren.has(key);
    const thresholdStatus = meta.threshold !== null && stats?.max !== null && stats?.max !== undefined
      ? stats.max > meta.threshold ? "FAIL" : "PASS"
      : hasFailedRoleChild ? "FAIL" : meta.status;
    rows.push({
      key,
      label: meta.label,
      unit: meta.unit,
      direction: meta.direction,
      value: stats && stats.n === 1 ? stats.median : null,
      stats: stats && stats.n > 1 ? { median: stats.median, stdev: stats.stdev, p95: stats.p95, max: stats.max } : null,
      threshold: meta.threshold,
      status: thresholdStatus,
    });
    // Emit per-role child rows directly after their parent. Each child
    // carries its own threshold + FAIL status so the row tells the full
    // story without forcing the reader to cross-reference findings.
    const children = roleChildren.get(key);
    if (children) {
      for (const child of children.values()) {
        rows.push({
          key: `${key}#${child.role}`,
          parentKey: key,
          label: `  ↳ ${child.role}`,
          unit: meta.unit,
          direction: meta.direction,
          value: child.actual,
          stats: null,
          threshold: child.threshold,
          status: "FAIL",
          isChild: true,
        });
      }
    }
  }
  return rows;
}

function metricLabel(key, samples) {
  if (key !== "peakRssMb") {
    return METRIC_LABELS[key] ?? key;
  }
  const gateKinds = new Set((samples ?? [])
    .map((sample) => sample.measurements?.resourceGateKind)
    .filter((kind) => typeof kind === "string" && kind.length > 0));
  if (gateKinds.size === 1 && gateKinds.has("tracked-total")) {
    return "tracked.total.rss.mb";
  }
  const roles = new Set((samples ?? [])
    .map((sample) => sample.measurements?.resourcePrimaryRole)
    .filter((role) => typeof role === "string" && role.length > 0));
  if (roles.size === 1) {
    const role = [...roles][0];
    return role === "tracked-total" ? "tracked.total.rss.mb" : `${role}.rss.mb`;
  }
  return METRIC_LABELS.peakRssMb;
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
    if (!v) {
      continue;
    }
    const summary = summarizeViolation(v, s.measurements ?? {});
    if (summary) {
      return summary;
    }
  }
  return null;
}

// Surface one claim per scenario derived from its declared objective.
// The objective sentence rides on every record (set by the runner), so
// we read it from the first sample and stamp the scenario verdict on it.
// status SKIPPED → no objective sentence on record (rare).
function deriveProves(record, verdict) {
  const objective = typeof record?.objective === "string" ? record.objective.trim() : "";
  if (!objective) return [];
  const status = verdict === "PASS" ? "PASS"
    : verdict === "FAIL" ? "FAIL"
    : verdict === "BLOCKED" ? "BLOCKED"
    : verdict === "DRY-RUN" ? "SKIPPED"
    : "INCOMPLETE";
  return [{ claim: objective, status }];
}

// Compact worst-metric headline for rollup tables. Trades the raw
// violation message (which can be 100+ chars of prose) for a tight
// "<metric.label> · <actual>${unit} > <threshold>${unit}" form when
// kind=threshold, falling back to a truncated message otherwise.
function summarizeViolation(v, measurements = {}) {
  const metricKey = v.metric ?? null;
  const label = (metricKey && METRIC_LABELS[metricKey]) || metricKey || "violation";
  const unit = (metricKey && METRIC_UNITS[metricKey]) || "";
  const tone = "err";

  if (v.kind === "threshold") {
    const actualValue = metricKey ? measurementMetricValue(measurements, metricKey) ?? v.actual : v.actual;
    const thresholdValue = parseThreshold(v.expected);
    if (typeof actualValue === "number" && thresholdValue !== null && actualValue <= thresholdValue) {
      return null;
    }
    const actual = formatMetricNumber(actualValue);
    const threshold = thresholdValue === null ? null : formatMetricNumber(thresholdValue);
    if (actual !== null && threshold !== null) {
      return { label, note: `${actual}${unit} > ${threshold}${unit}`, tone };
    }
  }

  const msg = typeof v.message === "string" ? v.message : "";
  // The rollup renderer (scenarios-rollup.mjs) will move long prose notes
  // onto a full-width continuation line below the row, so keep most of the
  // message intact here. Only guard against pathological lengths.
  const trimmed = msg.length > 140 ? `${msg.slice(0, 137)}…` : msg;
  return { label, note: trimmed, tone };
}

function formatMetricNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 10) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatThreshold(expected) {
  const n = parseThreshold(expected);
  return n == null ? null : formatMetricNumber(n);
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
