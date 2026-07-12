// Per-scenario rule header.
//
//   ─── agent-cold-warm-message ──────────── [FAIL] · 5 samples ─────
//
// Used to open each per-scenario block in report / compare / receipt.
// The verdict and sample-count chip is right-aligned; the rule fills
// the middle. Verdict can be any of PASS / FAIL / REGRESSED / IMPROVED /
// UNCHANGED / SHIP / DO_NOT_SHIP / BLOCKED / DRY-RUN.

import { makeColor } from "./color.mjs";
import { makeGlyphs } from "./glyphs.mjs";
import { visualWidth, repeat, truncate } from "./text.mjs";
import { badge } from "./badges.mjs";

// scenarioRule({ id, verdict, samples, ui }) -> string
//   id       - scenario id (required)
//   verdict  - status word; rendered as a badge using existing badge palette
//   samples  - optional count; rendered as "N samples" (or "N/N" if string)
//   note     - optional extra dim suffix (e.g. " worst -8%")
export function scenarioRule({ id, verdict = "", samples = null, note = "", ui }) {
  const c = ui.c ?? makeColor(ui);
  const g = ui.g ?? makeGlyphs(ui);
  const width = ui.width;
  const sep = ` ${g.sep} `;

  const prefix = repeat(g.hLight, 3) + ` ${id} `;
  const verdictBadge = verdict ? mapVerdictBadge(verdict, ui) : "";
  const sampleText = samples == null ? "" : (typeof samples === "string" ? samples : `${samples} sample${samples === 1 ? "" : "s"}`);
  const right = [verdictBadge, sampleText && c.dim(sampleText), note && c.dim(note)]
    .filter(Boolean)
    .join(sep);

  const prefixW = visualWidth(prefix);
  const rightW = visualWidth(right);
  if (prefixW + rightW + 5 > width) {
    const lines = [c.dim(truncate(prefix, width))];
    if (right) lines.push(truncate(right, width));
    return lines.join("\n");
  }
  const trailingLen = 3;
  const fillW = Math.max(0, width - prefixW - rightW - (right ? 2 : 0) - (right ? trailingLen : 0));
  const fill = repeat(g.hLight, fillW);
  const trailing = repeat(g.hLight, trailingLen);
  if (!right) {
    return c.dim(prefix + fill);
  }
  return c.dim(prefix) + c.dim(fill) + " " + right + " " + c.dim(trailing);
}

function mapVerdictBadge(verdict, ui) {
  const v = String(verdict).toUpperCase();
  // The badge palette already handles PASS/FAIL/SHIP/DO_NOT_SHIP/etc.
  // Map compare-only verdicts onto existing palette entries.
  switch (v) {
    case "REGRESSED": return badge("REGRESSED", "FAIL", ui);
    case "IMPROVED":  return badge("IMPROVED",  "PASS", ui);
    case "UNCHANGED": return badge("UNCHANGED", "DRY-RUN", ui);
    default: return badge(v, v, ui);
  }
}
