// kova plan - registry summary view.
// Consumes the JSON shape produced by runPlanCommand --json.

import {
  makeUi, ruleSection, renderKovaHeader, kpiStrip,
  renderTable, repeat, wrap, withMargin,
} from "../ui/index.mjs";

const TOP_SCENARIOS = 12;

export function renderPlan(planJson, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  sections.push(renderBand(planJson, ui));
  sections.push("");
  sections.push(renderKpiStrip(planJson, ui));

  const surfaces = renderSurfacesByOwner(planJson, ui);
  if (surfaces) { sections.push(""); sections.push(surfaces); }

  const channelFlows = renderChannelWorkflowCoverage(planJson, ui);
  if (channelFlows) { sections.push(""); sections.push(channelFlows); }

  const scenarios = renderScenarioList(planJson, ui);
  if (scenarios) { sections.push(""); sections.push(scenarios); }

  sections.push("");
  sections.push(renderNext(planJson, ui));
  return withMargin(sections.join("\n"), ui.leftPad, ui.width);
}

function renderBand(planJson, ui) {
  const platform = planJson.platform ?? {};
  const meta = [
    platform.os ? `${platform.os} ${platform.release ?? ""}`.trim() : null,
    platform.arch,
    platform.node,
  ].filter(Boolean).join(` ${ui.g.sep} `);
  const scenarios = planJson.scenarios?.length ?? 0;
  const surfaces = planJson.surfaces?.length ?? 0;
  return renderKovaHeader({
    surface: "plan",
    verdict: null,
    headline: `${scenarios} scenarios ${ui.g.sep} ${surfaces} surfaces`,
    meta,
    ui,
  });
}

function renderKpiStrip(planJson, ui) {
  return kpiStrip([
    { label: "Scenarios", value: String(planJson.scenarios?.length ?? 0), hint: "registered", tone: "neutral" },
    { label: "States",    value: String(planJson.states?.length ?? 0),    hint: "registered", tone: "neutral" },
    { label: "Profiles",  value: String(planJson.profiles?.length ?? 0),  hint: "matrix",     tone: "neutral" },
    { label: "Surfaces",  value: String(planJson.surfaces?.length ?? 0),  hint: "OpenClaw",   tone: "neutral" },
  ], ui);
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

function renderChannelWorkflowCoverage(planJson, ui) {
  const { c } = ui;
  const channels = planJson.channelCapabilities ?? [];
  const rows = channels
    .filter((channel) => channel.workflowCoverage)
    .map((channel) => {
      const coverage = channel.workflowCoverage ?? {};
      const skipped = coverage.skippedCount ?? 0;
      const firstReason = skipped > 0
        ? coverage.skipped?.[0]?.reason ?? "see --json"
        : "none";
      return {
        channel: c.bold(channel.id ?? "?"),
        selected: c.ok(String(coverage.selectedCount ?? 0)),
        skipped: skipped > 0 ? c.warn(String(skipped)) : c.dim("0"),
        reason: c.dim(firstReason)
      };
    });
  if (rows.length === 0) return null;
  const table = renderTable({
    columns: [
      { key: "channel", header: c.dim("channel"), align: "left", minWidth: 10 },
      { key: "selected", header: c.dim("selected"), align: "right", minWidth: 8 },
      { key: "skipped", header: c.dim("skipped"), align: "right", minWidth: 7 },
      { key: "reason", header: c.dim("first skip reason"), align: "left", minWidth: 24 }
    ],
    rows,
    gap: 2,
    maxWidth: ui.width ? Math.max(1, ui.width - 2) : null
  });
  return [
    ruleSection("channel user flows", ui.width, ui),
    indentBlock(table, 2)
  ].join("\n");
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
      { key: "id",      header: c.dim("id"),      align: "left",  minWidth: 16 },
      { key: "surface", header: c.dim("surface"), align: "left",  minWidth: 16 },
      { key: "states",  header: c.dim("states"),  align: "right", minWidth: 6 },
      { key: "phases",  header: c.dim("phases"),  align: "right", minWidth: 6 },
      { key: "title",   header: c.dim("title"),   align: "left",  minWidth: 20 },
    ],
    rows,
    gap: 2,
    maxWidth: ui.width ? Math.max(1, ui.width - 2) : null,
  });
  lines.push(indentBlock(table, 2));

  const more = scenarios.length - top.length;
  if (more > 0) lines.push(`  ${c.dim(`+ ${more} more scenario${more === 1 ? "" : "s"} (use --scenario <id> to filter, or --json for full list)`)}`);
  return lines.join("\n");
}

function renderNext(planJson, ui) {
  const { c, g } = ui;
  const scenarios = planJson.scenarios ?? [];
  const lines = [ruleSection("next", ui.width, ui), ""];
  const sample = scenarios[0]?.id;
  if (sample) lines.push(`  ${c.dim(g.arrow)} kova run --target runtime:stable --scenario ${sample}`);
  lines.push(`  ${c.dim(g.arrow)} kova matrix plan --profile smoke --target runtime:stable`);
  lines.push(`  ${c.dim(g.arrow)} kova plan --json`);
  return lines.join("\n");
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
