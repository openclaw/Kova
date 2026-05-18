// `kova report` renderer — the showcase surface.
//
// Renders the scenario-spine assessment from a report JSON:
//
//   ╔═══════════════════════════════════════════════════╗
//   ║  KOVA  ·  report                                  ║
//   ╚═══════════════════════════════════════════════════╝
//      [FAIL]  1/3 scenarios failed · 5 samples · stable (±3%)
//      run kova-2026-… · target runtime:stable · profile smoke
//
//   ─── scenarios ───────────────────────────────────────
//   scenario          samples  verdict   worst metric
//     fresh-install   5/5      PASS      —
//     agent-cold-warm 4/5      FAIL      agent.turn.ms over by 240 ms
//
//   ─── agent-cold-warm ─────────── [FAIL] · 5 samples ───
//     Phases:   (table)
//     Metrics:  (table — auto-picks columns by sample count)
//     Findings: (list)
//     Proves:   (list, when present)
//
//   ─── next ────────────────────────────────────────────
//     → kova report --full <path>
//
// Compact (default): scenario blocks render only for failed/blocked
// scenarios; passed ones collapse into the roll-up.
// --full: every scenario gets a full block.

import {
  makeUi, ruleSection, renderKovaHeader,
  scenariosRollup, scenarioRule, metricsTable, phasesBlock,
  findingsBlock, provesBlock, buildVerdictHeadline,
  withMargin,
} from "../ui/index.mjs";
import { buildReportSummary } from "./report.mjs";
import { aggregateScenarios, runConfidence } from "./scenario-aggregate.mjs";

// Compact mode keeps Phases + Metrics (top-5 with role children) for a
// "what does this scenario look like" snapshot, and drops Findings +
// Proves (those are full-mode deep-dive material). `--full` restores
// everything.
const TOP_METRICS_COMPACT = 5;

// Slice metrics for compact mode while keeping role-child rows attached
// to their parent. Counting only top-level (non-child) rows toward the
// budget preserves the parent/child grouping in the output.
function compactMetricSlice(metrics, budget) {
  const out = [];
  let topCount = 0;
  for (const m of metrics) {
    if (m.isChild) {
      if (out.length > 0) out.push(m);
      continue;
    }
    if (topCount >= budget) break;
    out.push(m);
    topCount += 1;
  }
  return out;
}

export function renderAssessment(report, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const summary = buildReportSummary(report);
  const scenarios = aggregateScenarios(report, summary.findings);
  const isFull = !!flags.full;
  return withMargin(renderFromSummary({ summary, scenarios, isFull }, ui), ui.leftPad);
}

// Exposed for tests and downstream callers.
export function renderFromSummary(input, ui) {
  // Back-compat: callers used to pass just the summary; accept that too.
  const summary = input.summary ?? input;
  const scenarios = input.scenarios ?? aggregateScenarios({ records: [] }, summary.findings);
  const isFull = input.isFull ?? false;

  const sections = [];
  sections.push(renderHeader(summary, scenarios, ui));
  sections.push("");
  sections.push(renderMeta(summary, ui));

  const rollup = renderScenariosRollup(scenarios, ui);
  if (rollup) {
    sections.push("");
    sections.push(ruleSection("scenarios", ui.width, ui));
    sections.push(indentBlock(rollup, 2));
  }

  const showSingleCompactPass = !isFull && scenarios.length === 1 && scenarios[0]?.verdict === "PASS";
  for (const sc of scenarios) {
    if (!isFull && sc.verdict === "PASS" && !showSingleCompactPass) continue;
    sections.push("");
    sections.push(renderScenarioBlock(sc, ui, isFull));
  }

  const next = renderNext(summary, scenarios, isFull, ui);
  if (next) {
    sections.push("");
    sections.push(ruleSection("next", ui.width, ui));
    sections.push(next);
  }
  return sections.join("\n");
}

// ----- header / meta -----

function renderHeader(summary, scenarios, ui) {
  const verdict = String(summary.decision?.verdict ?? "UNKNOWN").toUpperCase();
  const shipLabel = deriveVerdictBadge(verdict, summary);
  const conf = runConfidence(scenarios);
  const failed = scenarios.filter((s) => s.verdict === "FAIL" || s.verdict === "BLOCKED").length;
  const incomplete = scenarios.filter((s) => s.verdict === "INCOMPLETE").length;
  const dryRun = scenarios.filter((s) => s.verdict === "DRY-RUN").length;
  const totalScn = scenarios.length;
  const sampleTotal = scenarios.reduce((a, s) => a + (s.total ?? 0), 0);
  const sampleFailed = scenarios
    .filter((s) => s.verdict === "FAIL" || s.verdict === "BLOCKED")
    .reduce((a, s) => a + Math.max(0, (s.total ?? 0) - (s.passed ?? 0)), 0);
  const sampleIncomplete = scenarios
    .filter((s) => s.verdict === "INCOMPLETE")
    .reduce((a, s) => a + Math.max(0, (s.total ?? 0) - (s.passed ?? 0)), 0);
  // Pluralize against the count actually referenced in each clause so
  // "1 scenario failed" reads correctly while "3 scenarios passed" still works.
  const scopeText = failed > 0
    ? `${failed} ${pluralize(failed, "scenario")} failed${totalScn > failed ? ` of ${totalScn}` : ""}`
    : incomplete > 0
      ? `${incomplete} ${pluralize(incomplete, "scenario")} incomplete${totalScn > incomplete ? ` of ${totalScn}` : ""}`
      : dryRun > 0
        ? `${dryRun} ${pluralize(dryRun, "scenario")} planned${totalScn > dryRun ? ` of ${totalScn}` : ""}`
        : `${totalScn} ${pluralize(totalScn, "scenario")} passed`;
  const samplesText = sampleFailed > 0
    ? `${sampleFailed}/${sampleTotal} ${pluralize(sampleTotal, "sample")} failed`
    : sampleIncomplete > 0
      ? `${sampleIncomplete}/${sampleTotal} ${pluralize(sampleTotal, "sample")} incomplete`
      : dryRun > 0
        ? `${sampleTotal} ${pluralize(sampleTotal, "sample")} planned`
        : `${sampleTotal} ${pluralize(sampleTotal, "sample")}`;

  const headline = buildVerdictHeadline({
    scope: scopeText,
    samples: samplesText,
    confidence: conf.label,
    sep: ui.g.sep,
  });

  return renderKovaHeader({
    surface: "report",
    verdict: shipLabel,
    headline,
    meta: "",
    ui,
  });
}

