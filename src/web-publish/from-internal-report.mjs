/**
 * Project Kova's internal `kova.report.v1` shape into the public
 * `kova.web-payload.v1` release payload.
 *
 * This intentionally reuses the existing report summary and scenario
 * aggregation paths. Those modules already encode how Kova turns raw records
 * into phases, metrics, findings, and proof claims; publish should not create
 * a second interpretation of the same evidence.
 */

import { buildReportSummary } from "../reporting/report.mjs";
import {
  aggregateScenarios,
  METRIC_LABELS,
  METRIC_UNITS,
} from "../reporting/scenario-aggregate.mjs";
import { measurementMetricValue } from "../health.mjs";

const DEFAULT_HOST = "unknown";
const DEFAULT_SHA = "unknown";

const PREFERRED_SCENARIO_METRICS = new Map([
  ["release-runtime-startup", ["coldReadyMs", "readinessHealthReadyMs"]],
  ["fresh-install", ["coldReadyMs", "readinessHealthReadyMs"]],
  ["gateway-performance", ["postReadyHealthP95Ms", "readinessHealthReadyMs", "coldReadyMs"]],
  ["agent-cold-warm-message", ["agentTurnMs", "coldAgentTurnMs", "warmAgentTurnMs", "agentPreProviderMs"]],
  ["agent-gateway-rpc-turn", ["agentTurnMs", "agentPreProviderMs"]],
  ["gateway-session-send-turn", ["agentTurnMs", "coldAgentTurnMs", "warmAgentTurnMs", "agentPreProviderMs"]],
  ["openai-compatible-turn", ["agentTurnMs", "agentPreProviderMs"]],
  ["channel-model-turn-baseline", ["agentTurnMs", "agentPreProviderMs"]],
  ["tui-message-turn", ["readinessHealthReadyMs", "coldReadyMs", "postReadyHealthP95Ms"]],
  ["dashboard-readiness", ["readinessHealthReadyMs", "postReadyHealthP95Ms", "coldReadyMs"]],
  ["plugin-lifecycle", ["coldReadyMs", "readinessHealthReadyMs", "warmReadyMs"]],
  ["bundled-runtime-deps", ["coldReadyMs", "readinessHealthReadyMs", "warmReadyMs"]],
  ["bundled-plugin-startup", ["coldReadyMs", "readinessHealthReadyMs", "warmReadyMs"]],
]);

const PUBLIC_SCENARIO_LABELS = {
  "release-runtime-startup": "Startup",
  "fresh-install": "Fresh Install",
  "gateway-performance": "GW P95",
  "gateway-session-send-turn": "Session Send",
  "agent-cold-warm-message": "Agent Run",
  "agent-gateway-rpc-turn": "Agent Run",
  "openai-compatible-turn": "OpenAI Turn",
  "channel-model-turn-baseline": "Channel Turn",
  "tui-message-turn": "TUI Ready",
  "dashboard-readiness": "Dashboard Ready",
  "plugin-lifecycle": "Plugin Health",
  "bundled-runtime-deps": "Runtime Deps",
  "bundled-plugin-startup": "Plugin Startup",
};

const PUBLIC_SCENARIO_THRESHOLDS = {
  "release-runtime-startup": 1500,
  "fresh-install": 1000,
  "gateway-performance": 290,
  "gateway-session-send-turn": 2500,
  "agent-cold-warm-message": 7500,
  "agent-gateway-rpc-turn": 2500,
  "openai-compatible-turn": 2500,
  "channel-model-turn-baseline": 7500,
  "tui-message-turn": 4500,
  "dashboard-readiness": 2000,
  "plugin-lifecycle": 1500,
  "bundled-runtime-deps": 1500,
  "bundled-plugin-startup": 1500,
};

const PUBLIC_SCENARIO_ORDER = [
  "release-runtime-startup",
  "fresh-install",
  "gateway-session-send-turn",
  "agent-cold-warm-message",
  "channel-model-turn-baseline",
  "tui-message-turn",
  "dashboard-readiness",
  "gateway-performance",
  "openai-compatible-turn",
  "bundled-plugin-startup",
  "bundled-runtime-deps",
  "plugin-lifecycle",
];

