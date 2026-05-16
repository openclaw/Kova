// Proves block. Each scenario declares "proves" — claims that its
// execution is meant to validate. Rendered as a short bulleted list with
// the per-claim verdict.
//
//   Proves
//     ✓ runtime starts before health probe times out
//     ✗ first-turn responds within 2 s budget
//
// Compare variant shows baseline → current verdict transitions:
//
//   Proves
//     ✓ runtime starts before health probe times out
//     ✓→✗ first-turn responds within 2 s budget       (regressed)
//
// Inputs are already-shaped claims.

import { statusGlyph } from "./glyphs.mjs";
import { visualWidth, repeat, wrap } from "./text.mjs";

// provesBlock({ claims, compare, ui }) -> string
//
//   claims (single-run):
//     [{ claim, status: "PASS"|"FAIL"|"INCOMPLETE"|"SKIPPED" }]
//   claims (compare):
//     [{ claim, baselineStatus, currentStatus, change: "stable"|"regressed"|"improved" }]
export function provesBlock({ claims, compare = false, ui } = {}) {
  if (!claims || claims.length === 0) return "";
  const c = ui.c;
  const g = ui.g;
  const width = ui.width;

  const lines = [];
  for (const cl of claims) {
    if (!compare) {
      const sev = String(cl.status ?? "SKIPPED").toUpperCase();
      const glyph = colorize(c, sev, statusGlyph(g, sev));
      const text = truncate(cl.claim ?? "", width - 6);
      lines.push(`  ${glyph} ${text}`);
    } else {
      const b = String(cl.baselineStatus ?? "—").toUpperCase();
      const cur = String(cl.currentStatus ?? "—").toUpperCase();
      const bg = colorize(c, b, statusGlyph(g, b));
      const cg = colorize(c, cur, statusGlyph(g, cur));
      const transition = b === cur ? cg : `${bg}${c.dim("→")}${cg}`;
      const note = cl.change === "regressed" ? c.neg("  (regressed)")
        : cl.change === "improved" ? c.pos("  (improved)")
        : "";
      const text = truncate(cl.claim ?? "", width - 12);
      lines.push(`  ${transition} ${text}${note}`);
    }
  }
  return lines.join("\n");
}

function colorize(c, status, text) {
  if (status === "PASS" || status === "OK") return c.ok(text);
  if (status === "FAIL") return c.err(text);
  if (status === "INCOMPLETE" || status === "WARN") return c.warn(text);
  if (status === "BLOCKED") return c.block(text);
  return c.dim(text);
}

function truncate(text, max) {
  if (max <= 4) return text;
  if (visualWidth(text) <= max) return text;
  return text.slice(0, max - 1) + "…";
}
