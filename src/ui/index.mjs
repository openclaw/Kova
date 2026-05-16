// Public surface of the Kova UI toolkit.
// Renderers should consume only from this barrel:
//   import { makeUi } from "../ui/index.mjs";

export { resolveUiOptions, detectCapabilities } from "./terminal.mjs";
export { resolveWidth, withMargin, WIDTH_DEFAULT, WIDTH_MIN } from "./width.mjs";
export { makeColor, stripAnsi } from "./color.mjs";
export { makeGlyphs, statusGlyph, severityGlyph } from "./glyphs.mjs";
export {
  visualWidth, padEnd, padStart, truncate, repeat, wrap, indent,
} from "./text.mjs";
export {
  formatNumber, formatPercent, formatDuration, formatBytes,
  computeDelta, classifyDelta,
} from "./format.mjs";
export { renderTable } from "./tables.mjs";
export { gauge, sparkline, progressBar } from "./bars.mjs";
export { badge } from "./badges.mjs";
export { heavyBand, ruleSection, card, sideBySide, SIDE_BY_SIDE_MIN_WIDTH } from "./layout.mjs";
export { renderKovaHeader } from "./header.mjs";
export { kpiStrip } from "./kpi-strip.mjs";

// Convenience: bundle resolved options plus color/glyph helpers.
import { resolveUiOptions as _resolve } from "./terminal.mjs";
import { makeColor as _color } from "./color.mjs";
import { makeGlyphs as _glyphs } from "./glyphs.mjs";

export function makeUi(flags, env = process.env, stream = process.stdout) {
  const ui = _resolve(flags, env, stream);
  ui.c = _color(ui);
  ui.g = _glyphs(ui);
  return ui;
}