const HEADLINE_SPECS = [
  {
    label: "startup",
    scenarioId: "release-runtime-startup",
    metric: "startup.s",
    metricKeys: ["coldReadyMs", "readinessHealthReadyMs"],
    unit: "s",
    convert: (v) => round(v / 1000, 2),
  },
  {
    label: "agent turn",
    scenarioId: "gateway-session-send-turn",
    metric: "agent.turn.s",
    metricKeys: ["agentTurnMs", "coldAgentTurnMs"],
    unit: "s",
    convert: (v) => round(v / 1000, 2),
  },
  {
    label: "pre-provider",
    scenarioId: "gateway-session-send-turn",
    metric: "agent.pre_provider.s",
    metricKeys: ["agentPreProviderMs", "coldPreProviderMs"],
    unit: "s",
    convert: (v) => round(v / 1000, 2),
  },
  {
    label: "gw.p95",
    scenarioId: "gateway-performance",
    metric: "health.p95.ms",
    metricKeys: ["postReadyHealthP95Ms", "healthP95Ms", "startupHealthP95Ms"],
    unit: "ms",
    convert: (v) => round(v, 0),
  },
];

const PUBLIC_METRIC_LABELS = {
  agentTurnMs: "full turn",
  coldAgentTurnMs: "cold turn",
  warmAgentTurnMs: "warm turn",
  agentPreProviderMs: "pre-provider",
  coldPreProviderMs: "cold pre-provider",
  warmPreProviderMs: "warm pre-provider",
  agentProviderFinalMs: "provider",
  coldProviderFinalMs: "cold provider",
  warmProviderFinalMs: "warm provider",
  agentPostProviderMs: "post-provider",
  preProviderDominanceRatio: "pre-provider share",
  postReadyHealthP95Ms: "gw.p95",
  healthP95Ms: "gw.p95",
  startupHealthP95Ms: "startup p95",
  coldReadyMs: "startup",
  readinessHealthReadyMs: "startup",
  readinessListeningMs: "listening",
  warmReadyMs: "warm ready",
  dashboardConnectMs: "dashboard",
  tuiSmokeMs: "tui",
};

const PUBLIC_METRIC_UNITS = {
  agentPreProviderMs: "ms",
  coldPreProviderMs: "ms",
  warmPreProviderMs: "ms",
  agentProviderFinalMs: "ms",
  coldProviderFinalMs: "ms",
  warmProviderFinalMs: "ms",
  agentPostProviderMs: "ms",
};

/**
 * @param {any} report kova.report.v1
 * @param {{ ver?: string, releaseDate?: string|Date, sha?: string }} metadata
 * @returns {import("../web-payload-contract.mjs").WebPayloadRelease}
 */
export function projectInternalReport(report, metadata = {}) {
  if (!report || report.schemaVersion !== "kova.report.v1") {
    throw new Error("projectInternalReport expected schemaVersion kova.report.v1");
  }

  const releaseDate = resolveReleaseDate(metadata.releaseDate ?? report.releaseDate ?? report.generatedAt);
  const ver = metadata.ver ?? report.ver ?? versionFromTarget(report.target);
  if (!ver) {
    throw new Error("kova publish: --ver is required for internal reports when report.target is not an npm:<version> selector");
  }

  const summary = buildReportSummary(report);
  const scenarios = aggregateScenarios(report, summary.findings);
  const orderedScenarios = orderPublicScenarios(scenarios);
  const records = report.records ?? [];

  return pruneUndefined({
    ver,
    releaseDate: releaseDate.toISOString().slice(0, 10),
    date: formatReleaseDate(releaseDate),
    sha: metadata.sha ?? report.sha ?? shaFromTarget(report.target) ?? DEFAULT_SHA,
    passed: summary.decision?.ok === true,
    runCount: records.length,
    host: hostFromReport(report),
    runtimeTargets: runtimeTargetsFromReport(report),
    headline: projectHeadlines(records),
    scenarios: orderedScenarios.map((scenario) => projectScenarioSummary(scenario, records)),
    runs: [projectRun(report, summary, orderedScenarios, records)],
  });
}