function renderMeta(summary, ui) {
  const { c, g } = ui;
  const sep = ` ${g.sep} `;
  const parts = [];
  if (summary.runId) parts.push(`run ${summary.runId}`);
  if (summary.target) parts.push(`target ${summary.target}`);
  const profile = normalizeProfile(summary.run?.profile);
  if (profile) parts.push(`profile ${profile}`);
  if (summary.reportGeneratedAt) parts.push(formatTimestamp(summary.reportGeneratedAt));
  if (parts.length === 0) return "";
  return "  " + c.dim(parts.join(sep));
}

function normalizeProfile(p) {
  if (!p) return null;
  if (typeof p === "string") return p;
  if (typeof p === "object") return p.id ?? p.name ?? p.title ?? null;
  return String(p);
}

function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch { return iso; }
}

function deriveVerdictBadge(verdict, summary) {
  if (summary.gate?.verdict) return String(summary.gate.verdict).toUpperCase();
  switch (verdict) {
    case "PASS": return "PASS";
    case "FAIL": return "FAIL";
    case "INCOMPLETE": return "PARTIAL";
    case "BLOCKED": return "BLOCKED";
    case "DRY_RUN":
    case "DRY-RUN":
      return "DRY-RUN";
    default: return verdict;
  }
}

// ----- scenarios roll-up -----

function renderScenariosRollup(scenarios, ui) {
  if (scenarios.length === 0) return "";
  const rows = scenarios.map((sc) => ({
    id: sc.id,
    passed: sc.passed,
    total: sc.total,
    verdict: sc.verdict,
    worst: sc.verdict === "PASS" ? null : sc.worst,
  }));
  return scenariosRollup({ rows, ui });
}

// ----- per-scenario block -----

function renderScenarioBlock(sc, ui, isFull) {
  const lines = [];
  lines.push(scenarioRule({ id: sc.id, verdict: sc.verdict, samples: sc.total, ui }));

  if (sc.phases && sc.phases.length > 0) {
    lines.push("");
    lines.push("  " + ui.c.dim("Phases"));
    lines.push(indentBlock(phasesBlock({ phases: sc.phases, ui }), 4));
  }

  const totalParents = countTopLevelMetrics(sc.metrics);
  const metricsToShow = isFull
    ? sc.metrics
    : compactMetricSlice(sc.metrics, TOP_METRICS_COMPACT);
  if (metricsToShow.length > 0) {
    lines.push("");
    lines.push("  " + ui.c.dim("Metrics"));
    lines.push(indentBlock(metricsTable({ rows: metricsToShow, sampleCount: sc.total, ui, indent: 4 }), 4));
    const hidden = totalParents - countTopLevelMetrics(metricsToShow);
    if (hidden > 0) lines.push("    " + ui.c.dim(`+ ${hidden} more metric${hidden === 1 ? "" : "s"} (--full)`));
  }

  if (isFull && sc.findings && sc.findings.length > 0) {
    lines.push("");
    lines.push("  " + ui.c.dim("Findings"));
    lines.push(indentBlock(findingsBlock({ findings: sc.findings, ui, limit: null, indent: 2 }), 2));
  }

  if (isFull && sc.proves && sc.proves.length > 0) {
    lines.push("");
    lines.push("  " + ui.c.dim("Proves"));
    lines.push(indentBlock(provesBlock({ claims: sc.proves, ui, indent: 2 }), 2));
  }

  return lines.join("\n");
}

function countTopLevelMetrics(metrics) {
  let n = 0;
  for (const m of metrics) if (!m.isChild) n += 1;
  return n;
}

// ----- next hint -----

function renderNext(summary, scenarios, isFull, ui) {
  const { c, g } = ui;
  const lines = [];
  if (!isFull && summary.runId) {
    lines.push(`  ${c.head(g.arrow)} ${c.dim("kova report --full")} ${c.met(reportPath(summary))}`);
  }
  const rec = summary.recommendedNextScenario;
  if (rec?.command) {
    lines.push(`  ${c.head(g.arrow)} ${c.met(rec.command)}`);
  }
  if (summary.runId) {
    lines.push(`  ${c.head(g.arrow)} ${c.dim("kova report bundle")} ${c.met(summary.runId)}`);
  }
  if (lines.length === 0) return "";
  return lines.join("\n");
}

function reportPath(summary) {
  return summary.runId ?? "<report.json>";
}

// ----- helpers -----

function pluralize(n, word) {
  return n === 1 ? word : word + "s";
}

function indentBlock(text, n) {
  const pad = " ".repeat(n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
