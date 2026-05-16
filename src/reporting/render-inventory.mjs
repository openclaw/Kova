// kova inventory plan - OpenClaw inventory dashboard.

import {
  makeUi, heavyBand, ruleSection, card, sideBySide,
  badge, statusGlyph, visualWidth, repeat, wrap, withMargin,
} from "../ui/index.mjs";

const TARGET_WIDTH_FOR_DASHBOARD = 120;
const TOP_WARNINGS = 12;

export function renderInventoryPlan(plan, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  sections.push(renderBand(plan, ui));
  sections.push("");
  sections.push(renderKpiStrip(plan, ui));

  const sources = renderSources(plan, ui);
  if (sources) { sections.push(""); sections.push(sources); }

  const warnings = renderWarnings(plan, ui, flags);
  if (warnings) { sections.push(""); sections.push(warnings); }

  sections.push("");
  sections.push(renderFooter(plan, ui));
  return withMargin(sections.join("\n"), ui.leftPad);
}

function renderBand(plan, ui) {
  const cov = plan.coverage ?? {};
  const ok = cov.ok !== false;
  const status = ok ? "READY" : "NEEDS_WORK";
  const labelBadge = ok ? "INVENTORY_OK" : "INVENTORY_GAP";
  const meta = `${cov.discoveredCount ?? 0} discovered ${ui.g.sep} ${cov.matchedCount ?? 0} matched`;
  return heavyBand({
    badgeText: badge(labelBadge, ok ? "PASS" : "INCOMPLETE", ui),
    status,
    title: "OPENCLAW INVENTORY",
    meta,
    width: ui.width,
    ui,
  });
}

function renderKpiStrip(plan, ui) {
  const { c } = ui;
  const cov = plan.coverage ?? {};
  const stack = ui.width < TARGET_WIDTH_FOR_DASHBOARD;
  const cardCount = 4;
  const cardWidth = stack
    ? Math.max(20, ui.width)
    : Math.max(20, Math.floor((ui.width - (cardCount - 1) * 2) / cardCount));

  return sideBySide([
    card({ title: "Modeled",   width: cardWidth, ui, lines: [c.bold(String(cov.modeledSurfaceCount ?? 0)), c.dim("surfaces")] }),
    card({ title: "Matched",   width: cardWidth, ui,
      lines: [
        (cov.matchedCount ?? 0) > 0 ? c.ok(c.bold(String(cov.matchedCount))) : c.dim(String(cov.matchedCount ?? 0)),
        c.dim("discovered"),
      ],
    }),
    card({ title: "Unmodeled", width: cardWidth, ui,
      lines: [
        (cov.unmodeledCount ?? 0) > 0 ? c.warn(c.bold(String(cov.unmodeledCount))) : c.dim(String(cov.unmodeledCount ?? 0)),
        c.dim("need model"),
      ],
    }),
    card({ title: "Warnings",  width: cardWidth, ui,
      lines: [
        (cov.warnings?.length ?? 0) > 0 ? c.warn(c.bold(String(cov.warnings.length))) : c.dim("0"),
        c.dim((cov.warnings?.length ?? 0) > 0 ? "see below" : "clean"),
      ],
    }),
  ], { width: ui.width, gap: 2, minWidth: TARGET_WIDTH_FOR_DASHBOARD });
}

function renderSources(plan, ui) {
  const { c, g } = ui;
  const sources = plan.sources ?? [];
  if (sources.length === 0) return null;
  const lines = [ruleSection("sources", ui.width, ui)];
  for (const source of sources) {
    const status = String(source.status ?? "unknown").toLowerCase();
    let glyph, color;
    if (status === "ok" || status === "matched") { glyph = g.check; color = c.ok; }
    else if (status === "skipped") { glyph = g.pause; color = c.dim; }
    else if (status === "warning") { glyph = g.warn; color = c.warn; }
    else { glyph = g.cross; color = c.err; }

    const count = formatSourceCount(source);
    const reason = source.reason ? c.dim(`  ${g.sep} ${source.reason}`) : "";
    lines.push(`  ${color(glyph)} ${c.bold(source.id ?? "?")}  ${c.dim(String(source.status ?? ""))}${count}${reason}`);
  }
  return lines.join("\n");
}

function formatSourceCount(source) {
  if (source.id === "package-scripts" && typeof source.scriptCount === "number") {
    const included = source.includedScriptCount ?? source.scriptCount;
    return `  (${included}/${source.scriptCount} scripts, scope=${source.scriptScope ?? "unknown"})`;
  }
  const count = source.commandCount ?? source.capabilityCount ?? 0;
  return count ? `  (${count})` : "";
}

function renderWarnings(plan, ui, flags) {
  const { c, g } = ui;
  const warnings = plan.coverage?.warnings ?? [];
  if (warnings.length === 0) return null;
  const limit = positiveIntegerFlag(flags?.max_warnings, TOP_WARNINGS);
  const top = warnings.slice(0, limit);
  const heading = warnings.length > limit
    ? `warnings (first ${limit} of ${warnings.length})`
    : "warnings";

  const lines = [ruleSection(heading, ui.width, ui)];
  for (const w of top) {
    const wrapped = wrap(String(w.message ?? ""), Math.max(20, ui.width - 6));
    lines.push(`  ${c.warn(g.warn)} ${c.dim(wrapped[0] ?? "")}`);
    for (const cont of wrapped.slice(1)) lines.push("    " + c.dim(cont));
  }
  return lines.join("\n");
}

function renderFooter(plan, ui) {
  const { c, g } = ui;
  const lines = [];
  if (plan.generatedAt) lines.push(c.dim(`Generated ${g.sep}  ${plan.generatedAt}`));
  if (plan.schemaVersion) lines.push(c.dim(`Schema    ${g.sep}  ${plan.schemaVersion}`));
  return lines.join("\n");
}

function positiveIntegerFlag(value, fallback) {
  if (value === undefined || value === null || value === false) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