function orderPublicScenarios(scenarios) {
  const rank = new Map(PUBLIC_SCENARIO_ORDER.map((id, index) => [id, index]));
  return [...scenarios].sort((a, b) => {
    const ar = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const br = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    return String(a.id).localeCompare(String(b.id));
  });
}

function projectRun(report, summary, scenarios, records) {
  const startedAt = firstDate(records.map((r) => r.startedAt)) ?? new Date(report.generatedAt ?? Date.now());
  const finishedAt = lastDate(records.map((r) => r.finishedAt));
  const durationMs = finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : sumRecordPhaseMs(records);

  return pruneUndefined({
    id: report.runId ?? "internal-report",
    runtime: String(report.target ?? "unknown"),
    profile: normalizeProfile(report.profile) ?? normalizeProfile(summary.run?.profile) ?? "single",
    startedAt: startedAt.toISOString(),
    durationMs: round(durationMs, 0),
    entryCount: records.length,
    state: stateFromVerdict(summary.decision?.verdict),
    host: hostFromReport(report),
    command: commandFromReport(report),
    expandedByDefault: false,
    scenarios: scenarios.map((scenario) => projectRunScenario(scenario, records)),
  });
}

function projectScenarioSummary(scenario, records) {
  const headline = publicScenarioHeadline(scenario, chooseScenarioHeadline(scenario, records));
  return pruneUndefined({
    id: scenario.id,
    metric: headline.metric,
    value: headline.value,
    unit: headline.unit,
    threshold: headline.threshold,
    state: stateFromVerdict(scenario.verdict),
    spark: headline.spark,
    lowerIsBetter: true,
    worstMetric: headline.worstMetric,
  });
}

function projectRunScenario(scenario, records) {
  const headline = publicScenarioHeadline(scenario, chooseScenarioHeadline(scenario, records));
  return pruneUndefined({
    id: scenario.id,
    state: stateFromVerdict(scenario.verdict),
    sampleCount: scenario.total ?? 0,
    sampleValue: headline.value ?? undefined,
    sampleUnit: headline.unit || undefined,
    phases: (scenario.phases ?? []).map((phase) => ({
      name: phase.id,
      elapsedMs: round(Number(phase.elapsedMs) || 0, 0),
      state: stateFromVerdict(phase.status),
    })),
    metrics: projectMetricRows(scenario, records),
    findings: (scenario.findings ?? []).map(projectFinding),
    proves: (scenario.proves ?? []).map(projectProve),
  });
}

function projectMetricRow(metric) {
  const value = metric.value ?? metric.stats?.median ?? null;
  const name = publicMetricLabel(metric.key, metric.label ?? metric.key);
  return pruneUndefined({
    name,
    value: numericOrNull(value),
    unit: metric.unit ?? PUBLIC_METRIC_UNITS[metric.key] ?? "",
    threshold: numericOrNull(metric.threshold),
    state: stateFromVerdict(metric.status),
    child: metric.isChild === true ? true : undefined,
  });
}

function projectMetricRows(scenario, records) {
  const rows = [];
  const samples = records.filter((record) => record.scenario === scenario.id);
  const primaryRows = projectTurnMetricRows(scenario, samples);
  rows.push(...primaryRows);
  const usedNames = new Set(primaryRows.map((row) => row.name));
  const aggregateMetrics = scenario.metrics ?? [];
  for (const violation of violationMetrics(samples, aggregateMetrics)) {
    const row = projectViolationMetricRow(violation);
    if (!usedNames.has(row.name)) {
      rows.push(row);
      usedNames.add(row.name);
    }
  }
  for (const metric of aggregateMetrics) {
    const row = projectMetricRow(metric);
    if (usedNames.has(row.name)) continue;
    rows.push(row);
    usedNames.add(row.name);
  }
  return rows;
}

