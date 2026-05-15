// kova plan - registry summary view.
// Consumes the JSON shape produced by runPlanCommand --json.

import {
  makeUi, heavyBand, ruleSection, card, sideBySide,
  badge, renderTable, visualWidth, repeat, wrap,
} from "../ui/index.mjs";

const TARGET_WIDTH_FOR_DASHBOARD = 120;
const TOP_SCENARIOS = 12;

export function renderPlan(planJson, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  sections.push(renderBand(planJson, ui));
  sections.push("");
  sections.push(renderKpiStrip(planJson, ui));

  const surfaces = renderSurfacesByOwner(planJson, ui);
  if (surfaces) { sections.push(""); sections.push(surfaces); }

  const scenarios = renderScenarioList(planJson, ui);
  if (scenarios) { sections.push(""); sections.push(scenarios); }

  sections.push("");
  sections.push(renderFooter(planJson, ui));
  return sections.join("\n");
}

function renderBand(planJson, ui) {
  const platform = planJson.platform ?? {};
  const meta = [
    platform.os ? `${platform.os} ${platform.release ?? ""}`.trim() : null,
    platform.arch,
    platform.node,
  ].filter(Boolean).join(` ${ui.g.sep} `);
  return heavyBand({
    badgeText: badge("REGISTRY", "PASS", ui),
    status: "READY",
    title: "KOVA PLAN",
    meta,
    width: ui.width,
    ui,
  });
}

function renderKpiStrip(planJson, ui) {
  const stack = ui.width < TARGET_WIDTH_FOR_DASHBOARD;
  const cardCount = 4;
  const cardWidth = stack
    ? Math.max(20, ui.width)
    : Math.max(20, Math.floor((ui.width - (cardCount - 1) * 2) / cardCount));

  const c = ui.c;
  const cards = [
    card({ title: "Scenarios", width: cardWidth, ui, lines: [c.bold(String(planJson.scenarios?.length ?? 0)), c.dim("registered")] }),
    card({ title: "States",    width: cardWidth, ui, lines: [c.bold(String(planJson.states?.length ?? 0)),    c.dim("registered")] }),
    card({ title: "Profiles",  width: cardWidth, ui, lines: [c.bold(String(planJson.profiles?.length ?? 0)),  c.dim("matrix")] }),
    card({ title: "Surfaces",  width: cardWidth, ui, lines: [c.bold(String(planJson.surfaces?.length ?? 0)),  c.dim("OpenClaw")] }),
  ];
  return sideBySide(cards, { width: ui.width, gap: 2, minWidth: TARGET_WIDTH_FOR_DASHBOARD });
}

function renderSurfacesByOwner(planJson, ui) {
  const { c } = ui;
  const surfacesCov = planJson.coverage?.surfaces ?? [];
  if (surfacesCov.length === 0) return null;

  const byOwner = new Map();
  for (const s of surfacesCov) {
    const owner = s.ownerArea ?? "unknown";
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(s);
  }

  const lines = [ruleSection("surfaces by owner", ui.width, ui)];
  const owners = [...byOwner.keys()].sort();
  for (const owner of owners) {
    const group = byOwner.get(owner);
    const totalScenarios = group.reduce((n, s) => n + (s.scenarioCount ?? 0), 0);
    lines.push(`  ${c.head(ui.g.diamond)} ${c.bold(owner)}  ${c.dim(`${group.length} surface${group.length === 1 ? "" : "s"} ${ui.g.sep} ${totalScenarios} scenario${totalScenarios === 1 ? "" : "s"}`)}`);
    for (const s of group) {
      const count = s.scenarioCount ?? 0;
      const tag = count === 0 ? c.warn("0 scenarios") : c.dim(`${count} scenario${count === 1 ? "" : "s"}`);
      lines.push(`    ${c.dim(ui.g.bullet)} ${s.id}  ${tag}`);
    }
  }
  const orphans = planJson.coverage?.surfacesWithoutScenarios ?? [];
  if (orphans.length > 0) {
    lines.push("");
    lines.push(`  ${c.warn(ui.g.warn)} ${c.bold("surfaces without scenarios:")} ${c.dim(orphans.map((s) => s.id ?? s).join(", "))}`);
  }
  return lines.join("\n");
}

function renderScenarioList(planJson, ui) {
  const { c } = ui;
  const scenarios = planJson.scenarios ?? [];
  if (scenarios.length === 0) return null;

  const top = scenarios.slice(0, TOP_SCENARIOS);
  const lines = [ruleSection("scenarios", ui.width, ui)];

  const rows = top.map((s) => ({
    id:      c.bold(s.id ?? "?"),
    surface: c.dim(s.surface ?? "—"),
    states:  c.dim(`${(s.states ?? []).length}`),
    phases:  c.dim(`${(s.phases ?? []).length}`),
    title:   s.title ?? "",
  }));
  const table = renderTable({
    columns: [
      { key: "id",      header: c.dim("id"),      align: "left",  minWidth: 18 },
      { key: "surface", header: c.dim("surface"), align: "left",  minWidth: 18 },
      { key: "states",  header: c.dim("states"),  align: "right", minWidth: 6 },
      { key: "phases",  header: c.dim("phases"),  align: "right", minWidth: 6 },
      { key: "title",   header: c.dim("title"),   align: "left",  minWidth: 24 },
    ],
    rows,
    gap: 2,
  });
  lines.push(indentBlock(table, 2));

  const more = scenarios.length - top.length;
  if (more > 0) lines.push(`  ${c.dim(`+ ${more} more scenario${more === 1 ? "" : "s"} (use --scenario <id> to filter, or --json for full list)`)}`);
  return lines.join("\n");
}

function renderFooter(planJson, ui) {
  const { c, g } = ui;
  const lines = [];
  if (planJson.generatedAt) lines.push(c.dim(`Generated ${g.sep}  ${planJson.generatedAt}`));
  if (planJson.schemaVersion) lines.push(c.dim(`Schema    ${g.sep}  ${planJson.schemaVersion}`));
  return lines.join("\n");
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
