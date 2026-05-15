// kova matrix plan - resolved matrix view.

import {
  makeUi, heavyBand, ruleSection, card, sideBySide,
  badge, renderTable, visualWidth, repeat,
} from "../ui/index.mjs";

const TARGET_WIDTH_FOR_DASHBOARD = 120;
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
  sections.push(renderFooter(planJson, ui));
  return sections.join("\n");
}

function renderBand(planJson, ui) {
  const { g } = ui;
  const profile = planJson.profile ?? {};
  const meta = [
    profile.id ? `profile: ${profile.id}` : null,
    planJson.target ? `target: ${planJson.target}` : null,
    planJson.from ? `from: ${planJson.from}` : null,
  ].filter(Boolean).join(` ${g.sep} `);
  return heavyBand({
    badgeText: badge("PLAN", "PASS", ui),
    status: "READY",
    title: profile.title ?? "KOVA MATRIX PLAN",
    meta,
    width: ui.width,
    ui,
  });
}

function renderKpiStrip(planJson, ui) {
  const stack = ui.width < TARGET_WIDTH_FOR_DASHBOARD;
  const cardWidth = stack ? Math.max(28, ui.width) : Math.max(28, Math.floor((ui.width - 4) / 3));

  const entries = planJson.entries ?? [];
  const runnable = entries.filter((e) => !e.skipReason).length;
  const skipped = entries.filter((e) => e.skipReason).length;
  const total = entries.length;
  const { c } = ui;

  return sideBySide([
    card({ title: "Total",    width: cardWidth, ui, lines: [c.bold(String(total)), c.dim("entries")] }),
    card({ title: "Runnable", width: cardWidth, ui,
      lines: [
        runnable === total ? c.ok(c.bold(String(runnable))) : c.bold(String(runnable)),
        c.dim(ui.ascii ? "scenarios x states" : "scenarios × states"),
      ],
    }),
    card({ title: "Skipped",  width: cardWidth, ui,
      lines: [
        skipped > 0 ? c.warn(c.bold(String(skipped))) : c.dim(String(skipped)),
        c.dim(skipped > 0 ? "platform/target gates" : "none"),
      ],
    }),
  ], { width: ui.width, gap: 2, minWidth: TARGET_WIDTH_FOR_DASHBOARD });
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
  });
  lines.push(indentBlock(table, 2));

  const more = entries.length - top.length;
  if (more > 0) lines.push(`  ${c.dim(`+ ${more} more entry${more === 1 ? "" : "ies"} (use --json for full list)`)}`);
  return lines.join("\n");
}

function renderFooter(planJson, ui) {
  const { c, g } = ui;
  const lines = [];
  const controls = planJson.controls ?? {};
  const flags = Object.entries(controls).filter(([k, v]) => v !== null && v !== undefined && v !== false && k !== "schemaVersion");
  if (flags.length > 0) {
    lines.push(c.dim(`Controls  ${g.sep}  ${flags.map(([k, v]) => `${k}=${v}`).join(`  ${g.sep}  `)}`));
  }
  if (planJson.generatedAt) lines.push(c.dim(`Generated ${g.sep}  ${planJson.generatedAt}`));
  return lines.join("\n");
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