function projectTurnMetricRows(scenario, samples) {
  if (!isAgentTurnScenario(scenario.id) || samples.length === 0) return [];
  const rows = [
    aggregateDirectMetricRow(samples, "agentTurnMs", "full turn", "agentTurnMs"),
    aggregateDirectMetricRow(samples, "coldAgentTurnMs", "cold turn", "coldAgentTurnMs"),
    aggregateDirectMetricRow(samples, "warmAgentTurnMs", "warm turn", "warmAgentTurnMs"),
    aggregateDirectMetricRow(samples, "agentPreProviderMs", "pre-provider", "preProviderMs"),
    aggregateDirectMetricRow(samples, "agentProviderFinalMs", "provider", "providerFinalMs"),
    aggregateDirectMetricRow(samples, "agentPostProviderMs", "post-provider", null),
  ].filter(Boolean);

  if (scenario.id === "gateway-session-send-turn" || scenario.surface === "gateway-session-send-turn") {
    rows.push(...aggregateSessionTurnRows(samples));
  }

  return rows;
}

function aggregateDirectMetricRow(records, metricKey, name, thresholdKey) {
  const values = records
    .map((record) => measurementMetricValue(record.measurements ?? {}, metricKey))
    .map(numericOrNull)
    .filter((value) => value != null);
  if (values.length === 0) return null;
  const value = median(values);
  const thresholds = thresholdKey
    ? records.map((record) => numericOrNull(record.thresholds?.[thresholdKey])).filter((threshold) => threshold != null)
    : [];
  const threshold = median(thresholds);
  return pruneUndefined({
    name,
    value,
    unit: PUBLIC_METRIC_UNITS[metricKey] ?? METRIC_UNITS[metricKey] ?? "ms",
    threshold,
    state: metricState(value, threshold),
  });
}

function aggregateSessionTurnRows(records) {
  const valuesByName = new Map();
  for (const record of records) {
    for (const turn of record.measurements?.agentTurns ?? []) {
      const label = turn.label ? `${turn.label} ` : "";
      appendMetricSample(valuesByName, `${label}send rpc`, turn.gatewaySession?.sendDurationMs);
      appendMetricSample(valuesByName, `${label}matched assistant`, turn.gatewaySession?.timeToMatchedAssistantMs);
    }
  }
  return [...valuesByName].map(([name, values]) => ({
    name: `↳ ${name}`,
    value: median(values),
    unit: "ms",
    threshold: null,
    state: "pass",
    child: true,
  }));
}

function appendMetricSample(samplesByName, name, value) {
  const n = numericOrNull(value);
  if (n == null) return;
  const samples = samplesByName.get(name) ?? [];
  samples.push(n);
  samplesByName.set(name, samples);
}

function isAgentTurnScenario(scenarioId) {
  return /agent|turn|gateway-session/.test(String(scenarioId ?? ""));
}

function metricState(value, threshold) {
  if (threshold == null || value == null) return "pass";
  return value > threshold ? "fail" : "pass";
}

function projectViolationMetricRow(violation) {
  const metricKey = normalizeViolationMetricKey(violation.metric);
  const rawValue = numericOrNull(violation.actual);
  const rawThreshold = parseThreshold(violation.expected ?? violation.threshold);
  const normalizedValue = normalizeMetricValue(metricKey, rawValue, PUBLIC_METRIC_UNITS[metricKey] ?? METRIC_UNITS[metricKey] ?? "");
  const normalizedThreshold = normalizeMetricValue(metricKey, rawThreshold, normalizedValue.unit);
  return pruneUndefined({
    name: publicMetricLabel(metricKey, violationMetricLabel(violation.metric)),
    value: normalizedValue.value,
    unit: normalizedValue.unit,
    threshold: normalizedThreshold.value,
    state: "fail",
    child: String(violation.metric ?? "").startsWith("resourceByRole.") ? true : undefined,
  });
}

function projectFinding(finding) {
  return pruneUndefined({
    kind: findingKind(finding.severity),
    text: finding.summary ?? "scenario finding",
    scenarioId: finding.scenario ?? undefined,
    metric: finding.metric ?? undefined,
  });
}

