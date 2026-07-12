// Inline KPI strip. Replaces stacked card layouts.
//
// Renders a single horizontal row of "chips" with no boxes:
//
//   Proof ▇▇▇▇▇▇▇▇░ 99% (149/150)  ·  Health ▇▇░░░░ unhealthy (8 blocking)
//
// Each item is { label, value, hint?, tone?, bar? }.
//   - value carries the color tone (ok | warn | err | dim | neutral)
//   - label and hint are dim
//   - bar is { filled, total } and renders an inline gauge in the same tone
//
// Width strategy (in order):
//   1. Full: label + bar(wide) + value + hint
//   2. Drop hints
//   3. Shrink bars (narrow)
//   4. Drop bars
//   5. Drop labels
//   6. Stack one item per line (no boxes)

import { makeColor } from "./color.mjs";
import { makeGlyphs } from "./glyphs.mjs";
import { visualWidth, repeat, wrap } from "./text.mjs";

const SEP_SPACING = "   ";
const BAR_WIDE = 10;
const BAR_NARROW = 5;

export function kpiStrip(items, ui) {
  const list = (items ?? []).filter(Boolean);
  if (list.length === 0) return "";

  const c = ui.c ?? makeColor(ui);
  const g = ui.g ?? makeGlyphs(ui);
  const width = ui.width;

  const variants = [
    { includeLabel: true,  includeHint: true,  barWidth: BAR_WIDE },
    { includeLabel: true,  includeHint: false, barWidth: BAR_WIDE },
    { includeLabel: true,  includeHint: false, barWidth: BAR_NARROW },
    { includeLabel: true,  includeHint: false, barWidth: 0 },
    { includeLabel: false, includeHint: false, barWidth: 0 },
  ];

  for (const opts of variants) {
    const cells = list.map((it) => renderItem(it, c, g, opts));
    const line = joinHorizontal(cells, c, g);
    if (visualWidth(line) + 2 <= width) {
      return "  " + line;
    }
  }

  // Final layout option: stack one per line, full detail.
  return list
    .flatMap((it) => {
      const indent = Math.min(2, Math.max(0, width - 1));
      const lines = wrap(
        renderItem(it, c, g, { includeLabel: true, includeHint: true, barWidth: BAR_WIDE }),
        Math.max(1, width - indent),
      );
      return lines.map((line) => repeat(" ", indent) + line);
    })
    .join("\n");
}

function renderItem(item, c, g, { includeLabel, includeHint, barWidth }) {
  const label = item.label ? String(item.label) : "";
  const valueRaw = item.value == null ? "" : String(item.value);
  const hint = item.hint ? String(item.hint) : "";
  const tone = item.tone ?? "neutral";
  const bar = item.bar;

  const toned = toneColor(c, tone);
  const parts = [];
  if (includeLabel && label) parts.push(c.dim(label));
  if (barWidth > 0 && bar) parts.push(toned(renderBar(bar, barWidth, g)));
  if (valueRaw) parts.push(toned(valueRaw));
  if (includeHint && hint) parts.push(c.dim(`(${hint})`));
  return parts.join(" ");
}

function renderBar({ filled, total }, width, g) {
  const f = Number(filled) || 0;
  const t = Number(total) || 0;
  const empty = g.barEmpty ?? "░";
  if (t <= 0 || width <= 0) return repeat(empty, width);
  const ratio = Math.max(0, Math.min(1, f / t));
  const fill = Math.round(ratio * width);
  const full = g.bar ?? "█";
  return repeat(full, fill) + repeat(empty, Math.max(0, width - fill));
}

function joinHorizontal(cells, c, g) {
  const sep = `${SEP_SPACING}${c.dim(g.sep)}${SEP_SPACING}`;
  return cells.filter(Boolean).join(sep);
}

function toneColor(c, tone) {
  switch (tone) {
    case "ok": return c.ok;
    case "warn": return c.warn;
    case "err": return c.err;
    case "dim": return c.dim;
    case "neutral":
    default:
      return c.bold;
  }
}
