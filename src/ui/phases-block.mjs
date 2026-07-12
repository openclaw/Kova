// Phases block. Lists each phase of a scenario with timing + outcome.
//
//   Phases
//     ✓ install     420 ms
//     ✓ first-turn  1.2 s
//     ✗ second-turn 3.4 s   over threshold by 240 ms
//
// Compare variant adds baseline · current · Δ · change columns:
//
//   Phases               baseline  current   Δ        change
//     install            390 ms    420 ms    +8%      stable
//     first-turn         1.1 s     1.2 s     +9%      stable
//     second-turn        2.1 s     3.4 s     +62%     worse

import { renderTable } from "./tables.mjs";
import { formatDuration, formatPercent, computeDelta, classifyDelta } from "./format.mjs";
import { statusGlyph } from "./glyphs.mjs";

// phasesBlock({ phases, compare, ui }) -> string
//
//   phases (single-run):
//     [{ id, status: "PASS"|"FAIL"|"WARN"|"SKIPPED", elapsedMs, note }]
//   phases (compare):
//     [{ id, baselineMs, currentMs, status }]
export function phasesBlock({ phases, compare = false, ui } = {}) {
  if (!phases || phases.length === 0) return "";
  const c = ui.c;
  const g = ui.g;

  if (!compare) {
    const rows = phases.map((p) => ({
      glyph:   colorize(c, p.status, statusGlyph(g, p.status)),
      id:      c.bold(p.id),
      elapsed: p.elapsedMs == null ? "—" : formatDuration(p.elapsedMs),
      note:    p.note ? c.dim(p.note) : "",
    }));
    return renderTable({
      columns: [
        { key: "glyph",   header: "",                align: "left",  minWidth: 1 },
        { key: "id",      header: c.dim("phase"),    align: "left",  minWidth: 18 },
        { key: "elapsed", header: c.dim("elapsed"),  align: "right", minWidth: 9 },
        { key: "note",    header: c.dim("note"),     align: "left",  minWidth: 0 },
      ],
      rows,
      gap: 2,
      maxWidth: ui.width,
    });
  }

  const rows = phases.map((p) => {
    const delta = computeDelta(p.baselineMs, p.currentMs);
    const cls = classifyDelta(delta, { direction: "lower-better" });
    const deltaText = delta == null ? "—" : formatPercent(delta, { withSign: true });
    const deltaColored = cls === "better" ? c.pos(deltaText) : cls === "worse" ? c.neg(deltaText) : c.dim(deltaText);
    const changeText = cls === "better" ? c.pos("better") : cls === "worse" ? c.neg("worse") : c.dim("stable");
    return {
      id:       c.bold(p.id),
      baseline: p.baselineMs == null ? "—" : formatDuration(p.baselineMs),
      current:  p.currentMs == null ? "—" : formatDuration(p.currentMs),
      delta:    deltaColored,
      change:   changeText,
    };
  });
  return renderTable({
    columns: [
      { key: "id",       header: c.dim("phase"),    align: "left",  minWidth: 18 },
      { key: "baseline", header: c.dim("baseline"), align: "right", minWidth: 9 },
      { key: "current",  header: c.dim("current"),  align: "right", minWidth: 9 },
      { key: "delta",    header: c.dim("Δ"),        align: "right", minWidth: 7 },
      { key: "change",   header: c.dim("change"),   align: "left",  minWidth: 7 },
    ],
    rows,
    gap: 2,
    maxWidth: ui.width,
  });
}

function colorize(c, status, text) {
  const upper = String(status ?? "").toUpperCase();
  if (upper === "PASS" || upper === "OK") return c.ok(text);
  if (upper === "FAIL") return c.err(text);
  if (upper === "WARN" || upper === "WATCH") return c.warn(text);
  if (upper === "BLOCKED") return c.block(text);
  return c.dim(text);
}