function projectProve(prove) {
  return {
    state: prove.status === "PASS" ? "pass" : "fail",
    text: prove.claim ?? "scenario objective",
    scenarioId: prove.scenario ?? undefined,
  };
}

function chooseScenarioHeadline(scenario, records) {
  const metrics = scenario.metrics ?? [];
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  for (const key of PREFERRED_SCENARIO_METRICS.get(scenario.id) ?? ["agentTurnMs", "coldReadyMs", "peakRssMb"]) {
    const metric = byKey.get(key);
    if (metric && (metric.value != null || metric.stats?.median != null)) {
      return attachWorstMetric(headlineFromMetric(metric, scenario, records), scenario, records);
    }
    const direct = directScenarioMetric(scenario.id, records, key);
    if (direct) return attachWorstMetric(direct, scenario, records);
  }

  const violation = findHeadlineViolation(scenario.id, records);
  if (violation) return headlineFromViolation(violation, scenario);

  const failed = metrics.find((m) =>
    m.status === "FAIL" &&
    (m.value != null || m.stats?.max != null || m.stats?.median != null) &&
    (m.threshold != null || m.key?.includes("responseOk"))
  );
  if (failed) {
    return headlineFromMetric(failed, scenario);
  }

  const firstNumeric = metrics.find((m) => m.value != null || m.stats?.median != null);
  if (firstNumeric) return headlineFromMetric(firstNumeric, scenario, records);

  return {
    metric: undefined,
    value: null,
    unit: "",
    threshold: 0,
    spark: null,
    worstMetric: undefined,
  };
}

function publicScenarioHeadline(scenario, headline) {
  const metric = PUBLIC_SCENARIO_LABELS[scenario.id] ?? headline.metric;
  const threshold = PUBLIC_SCENARIO_THRESHOLDS[scenario.id] ?? headline.threshold;
  return {
    ...headline,
    metric,
    threshold,
    worstMetric: headline.worstMetric ?? failureReasonMetric(scenario),
  };
}

function headlineFromViolation(violation, scenario) {
  const metricKey = normalizeViolationMetricKey(violation.metric);
  const rawValue = numericOrNull(violation.actual);
  const rawThreshold = parseThreshold(violation.expected ?? violation.threshold);
  const value = normalizeMetricValue(metricKey, rawValue, METRIC_UNITS[metricKey] ?? "");
  const threshold = normalizeMetricValue(metricKey, rawThreshold, value.unit);
  return {
    metric: publicMetricLabel(metricKey, violationMetricLabel(violation.metric)),
    value: value.value,
    unit: value.unit,
    threshold: threshold.value ?? value.value ?? 0,
    spark: value.value == null ? null : [value.value],
    worstMetric: value.value == null ? undefined : {
      name: violationMetricLabel(violation.metric),
      value: value.value,
      unit: value.unit,
    },
  };
}

function headlineFromMetric(metric, scenario, records = []) {
  const raw = metric.stats?.median ?? metric.value ?? metric.stats?.max ?? null;
  const normalized = normalizeMetricValue(metric.key, raw, metric.unit);
  const thresholdRaw = metric.threshold ?? directThreshold(scenario.id, records, metric.key);
  const threshold = normalizeMetricValue(metric.key, thresholdRaw, metric.unit).value;
  const label = publicMetricLabel(metric.key, metric.label ?? METRIC_LABELS[metric.key] ?? metric.key);
  const unit = normalized.unit || metric.unit || METRIC_UNITS[metric.key] || "";
  const spark = metricSpark(metric, scenario, records, unit, normalized.value);

  return {
    metric: label,
    value: normalized.value,
    unit,
    threshold: threshold ?? normalized.value ?? 0,
    spark: spark && spark.length > 0 ? spark : null,
    worstMetric: metric.status === "FAIL" && normalized.value != null
      ? { name: label, value: normalized.value, unit }
      : undefined,
  };
}

