// kova report compare <baseline> <current> - dashboard view.
// Consumes the comparison object from compareReports() unchanged.
//
// Layout (approved mock):
//   ╔══════════════════════════════════════════════════════════════════════╗
//   ║ [FAIL]  57 regressions · 5 scenarios   npm:2026.5.7 → 2026.5.16-beta ║
//   ╚══════════════════════════════════════════════════════════════════════╝
//     baseline   <target>    <runId>
//     current    <target>    <runId>
//     delta      −N regressions · +M improvements · K scenarios affected
//
//   ─── findings ───────────────── <scope> · N new ──
//       ✗  <message>                                threshold <tol>
//       ▲  <message>
//
//   ─── metric regressions ──────── <scope> · K scn ──
//     ▒ <state> · sample <n>                            PASS → FAIL
//       metric              from      to        Δ      over tol   bar
//       coldReadyMs          779   16946  +16 167      21.7×      ▇▇▇▇▇▇▇

import {
  makeUi, ruleSection, renderTable, renderKovaHeader,
  visualWidth, repeat, wrap, withMargin, formatNumber, severityGlyph,
} from "../ui/index.mjs";

const TOP_FINDINGS_PER_SCOPE = 6;
const TOP_REGRESSION_SCENARIOS = 8;
const TOP_METRICS_PER_SCENARIO = 6;
const BAR_WIDTH = 7;

export function renderCompareAssessment(comparison, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  return withMargin(renderCompareFromComparison(comparison, ui), ui.leftPad);
}

