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
import { visualWidth, repeat } from "./text.mjs";

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
  const head = headlineText ? c.bold(headlineText) : "";
  const left = [badgeText, head].filter(Boolean).join("   ");
  const leftPadded = left ? `   ${left}` : "";

  if (!metaText) return leftPadded;

  const right = c.dim(metaText);
  const leftW = visualWidth(leftPadded);
  const rightW = visualWidth(right);
  if (leftW === 0) return `   ${right}`;
  if (leftW + 2 + rightW > ui.width) {
    const indent = badgeText ? visualWidth(badgeText) + 6 : 3;
    return `${leftPadded}\n${repeat(" ", indent)}${right}`;
  }
  const pad = Math.max(2, ui.width - leftW - rightW);
  return leftPadded + repeat(" ", pad) + right;
}