function directScenarioMetric(scenarioId, records, metricKey) {
  const samples = records.filter((r) => r.scenario === scenarioId);
  const values = samples
    .map((r) => measurementMetricValue(r.measurements ?? {}, metricKey))
    .filter((v) => Number.isFinite(Number(v)))
    .map(Number);
  if (values.length === 0) return null;
  const value = median(values);
  const unit = PUBLIC_METRIC_UNITS[metricKey] ?? METRIC_UNITS[metricKey] ?? "";
  const normalized = normalizeMetricValue(metricKey, value, unit);
  const threshold = normalizeMetricValue(metricKey, directThreshold(scenarioId, records, metricKey), unit).value;
  return {
    metric: publicMetricLabel(metricKey),
    value: normalized.value,
    unit: normalized.unit,
    threshold: threshold ?? normalized.value ?? 0,
    spark: values.map((v) => normalizeMetricValue(metricKey, v, unit).value).filter((v) => v != null),
    worstMetric: undefined,
  };
}

function metricSpark(metric, scenario, records, unit, fallbackValue) {
  const aggregateSamples = metric.stats?.samples;
  if (Array.isArray(aggregateSamples) && aggregateSamples.length > 0) {
    return aggregateSamples.map((v) => normalizeMetricValue(metric.key, v, unit).value).filter((v) => v != null);
  }

  const recordSamples = metricSamplesFromRecords(scenario.id, records, metric.key, unit);
  if (recordSamples.length > 0) return recordSamples;
  return fallbackValue == null ? null : [fallbackValue];
}

function metricSamplesFromRecords(scenarioId, records, metricKey, unit) {
  return records
    .filter((record) => record.scenario === scenarioId)
    .map((record) => measurementMetricValue(record.measurements ?? {}, metricKey))
    .filter((value) => Number.isFinite(Number(value)))
    .map((value) => normalizeMetricValue(metricKey, Number(value), unit).value)
    .filter((value) => value != null);
}

function attachWorstMetric(headline, scenario, records) {
  if (headline?.worstMetric || scenario.verdict !== "FAIL") return headline;
  const violation = findHeadlineViolation(scenario.id, records);
  if (!violation) {
    const reason = failureReasonMetric(scenario);
    return reason ? { ...headline, worstMetric: reason } : headline;
  }
  const metricKey = normalizeViolationMetricKey(violation.metric);
  const rawValue = numericOrNull(violation.actual);
  const value = normalizeMetricValue(metricKey, rawValue, METRIC_UNITS[metricKey] ?? "");
  if (value.value == null) return headline;
  return {
    ...headline,
    worstMetric: {
      name: publicMetricLabel(metricKey, violationMetricLabel(violation.metric)),
      value: value.value,
      unit: value.unit,
    },
  };
}

function failureReasonMetric(scenario) {
  if (scenario.verdict !== "FAIL") return undefined;
  const text = (scenario.findings ?? []).find((finding) => finding.severity === "blocking" || finding.severity === "fail")?.summary
    ?? (scenario.findings ?? [])[0]?.summary;
  const reason = publicFailureReason(text);
  return reason ? { name: reason, value: 0, unit: "" } : undefined;
}

function publicFailureReason(text) {
  const s = String(text ?? "");
  if (!s) return "";
  if (/pre-provider work dominated/i.test(s)) return "pre-provider share";
  if (/without a usable assistant response|did not produce the expected assistant response/i.test(s)) return "no assistant response";
  if (/no .*provider request/i.test(s)) return "no provider request";
  if (/final gateway state was restarting/i.test(s)) return "gateway restarting";
  return s.length > 34 ? `${s.slice(0, 31)}...` : s;
}

function directThreshold(scenarioId, records, metricKey) {
  const normalizedKey = thresholdMetricKey(metricKey);
  const keys = thresholdMetricKeys(normalizedKey);
  const rec = records.find((r) => r.scenario === scenarioId && keys.some((key) => r.thresholds?.[key] != null));
  if (rec) {
    const key = keys.find((candidate) => rec.thresholds?.[candidate] != null);
    return key ? rec.thresholds[key] : null;
  }
  return null;
}