export function renderCompareFromComparison(comparison, ui) {
  const sections = [];

  sections.push(renderHeader(comparison, ui));
  sections.push("");
  sections.push(renderMetaStrip(comparison, ui));

  const findings = renderFindingChanges(comparison, ui);
  if (findings) { sections.push(""); sections.push(findings); }

  const regressions = renderScenarioRegressions(comparison, ui);
  if (regressions) { sections.push(""); sections.push(regressions); }

  const srcRel = renderSourceRelease(comparison, ui);
  if (srcRel) { sections.push(""); sections.push(srcRel); }

  sections.push("");
  sections.push(renderFooter(comparison, ui));
  return sections.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Band: verdict + headline count + selector arrow

function renderHeader(comparison, ui) {
  const regressions = comparison.regressionCount ?? 0;
  const scenarioCount = countAffectedScenarios(comparison);
  const verdict = comparison.ok ? "OK" : "FAIL";

  let headline;
  if (comparison.ok) {
    headline = "no regressions";
  } else {
    const parts = [`${regressions} regression${regressions === 1 ? "" : "s"}`];
    if (scenarioCount > 0) parts.push(`${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"}`);
    headline = parts.join(` ${ui.g.sep} `);
  }

  return renderKovaHeader({
    surface: "report compare",
    verdict,
    headline,
    meta: formatTargetArrow(comparison, ui),
    ui,
  });
}

function formatTargetArrow(comparison, ui) {
  const b = truncateTarget(comparison.baseline?.target ?? "—", ui);
  const c = truncateTarget(comparison.current?.target ?? "—", ui);
  return `${b} ${ui.g.arrow} ${c}`;
}

function truncateTarget(target, ui) {
  const t = String(target ?? "");
  if (t.length <= 40) return t;
  const ell = ui && ui.ascii ? "..." : "…";
  const colonIdx = t.indexOf(":");
  if (colonIdx >= 0 && colonIdx < 20) {
    const prefix = t.slice(0, colonIdx + 1);
    const tail = t.slice(-(40 - prefix.length - ell.length));
    return `${prefix}${ell}${tail}`;
  }
  return t.slice(0, 40 - ell.length) + ell;
}

function countAffectedScenarios(comparison) {
  return (comparison.scenarios ?? []).filter((s) => (s.regressions?.length ?? 0) > 0).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta strip: 3 left-aligned key/value rows

function renderMetaStrip(comparison, ui) {
  const { c } = ui;
  const baseline = comparison.baseline ?? {};
  const current = comparison.current ?? {};
  const regressions = comparison.regressionCount ?? 0;
  const improvements = comparison.improvementCount ?? 0;
  const scnAffected = countAffectedScenarios(comparison);

  const rows = [
    ["baseline", truncateTarget(baseline.target ?? "—", ui), baseline.runId ?? ""],
    ["current",  truncateTarget(current.target ?? "—", ui),  current.runId ?? ""],
  ];

  const labelW = 10;
  const targetW = Math.max(8, rows.reduce((m, r) => Math.max(m, visualWidth(r[1])), 0));
  const lines = rows.map(([label, target, runId]) => {
    const pad1 = repeat(" ", Math.max(1, labelW - visualWidth(label)));
    const pad2 = repeat(" ", Math.max(2, targetW + 4 - visualWidth(target)));
    return `  ${c.dim(label)}${pad1}${target}${pad2}${c.dim(runId)}`;
  });

  const deltaParts = [];
  if (regressions > 0) deltaParts.push(c.err(`${regressions} regression${regressions === 1 ? "" : "s"}`));
  if (improvements > 0) deltaParts.push(c.ok(`+${improvements} improvement${improvements === 1 ? "" : "s"}`));
  if (regressions === 0 && improvements === 0) deltaParts.push(c.dim("no changes"));
  if (scnAffected > 0) deltaParts.push(c.dim(`${scnAffected} scenario${scnAffected === 1 ? "" : "s"} affected`));

  const sep = `  ${c.dim(ui.g.sep)}  `;
  const deltaLabelPad = repeat(" ", Math.max(1, labelW - "delta".length));
  lines.push(`  ${c.dim("delta")}${deltaLabelPad}${deltaParts.join(sep)}`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding changes: grouped by scope (scenario/state), severity-tiered glyphs

function renderFindingChanges(comparison, ui) {
  const { c, g } = ui;
  const fc = comparison.findingChanges ?? {};
  const newOnes = fc.new ?? [];
  const resolved = fc.resolved ?? [];
  if (newOnes.length === 0 && resolved.length === 0) return null;

  const lines = [];

  // New findings (grouped)
  const groups = groupByScope(newOnes);
  for (const [scope, items] of groups) {
    const top = items.slice(0, TOP_FINDINGS_PER_SCOPE);
    const more = items.length - top.length;
    const header = `${scope} ${g.sep} ${items.length} new`;
    lines.push(ruleSection(`findings ${g.sep} ${header}`, ui.width, ui));
    lines.push("");
    for (const f of top) {
      const level = findingSeverityLevel(f.severity);
      const glyph = colorBySeverity(c, severityGlyph(g, level), level);
      const threshold = formatFindingThreshold(f);
      lines.push(...renderIndentedItem(glyph, f.summary, threshold, ui));
    }
    if (more > 0) lines.push(`    ${c.dim(`+ ${more} more in JSON report`)}`);
    lines.push("");
  }

  // Resolved (terse)
  if (resolved.length > 0) {
    lines.push(ruleSection(`findings ${g.sep} resolved ${g.sep} ${resolved.length}`, ui.width, ui));
    lines.push("");
    for (const f of resolved.slice(0, TOP_FINDINGS_PER_SCOPE)) {
      const head = `    ${c.pos(g.check)}  ${c.dim(formatScope(f))}`;
      lines.push(head);
      for (const w of wrap(String(f.summary ?? ""), Math.max(20, ui.width - 8))) {
        lines.push("       " + c.dim(w));
      }
    }
    const more = resolved.length - TOP_FINDINGS_PER_SCOPE;
    if (more > 0) lines.push(`    ${c.dim(`+ ${more} more resolved in JSON report`)}`);
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function groupByScope(items) {
  const map = new Map();
  for (const it of items) {
    const key = formatScope(it);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return map;
}

function formatScope(f) {
  const parts = [];
  if (f.scenario) parts.push(f.scenario);
  if (f.state) parts.push(f.state);
  return parts.join("/") || "run";
}

function findingSeverityLevel(severity) {
  const s = String(severity ?? "").toLowerCase();
  if (s === "blocking") return "fail";
  if (s === "warning") return "warn";
  return "info";
}

function colorBySeverity(c, glyph, level) {
  switch (level) {
    case "fail": return c.err(glyph);
    case "warn": return c.warn(glyph);
    default: return c.dim(glyph);
  }
}

function formatFindingThreshold(f) {
  if (f.threshold != null && f.threshold !== "") return `threshold ${f.threshold}`;
  if (f.tolerance != null) return `tolerance ${f.tolerance}`;
  return "";
}

// "    ✗  summary text............    threshold 10000ms"
function renderIndentedItem(glyph, summary, suffix, ui) {
  const { c } = ui;
  const indent = "    ";
  const glyphCol = `${indent}${glyph}  `;
  const glyphColW = visualWidth(glyphCol);
  const suffixText = suffix ? c.dim(suffix) : "";
  const suffixW = suffix ? visualWidth(suffixText) : 0;
  const budget = Math.max(20, ui.width - glyphColW - (suffixW > 0 ? suffixW + 2 : 0));
  const wrapped = wrap(String(summary ?? ""), budget);
  if (wrapped.length === 0) return [glyphCol];

  const out = [];
  const first = wrapped[0];
  if (suffix) {
    const padN = Math.max(2, ui.width - glyphColW - visualWidth(first) - suffixW);
    out.push(glyphCol + first + repeat(" ", padN) + suffixText);
  } else {
    out.push(glyphCol + first);
  }
  for (let i = 1; i < wrapped.length; i += 1) {
    out.push(repeat(" ", glyphColW) + c.dim(wrapped[i]));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario regressions: grouped by scenario name, with per-state sample rows
// and a metric table sorted by tolerance multiplier.

function renderScenarioRegressions(comparison, ui) {
  const { c, g } = ui;
  const regressed = (comparison.scenarios ?? []).filter((s) => (s.regressions?.length ?? 0) > 0);
  if (regressed.length === 0) return null;

  // Group by scenario name; each entry becomes a "sample" sub-row.
  const byScenario = new Map();
  for (const sc of regressed) {
    const name = sc.scenario || sc.key || "scenario";
    if (!byScenario.has(name)) byScenario.set(name, []);
    byScenario.get(name).push(sc);
  }

  const lines = [];
  let shownScenarios = 0;
  let truncatedFurther = 0;

  for (const [scenario, samples] of byScenario) {
    if (shownScenarios >= TOP_REGRESSION_SCENARIOS) {
      truncatedFurther += samples.length;
      continue;
    }
    const header = `${scenario} ${g.sep} ${samples.length} scn`;
    lines.push(ruleSection(`metric regressions ${g.sep} ${header}`, ui.width, ui));
    lines.push("");

    samples.forEach((sc, idx) => {
      const sampleLabel = sc.state ? `${sc.state} ${g.sep} sample ${idx + 1}` : `sample ${idx + 1}`;
      const status = `${sc.baselineStatus ?? "—"} ${g.arrow} ${sc.currentStatus ?? "—"}`;
      const statusColored = colorStatusArrow(c, sc.baselineStatus, sc.currentStatus, ui);
      const headerLine = renderSampleHeader(sampleLabel, statusColored, ui);
      lines.push(headerLine);

      const metricRows = sc.regressions
        .filter((r) => r.kind === "metric")
        .map((r) => ({
          metric: r.metric,
          from: r.baseline,
          to: r.current,
          delta: r.delta,
          tolerance: r.tolerance,
          // Tolerance of 0 means "any increase is a regression"; treat that as
          // max severity rather than null so it sorts to the top and shows a bar.
          overTol: r.tolerance > 0
            ? r.delta / r.tolerance
            : (r.delta > 0 ? Number.POSITIVE_INFINITY : null),
        }))
        .sort((a, b) => (Number.isFinite(b.overTol) ? b.overTol : 1e9) - (Number.isFinite(a.overTol) ? a.overTol : 1e9));

      const nonMetric = sc.regressions.filter((r) => r.kind !== "metric");
      for (const r of nonMetric) {
        const glyph = c.err(g.cross);
        for (const ln of renderIndentedItem(glyph, r.message, "", ui)) lines.push(ln);
      }

      if (metricRows.length > 0) {
        const top = metricRows.slice(0, TOP_METRICS_PER_SCENARIO);
        const finiteRatios = top.map((m) => m.overTol).filter((r) => Number.isFinite(r));
        const maxRatio = finiteRatios.length > 0 ? Math.max(1, ...finiteRatios) : 1;
        const table = renderMetricTable(top, maxRatio, ui);
        lines.push(indentBlock(table, 6));
        const moreM = metricRows.length - top.length;
        if (moreM > 0) lines.push(`      ${c.dim(`+ ${moreM} more metric regression${moreM === 1 ? "" : "s"} in JSON report`)}`);
      }
      lines.push("");
    });

    shownScenarios += 1;
  }

  if (truncatedFurther > 0) {
    lines.push(`  ${c.dim(`+ ${truncatedFurther} more sample${truncatedFurther === 1 ? "" : "s"} in JSON report`)}`);
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function renderSampleHeader(label, statusColored, ui) {
  const { c, g } = ui;
  const left = `    ${c.dim(g.shadeMed)} ${c.bold(label)}`;
  const leftW = visualWidth(left);
  const rightW = visualWidth(statusColored);
  const pad = Math.max(2, ui.width - leftW - rightW);
  return left + repeat(" ", pad) + statusColored;
}

function colorStatusArrow(c, baseline, current, ui) {
  const b = baseline ?? "—";
  const cur = current ?? "—";
  const cb = String(b).toUpperCase();
  const cc = String(cur).toUpperCase();
  const baseColor = cb === "PASS" ? c.pos : cb === "FAIL" ? c.err : c.dim;
  const curColor = cc === "PASS" ? c.pos : cc === "FAIL" ? c.err : c.warn;
  return `${baseColor(cb)} ${c.dim(ui.g.arrow)} ${curColor(cc)}`;
}

function renderMetricTable(rows, maxRatio, ui) {
  const { c } = ui;
  const renderable = rows.map((r) => {
    const ratio = r.overTol;
    let overTol;
    let bar;
    if (ratio == null) {
      overTol = "—";
      bar = "";
    } else if (!Number.isFinite(ratio)) {
      overTol = ui.ascii ? "max" : "∞×";
      bar = repeat(ui.g.block, BAR_WIDTH);
    } else {
      const times = ui.ascii ? "x" : "×";
      overTol = `${formatNumber(ratio, { fractionDigits: 1 })}${times}`;
      bar = magnitudeBar(ratio, maxRatio, ui);
    }
    return {
      metric: r.metric,
      from: formatNumber(r.from),
      to: formatNumber(r.to),
      delta: formatDeltaSigned(r.delta),
      overTol: severityColorRatio(c, ratio)(overTol),
      bar: c.err(bar),
    };
  });

  return renderTable({
    columns: [
      { key: "metric",  header: c.dim("metric"),   align: "left",  minWidth: 20 },
      { key: "from",    header: c.dim("from"),     align: "right", minWidth: 8 },
      { key: "to",      header: c.dim("to"),       align: "right", minWidth: 8 },
      { key: "delta",   header: c.dim(ui.ascii ? "delta" : "Δ"), align: "right", minWidth: 9 },
      { key: "overTol", header: c.dim("over tol"), align: "right", minWidth: 7 },
      { key: "bar",     header: "",                align: "left",  minWidth: BAR_WIDTH },
    ],
    rows: renderable,
    gap: 2,
  });
}

function severityColorRatio(c, ratio) {
  if (ratio == null) return (x) => c.dim(x);
  if (!Number.isFinite(ratio)) return (x) => c.err(x);
  if (ratio >= 2) return (x) => c.err(x);
  if (ratio >= 1.2) return (x) => c.warn(x);
  return (x) => c.dim(x);
}

function magnitudeBar(ratio, maxRatio, ui) {
  if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(maxRatio) || maxRatio <= 0) return "";
  const n = Math.max(1, Math.min(BAR_WIDTH, Math.round((ratio / maxRatio) * BAR_WIDTH)));
  return repeat(ui.g.block, n);
}

function formatDeltaSigned(delta) {
  if (delta == null || !Number.isFinite(Number(delta))) return "—";
  const n = Number(delta);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return sign + formatNumber(Math.abs(n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Source/release diagnostics (preserved unchanged in spirit)

function renderSourceRelease(comparison, ui) {
  const { c } = ui;
  const sr = comparison.sourceRelease;
  if (!sr) return null;

  const lines = [ruleSection("source/release diagnostics", ui.width, ui)];
  const status = sr.ok ? c.pos("OK") : c.neg("NEEDS_WORK");
  lines.push(`  ${c.bold("Status")}  ${status}   ${c.dim(`${sr.pairCount ?? 0} pair${(sr.pairCount ?? 0) === 1 ? "" : "s"} ${ui.g.sep} ${sr.blockingCount ?? 0} blocking`)}`);
  for (const f of (sr.findings ?? []).slice(0, 6)) {
    const sev = String(f.severity ?? "").toLowerCase();
    const tag = sev === "blocking" ? c.neg(sev.toUpperCase()) : sev === "warning" ? c.warn(sev.toUpperCase()) : c.dim(sev.toUpperCase());
    const wrapped = wrap(String(f.message ?? ""), Math.max(20, ui.width - 8));
    lines.push(`  ${tag} ${c.dim(f.key ?? "")}`);
    for (const w of wrapped) lines.push("    " + c.dim(w));
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer: one line. Headline counts already live in the band + delta strip.

function renderFooter(comparison, ui) {
  const { c, g } = ui;
  if (!comparison.generatedAt) return "";
  return c.dim(`Kova ${g.sep} report compare ${g.sep} generated ${comparison.generatedAt}`);
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
