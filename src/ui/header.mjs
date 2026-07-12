// Unified Kova header used by every renderer.
//
// Layout:
//   ╔══════════════════════════════════════════════════════════════════════════╗
//   ║  KOVA  ·  <surface>                                                      ║
//   ╚══════════════════════════════════════════════════════════════════════════╝
//      [VERDICT]   <headline>                                          <meta>
//
// The band carries identity only: the KOVA wordmark + the surface
// ("report compare", "matrix plan", "self-check", ...). The verdict line
// directly below carries the surface-specific status badge, a short headline,
// and an optional right-aligned meta string (target arrow, profile, etc.).
//
// Renderers should compose this header instead of calling heavyBand directly.

import { heavyBand } from "./layout.mjs";
import { badge } from "./badges.mjs";
import { visualWidth, repeat, truncate, wrap } from "./text.mjs";

// renderKovaHeader({ surface, verdict, headline, meta, ui }) -> string
//
//   surface  - short command-style label shown after the wordmark
//              (e.g. "report compare", "matrix plan", "self-check").
//   verdict  - status string ("PASS"|"FAIL"|"OK"|"INCOMPLETE"|"SHIP"|
//              "DO_NOT_SHIP"|"BLOCKED"|"DRY-RUN"|null). When null/empty
//              and headline is empty, the verdict line is omitted entirely.
//   headline - short single-sentence summary of the surface's result.
//   meta     - optional right-aligned secondary detail (target arrow, etc.).
//   ui       - resolved UI options (ui.width, ui.c, ui.g, ui.ascii).
export function renderKovaHeader({ surface = "", verdict = null, headline = "", meta = "", ui }) {
  const band = renderBand(surface, ui);
  const verdictLine = renderVerdictLine({ verdict, headline, meta, ui });
  return verdictLine ? `${band}\n${verdictLine}` : band;
}

function renderBand(surface, ui) {
  const title = surface
    ? `KOVA  ${ui.g.sep}  ${surface}`
    : "KOVA";
  return heavyBand({
    badgeText: "",
    status: "",
    title,
    meta: "",
    width: ui.width,
    ui,
  });
}

function renderVerdictLine({ verdict, headline, meta, ui }) {
  const verdictText = verdict ? String(verdict).trim() : "";
  const headlineText = headline ? String(headline).trim() : "";
  const metaText = meta ? String(meta).trim() : "";
  if (!verdictText && !headlineText && !metaText) return "";

  const { c } = ui;
  const badgeText = verdictText ? badge(verdictText, verdictText, ui) : "";
  const outerIndent = Math.min(3, Math.max(0, ui.width - 1));
  const prefix = badgeText ? `${repeat(" ", outerIndent)}${badgeText}` : repeat(" ", outerIndent);
  const headlineIndent = badgeText ? visualWidth(prefix) + 3 : outerIndent;
  const headlineWidth = Math.max(1, ui.width - headlineIndent);
  const lines = [];

  const headlineFitsBesideBadge = !badgeText || headlineIndent < ui.width;
  const headlineLines = headlineText
    ? wrap(c.bold(headlineText), headlineFitsBesideBadge ? headlineWidth : Math.max(1, ui.width - outerIndent))
    : [];
  if (headlineLines.length > 0 && headlineFitsBesideBadge) {
    lines.push(truncate(`${prefix}${badgeText ? "   " : ""}${headlineLines[0]}`, ui.width));
    const continuationPrefix = repeat(" ", Math.min(headlineIndent, Math.max(0, ui.width - 1)));
    for (const line of headlineLines.slice(1)) {
      lines.push(truncate(continuationPrefix + line, ui.width));
    }
  } else {
    if (badgeText) lines.push(truncate(prefix, ui.width));
    const continuationPrefix = repeat(" ", outerIndent);
    for (const line of headlineLines) {
      lines.push(truncate(continuationPrefix + line, ui.width));
    }
  }
  if (metaText) {
    const metaIndent = Math.min(headlineIndent, Math.max(0, ui.width - 1));
    const metaWidth = Math.max(1, ui.width - metaIndent);
    const metaLines = wrap(c.dim(metaText), metaWidth);
    const canShareLastLine = lines.length > 0
      && metaLines.length === 1
      && visualWidth(lines.at(-1)) + 2 + visualWidth(metaLines[0]) <= ui.width;
    if (canShareLastLine) {
      const pad = ui.width - visualWidth(lines.at(-1)) - visualWidth(metaLines[0]);
      lines[lines.length - 1] += repeat(" ", pad) + metaLines[0];
    } else {
      const continuationPrefix = repeat(" ", metaIndent);
      for (const line of metaLines) {
        lines.push(truncate(continuationPrefix + line, ui.width));
      }
    }
  }

  return lines.join("\n");
}