function thresholdMetricKey(metricKey) {
  if (metricKey?.startsWith("resourceByRole.")) return "peakRssMb";
  switch (metricKey) {
    case "agentPreProviderMs":
      return "preProviderMs";
    case "agentProviderFinalMs":
      return "providerFinalMs";
    default:
      return metricKey;
  }
}

function thresholdMetricKeys(metricKey) {
  switch (metricKey) {
    case "coldReadyMs":
    case "readinessHealthReadyMs":
      return [metricKey, "gatewayReadyMs"];
    case "postReadyHealthP95Ms":
    case "healthP95Ms":
      return [metricKey, "postReadyHealthP95Ms", "healthP95Ms"];
    default:
      return [metricKey];
  }
}

function findHeadlineViolation(scenarioId, records) {
  const samples = records.filter((record) => record.scenario === scenarioId);
  return samples
    .flatMap((record) => record.violations ?? [])
    .find((violation) => {
      const actual = numericOrNull(violation.actual);
      return actual != null && (parseThreshold(violation.expected ?? violation.threshold) != null || violation.metric === "preProviderDominanceRatio");
    }) ?? null;
}

function violationMetrics(samples, aggregateMetrics) {
  const rows = [];
  for (const record of samples) {
    for (const violation of record.violations ?? []) {
      const actual = numericOrNull(violation.actual);
      if (actual == null) continue;
      const threshold = parseThreshold(violation.expected ?? violation.threshold);
      if (threshold == null && violation.metric !== "preProviderDominanceRatio") continue;
      if (hasEquivalentFailedMetric(aggregateMetrics, violation)) continue;
      rows.push(violation);
    }
  }
  return rows;
}

function hasEquivalentFailedMetric(metrics, violation) {
  const key = String(violation.metric ?? "");
  const normalizedKey = normalizeViolationMetricKey(key);
  const actual = normalizeMetricValue(normalizedKey, numericOrNull(violation.actual), METRIC_UNITS[normalizedKey] ?? "").value;
  return metrics.some((metric) => {
    if (metric.status !== "FAIL") return false;
    if (metric.key !== key && metric.key !== normalizedKey) return false;
    const value = normalizeMetricValue(metric.key, metric.value ?? metric.stats?.max ?? metric.stats?.median, metric.unit).value;
    return value === actual;
  });
}

function normalizeViolationMetricKey(metric) {
  const key = String(metric ?? "");
  const roleMatch = key.match(/^resourceByRole\.[^.]+\.(.+)$/);
  return roleMatch?.[1] ?? key;
}

function violationMetricLabel(metric) {
  const key = String(metric ?? "");
  const roleMatch = key.match(/^resourceByRole\.([^.]+)\.(.+)$/);
  if (roleMatch) return `↳ ${roleMatch[1]}`;
  if (key === "peakRssMb") return "peak.rss.mb";
  if (key === "preProviderDominanceRatio") return "preProvider share";
  return (METRIC_LABELS[key] ?? key) || "violation";
}

function projectHeadlines(records) {
  const out = [];
  for (const spec of HEADLINE_SPECS) {
    const hit = spec.worstAcrossScenarios
      ? worstRecordMetric(records, spec.metricKeys)
      : aggregateScenarioMetric(records, spec.scenarioId, spec.metricKeys);
    if (!hit) continue;
    out.push({
      label: spec.label,
      value: spec.convert(hit.value),
      unit: spec.unit,
      lowerIsBetter: true,
      scenarioId: hit.record.scenario,
      metric: spec.metric,
    });
  }
  return out;
}

function aggregateScenarioMetric(records, scenarioId, keys) {
  const samples = records.filter((record) => record.scenario === scenarioId);
  for (const key of keys) {
    const values = samples
      .map((record) => measurementMetricValue(record.measurements ?? {}, key))
      .filter((value) => Number.isFinite(Number(value)))
      .map(Number);
    if (values.length > 0) {
      return { record: samples[0], key, value: median(values) };
    }
  }
  return null;
}

