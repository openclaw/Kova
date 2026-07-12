// kova inventory plan - OpenClaw inventory dashboard.

import {
  makeUi, ruleSection, renderKovaHeader, kpiStrip,
  statusGlyph, visualWidth, repeat, wrap, withMargin,
} from "../ui/index.mjs";

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
  return withMargin(sections.join("\n"), ui.leftPad, ui.width);
}

function renderBand(plan, ui) {
  const cov = plan.coverage ?? {};
  const ok = cov.ok !== false;
  const verdict = ok ? "OK" : "GAP";
  const meta = `${cov.discoveredCount ?? 0} discovered ${ui.g.sep} ${cov.matchedCount ?? 0} matched`;
  const unmodeled = cov.unmodeledCount ?? 0;
  const headline = ok
    ? `${cov.modeledSurfaceCount ?? 0} surfaces modeled`
    : `${unmodeled} unmodeled`;
  return renderKovaHeader({ surface: "inventory", verdict, headline, meta, ui });
}

function renderKpiStrip(plan, ui) {
  const cov = plan.coverage ?? {};
  const matched = cov.matchedCount ?? 0;
  const unmodeled = cov.unmodeledCount ?? 0;
  const warnings = cov.warnings?.length ?? 0;
  const modeled = cov.modeledSurfaceCount ?? 0;
  const denom = Math.max(modeled, matched + unmodeled, 1);
  return kpiStrip([
    { label: "Modeled",   value: String(modeled), hint: "surfaces",    tone: "neutral" },
    { label: "Matched",   value: String(matched),   hint: "discovered",  tone: matched > 0 ? "ok" : "dim", bar: { filled: matched, total: denom } },
    { label: "Unmodeled", value: String(unmodeled), hint: "need model",  tone: unmodeled > 0 ? "warn" : "dim", bar: { filled: unmodeled, total: denom } },
    { label: "Warnings",  value: String(warnings),  hint: warnings > 0 ? "see below" : "clean", tone: warnings > 0 ? "warn" : "dim" },
  ], ui);
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
    const wrapped = wrap(String(w.message ?? ""), Math.max(1, ui.width - 6));
    lines.push(`  ${c.warn(g.warn)} ${c.dim(wrapped[0] ?? "")}`);
    for (const cont of wrapped.slice(1)) lines.push("    " + c.dim(cont));
  }
  return lines.join("\n");
}

function renderFooter(plan, ui) {
  // Kova surfaces end with a "next" hint instead of a generated/schema
  // footer; the JSON form carries timestamps when callers need them.
  const { c, g } = ui;
  const lines = [ruleSection("next", ui.width, ui), ""];
  lines.push(`  ${c.dim(g.arrow)} kova inventory --json`);
  lines.push(`  ${c.dim(g.arrow)} kova plan`);
  return lines.join("\n");
}

function positiveIntegerFlag(value, defaultValue) {
  if (value === undefined || value === null || value === false) return defaultValue;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}
