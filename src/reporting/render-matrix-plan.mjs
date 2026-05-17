// kova matrix plan - resolved matrix view.

import {
  makeUi, ruleSection, renderKovaHeader, kpiStrip,
  renderTable, repeat, withMargin,
} from "../ui/index.mjs";

const TOP_ENTRIES = 20;

export function renderMatrixPlan(planJson, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  sections.push(renderBand(planJson, ui));
  sections.push("");
  sections.push(renderKpiStrip(planJson, ui));

  const entries = renderEntries(planJson, ui);
  if (entries) { sections.push(""); sections.push(entries); }

  sections.push("");
  sections.push(renderNext(planJson, ui));
  return withMargin(sections.join("\n"), ui.leftPad);
}

function renderBand(planJson, ui) {
  const { g } = ui;
  const profile = planJson.profile ?? {};
  const meta = [
    profile.id ? `profile: ${profile.id}` : null,
    planJson.target ? `target: ${planJson.target}` : null,
    planJson.from ? `from: ${planJson.from}` : null,
  ].filter(Boolean).join(` ${g.sep} `);
  const entries = planJson.entries ?? [];
  const runnable = entries.filter((e) => !e.skipReason).length;
  return renderKovaHeader({
    surface: "matrix plan",
    verdict: "PLAN",
    headline: `${runnable} runnable ${ui.g.sep} ${entries.length} entries`,
    meta,
    ui,
  });
}

function renderKpiStrip(planJson, ui) {
  const entries = planJson.entries ?? [];
  const runnable = entries.filter((e) => !e.skipReason).length;
  const skipped = entries.filter((e) => e.skipReason).length;
  const total = entries.length;
  return kpiStrip([
    { label: "Total", value: String(total), hint: "entries", tone: "neutral" },
    {
      label: "Runnable", value: String(runnable),
      hint: ui.ascii ? "scenarios x states" : "scenarios × states",
      tone: runnable === total ? "ok" : "neutral",
      bar: { filled: runnable, total: Math.max(total, 1) },
    },
    {
      label: "Skipped", value: String(skipped),
      hint: skipped > 0 ? "platform/target gates" : "none",
      tone: skipped > 0 ? "warn" : "dim",
      bar: { filled: skipped, total: Math.max(total, 1) },
    },
  ], ui);
}

function renderEntries(planJson, ui) {
  const { c, g } = ui;
  const entries = planJson.entries ?? [];
  if (entries.length === 0) return null;

  const top = entries.slice(0, TOP_ENTRIES);
  const lines = [ruleSection("entries", ui.width, ui)];

  const rows = top.map((entry) => {
    const skip = entry.skipReason;
    return {
      status:   skip ? c.warn(`SKIP`) : c.ok(`RUN`),
      scenario: c.bold(entry.scenario?.id ?? entry.scenarioId ?? "?"),
      state:    c.dim(entry.state?.id ?? entry.stateId ?? "—"),
      reason:   skip ? c.dim(skip) : c.dim(entry.scenario?.title ?? ""),
    };
  });

  const table = renderTable({
    columns: [
      { key: "status",   header: c.dim("verdict"),  align: "left", minWidth: 6 },
      { key: "scenario", header: c.dim("scenario"), align: "left", minWidth: 24 },
      { key: "state",    header: c.dim("state"),    align: "left", minWidth: 16 },
      { key: "reason",   header: c.dim("note"),     align: "left", minWidth: 20 },
    ],
    rows,
    gap: 2,
    maxWidth: ui.width ? Math.max(40, ui.width - 2) : null,
  });
  lines.push(indentBlock(table, 2));

  const more = entries.length - top.length;
  if (more > 0) lines.push(`  ${c.dim(`+ ${more} more entry${more === 1 ? "" : "ies"} (use --json for full list)`)}`);
  return lines.join("\n");
}

function renderNext(planJson, ui) {
  const { c, g } = ui;
  const profile = planJson.profile?.id ?? "smoke";
  const target = planJson.target ?? "runtime:stable";
  const runnable = (planJson.entries ?? []).filter((e) => !e.skipReason).length;
  const lines = [ruleSection("next", ui.width, ui), ""];
  if (runnable > 0) {
    lines.push(`  ${c.dim(g.arrow)} kova matrix run --profile ${profile} --target ${target} --execute`);
  }
  lines.push(`  ${c.dim(g.arrow)} kova matrix plan --profile ${profile} --target ${target} --json`);
  return lines.join("\n");
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