function worstRecordMetric(records, keys) {
  let best = null;
  for (const record of records) {
    for (const key of keys) {
      const value = measurementMetricValue(record.measurements ?? {}, key);
      if (!Number.isFinite(Number(value))) continue;
      if (!best || Number(value) > best.value) best = { record, key, value: Number(value) };
    }
    for (const violation of record.violations ?? []) {
      if (!String(violation.metric ?? "").endsWith("peakRssMb")) continue;
      const actual = Number(violation.actual);
      if (!Number.isFinite(actual)) continue;
      if (!best || actual > best.value) best = { record, key: violation.metric, value: actual };
    }
  }
  return best;
}

function normalizeMetricValue(metricKey, value, unitHint = "") {
  const n = numericOrNull(value);
  if (n == null) return { value: null, unit: unitHint || PUBLIC_METRIC_UNITS[metricKey] || METRIC_UNITS[metricKey] || "" };
  if (metricKey === "preProviderDominanceRatio") {
    return { value: round(n * 100, 1), unit: "%" };
  }
  return { value: round(n, Math.abs(n) >= 100 ? 0 : 2), unit: unitHint || PUBLIC_METRIC_UNITS[metricKey] || METRIC_UNITS[metricKey] || "" };
}

function publicMetricLabel(metricKey, fallback = metricKey) {
  return PUBLIC_METRIC_LABELS[metricKey] ?? fallback ?? metricKey;
}

function stateFromVerdict(verdict) {
  switch (String(verdict ?? "").toUpperCase()) {
    case "PASS":
    case "SHIP":
      return "pass";
    case "FAIL":
    case "DO_NOT_SHIP":
      return "fail";
    default:
      return "block";
  }
}

function findingKind(severity) {
  switch (String(severity ?? "").toLowerCase()) {
    case "blocking":
    case "fail":
    case "blocked":
    case "incomplete":
      return "fail";
    case "warning":
    case "diagnostic-gap":
      return "warn";
    default:
      return "info";
  }
}

function runtimeTargetsFromReport(report) {
  return [report.target, report.from].filter((v) => typeof v === "string" && v.length > 0);
}

function hostFromReport(report) {
  if (typeof report.host === "string" && report.host.length > 0) return report.host;
  const p = report.platform;
  if (!p) return DEFAULT_HOST;
  return [p.os, p.arch].filter(Boolean).join("/") || DEFAULT_HOST;
}

function commandFromReport(report) {
  const profile = normalizeProfile(report.profile);
  if (profile) return `kova matrix run --profile ${profile} --target ${report.target ?? "unknown"} --execute`;
  const scenario = report.records?.[0]?.scenario;
  if (scenario) return `kova run --target ${report.target ?? "unknown"} --scenario ${scenario} --execute`;
  return undefined;
}

function normalizeProfile(profile) {
  if (!profile) return null;
  if (typeof profile === "string") return profile;
  return profile.id ?? profile.name ?? profile.title ?? null;
}

function versionFromTarget(target) {
  const match = String(target ?? "").match(/^npm:(.+)$/);
  return match?.[1] ?? null;
}

function shaFromTarget(target) {
  return versionFromTarget(target) ?? null;
}

function resolveReleaseDate(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`kova publish: invalid release date ${JSON.stringify(value)}`);
  }
  return date;
}

function formatReleaseDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function firstDate(values) {
  return values
    .map((v) => v ? new Date(v) : null)
    .filter((d) => d && Number.isFinite(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

function lastDate(values) {
  const dates = values
    .map((v) => v ? new Date(v) : null)
    .filter((d) => d && Number.isFinite(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return dates[0] ?? null;
}

function sumRecordPhaseMs(records) {
  let total = 0;
  for (const record of records) {
    for (const phase of record.phases ?? []) {
      for (const result of phase.results ?? []) {
        total += Number(result.durationMs) || 0;
      }
    }
  }
  return total;
}

function numericOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseThreshold(expected) {
  if (expected == null) return null;
  if (typeof expected === "number") return expected;
  const match = String(expected).match(/(-?[\d.]+)/);
  return match ? Number(match[1]) : null;
}

function round(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return value;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function pruneUndefined(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
