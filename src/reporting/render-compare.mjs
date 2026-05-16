// kova report compare <baseline> <current> - dashboard view.
// Consumes the comparison object from compareReports() unchanged.

import {
  makeUi, heavyBand, ruleSection, card, sideBySide,
  badge, renderTable, formatPercent,
  visualWidth, repeat, wrap, withMargin,
} from "../ui/index.mjs";

const TARGET_WIDTH_FOR_DASHBOARD = 120;
const TOP_FINDINGS = 6;
const TOP_REGRESSIONS = 10;
const TOP_STATUS_CHANGES = 10;

export function renderCompareAssessment(comparison, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  return withMargin(renderCompareFromComparison(comparison, ui), ui.leftPad);
}

export function renderCompareFromComparison(comparison, ui) {
  const sections = [];

  sections.push(renderBand(comparison, ui));
  sections.push("");
  sections.push(renderKpiStrip(comparison, ui));

  const statusChanges = renderStatusChanges(comparison, ui);
  if (statusChanges) { sections.push(""); sections.push(statusChanges); }

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

function renderBand(comparison, ui) {
  const verdict = comparison.ok ? "OK" : "REGRESSED";
  const label = comparison.ok ? "NO_REGRESSIONS" : "REGRESSIONS_FOUND";
  const meta = formatBandMeta(comparison, ui);
  return heavyBand({
    badgeText: badge(label, verdict, ui),
    status: verdict,
    title: "KOVA COMPARE",
    meta,
    width: ui.width,
    ui,
  });
}

function formatBandMeta(comparison, ui) {
  const sep = ` ${ui.g.sep} `;
  const parts = [];
  if (comparison.baseline?.runId) parts.push(`baseline: ${comparison.baseline.runId}`);
  if (comparison.current?.runId) parts.push(`current: ${comparison.current.runId}`);
  return parts.join(sep);
}

function renderKpiStrip(comparison, ui) {
  const stack = ui.width < TARGET_WIDTH_FOR_DASHBOARD;
  const cardWidth = stack ? Math.max(28, ui.width) : Math.max(28, Math.floor((ui.width - 4) / 3));

  return sideBySide(
    [buildBaselineCard(comparison, ui, cardWidth),
     buildCurrentCard(comparison, ui, cardWidth),
     buildDeltaCard(comparison, ui, cardWidth)],
    { width: ui.width, gap: 2, minWidth: TARGET_WIDTH_FOR_DASHBOARD },
  );
}

function buildBaselineCard(comparison, ui, width) {
  const { c } = ui;
  const b = comparison.baseline ?? {};
  return card({
    title: "Baseline",
    width,
    lines: [
      c.bold(truncate(b.runId ?? "—", width - 4)),
      c.dim(truncate(b.target ?? "", width - 4)),
    ],
    ui,
  });
}

function buildCurrentCard(comparison, ui, width) {
  const { c } = ui;
  const cur = comparison.current ?? {};
  return card({
    title: "Current",
    width,
    lines: [
      c.bold(truncate(cur.runId ?? "—", width - 4)),
      c.dim(truncate(cur.target ?? "", width - 4)),
    ],
    ui,
  });
}

function buildDeltaCard(comparison, ui, width) {
  const { c } = ui;
  const regressions = comparison.regressionCount ?? 0;
  const improvements = comparison.improvementCount ?? 0;
  let stateText, stateColor;
  if (regressions > 0) { stateText = `${regressions} regression${regressions === 1 ? "" : "s"}`; stateColor = c.err; }
  else if (improvements > 0) { stateText = `${improvements} improvement${improvements === 1 ? "" : "s"}`; stateColor = c.ok; }
  else { stateText = "no changes"; stateColor = c.dim; }

  return card({
    title: "Delta",
    width,
    lines: [
      `${stateColor(c.bold(stateText))}`,
      c.dim(`+${improvements} better ${ui.g.sep} -${regressions} worse`),
    ],
    ui,
  });
}

function renderStatusChanges(comparison, ui) {
  const { c } = ui;
  const changes = comparison.statusChanges?.changes ?? [];
  if (changes.length === 0) return null;

  const top = changes.slice(0, TOP_STATUS_CHANGES);
  const lines = [ruleSection("status changes", ui.width, ui)];

  const rows = top.map((ch) => {
    const dir = String(ch.direction ?? "").toLowerCase();
    const arrow = dir === "regression" ? c.neg(ui.g.arrow) : dir === "improvement" ? c.pos(ui.g.arrow) : c.dim(ui.g.arrow);
    return {
      direction: dir === "regression" ? c.neg("worse") : dir === "improvement" ? c.pos("better") : c.dim("changed"),
      key: c.bold(ch.key ?? ""),
      from: c.dim(ch.baselineLabel ?? "—"),
      arrow,
      to: ch.currentLabel ?? "—",
    };
  });

  const table = renderTable({
    columns: [
      { key: "direction", header: c.dim("change"), align: "left", minWidth: 8 },
      { key: "key",       header: c.dim("scope"),  align: "left", minWidth: 24 },
      { key: "from",      header: c.dim("from"),   align: "right", minWidth: 10 },
      { key: "arrow",     header: "",              align: "center", minWidth: 2 },
      { key: "to",        header: c.dim("to"),     align: "left", minWidth: 10 },
    ],
    rows,
    gap: 2,
  });
  lines.push(indentBlock(table, 2));

  const more = changes.length - top.length;
  if (more > 0) lines.push(`  ${c.dim(`+ ${more} more change${more === 1 ? "" : "s"} in JSON report`)}`);
  return lines.join("\n");
}

function renderFindingChanges(comparison, ui) {
  const { c, g } = ui;
  const fc = comparison.findingChanges ?? {};
  const newOnes = fc.new ?? [];
  const resolved = fc.resolved ?? [];
  if (newOnes.length === 0 && resolved.length === 0) return null;

  const lines = [ruleSection("finding changes", ui.width, ui)];

  for (const f of newOnes.slice(0, TOP_FINDINGS)) {
    const scope = formatScope(f);
    const head = `  ${c.neg(g.cross)} ${c.bold("NEW")} ${c.dim(scope)}`;
    lines.push(head);
    const wrapped = wrap(String(f.summary ?? ""), Math.max(20, ui.width - 6));
    for (const w of wrapped) lines.push("    " + c.dim(w));
  }
  for (const f of resolved.slice(0, TOP_FINDINGS)) {
    const scope = formatScope(f);
    const head = `  ${c.pos(g.check)} ${c.bold("RESOLVED")} ${c.dim(scope)}`;
    lines.push(head);
    const wrapped = wrap(String(f.summary ?? ""), Math.max(20, ui.width - 6));
    for (const w of wrapped) lines.push("    " + c.dim(w));
  }
  return lines.join("\n");
}

function formatScope(f) {
  const parts = [];
  if (f.scenario) parts.push(f.scenario);
  if (f.state) parts.push(f.state);
  return parts.join("/") || "run";
}

function renderScenarioRegressions(comparison, ui) {
  const { c } = ui;
  const regressedScenarios = (comparison.scenarios ?? []).filter((s) => s.regressions?.length > 0);
  if (regressedScenarios.length === 0) return null;

  const lines = [ruleSection("scenario regressions", ui.width, ui)];

  let total = 0;
  for (const sc of regressedScenarios) {
    if (total >= TOP_REGRESSIONS) {
      const remaining = regressedScenarios.slice(regressedScenarios.indexOf(sc)).reduce((n, s) => n + s.regressions.length, 0);
      lines.push(`  ${c.dim(`+ ${remaining} more regression${remaining === 1 ? "" : "s"} in JSON report`)}`);
      break;
    }
    const fromTo = `${sc.baselineStatus ?? "missing"} ${ui.g.arrow} ${sc.currentStatus ?? "missing"}`;
    lines.push(`  ${c.neg(ui.g.cross)} ${c.bold(sc.key)}  ${c.dim(fromTo)}`);
    for (const reg of sc.regressions) {
      if (total >= TOP_REGRESSIONS) break;
      const wrapped = wrap(String(reg.message ?? ""), Math.max(20, ui.width - 8));
      for (let i = 0; i < wrapped.length; i += 1) {
        const prefix = i === 0 ? `    ${c.dim(ui.g.bullet)} ` : "      ";
        lines.push(prefix + c.dim(wrapped[i]));
      }
      total += 1;
    }
  }
  return lines.join("\n");
}

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

function renderFooter(comparison, ui) {
  const { c, g } = ui;
  const lines = [];
  lines.push(c.dim(`Compare   ${g.sep}  ${comparison.regressionCount ?? 0} regression${(comparison.regressionCount ?? 0) === 1 ? "" : "s"} ${g.sep} ${comparison.improvementCount ?? 0} improvement${(comparison.improvementCount ?? 0) === 1 ? "" : "s"} ${g.sep} ${comparison.scenarios?.length ?? 0} scenario${(comparison.scenarios?.length ?? 0) === 1 ? "" : "s"}`));
  if (comparison.generatedAt) lines.push(c.dim(`Generated ${g.sep}  ${comparison.generatedAt}`));
  return lines.join("\n");
}

function truncate(text, max) {
  if (max <= 4) return text;
  if (visualWidth(text) <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
