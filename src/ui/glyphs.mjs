// Glyph sets. Unicode (rich) and ASCII (CI/non-UTF-8 fallback).

const UNICODE = {
  // Status
  check: "✓",
  cross: "✗",
  warn: "⚠",
  pause: "⏸",
  // Pointers
  play: "▶",
  arrow: "→",
  bullet: "•",
  sep: "·",
  diamond: "◆",
  // Trend
  up: "↑",
  down: "↓",
  flat: "→",
  // Box drawing (light)
  hLight: "─",
  vLight: "│",
  tlLight: "╭",
  trLight: "╮",
  blLight: "╰",
  brLight: "╯",
  teeRight: "├",
  teeLeft: "┤",
  // Box drawing (heavy / double)
  hHeavy: "═",
  vHeavy: "║",
  tlHeavy: "╔",
  trHeavy: "╗",
  blHeavy: "╚",
  brHeavy: "╝",
  // Bars
  bar: "█",
  barEmpty: "░",
  shadeMed: "▒",
  // Magnitude bar (single block, used in metric regression tables)
  block: "▇",
  // Sparkline (low to high)
  spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  // Spinner frames (Braille)
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII = {
  check: "[OK]",
  cross: "[X]",
  warn: "[!]",
  pause: "[..]",
  play: ">",
  arrow: "->",
  bullet: "*",
  sep: "-",
  diamond: "*",
  up: "^",
  down: "v",
  flat: "-",
  hLight: "-",
  vLight: "|",
  tlLight: "+",
  trLight: "+",
  blLight: "+",
  brLight: "+",
  teeRight: "+",
  teeLeft: "+",
  hHeavy: "=",
  vHeavy: "|",
  tlHeavy: "+",
  trHeavy: "+",
  blHeavy: "+",
  brHeavy: "+",
  bar: "#",
  barEmpty: "-",
  shadeMed: "#",
  block: "#",
  spark: [".", ".", "-", "-", "=", "=", "#", "#"],
  spinner: ["|", "/", "-", "\\"],
};

export function makeGlyphs(ui) {
  return ui && ui.ascii ? ASCII : UNICODE;
}

// Severity-tiered glyph for compare findings / metric regressions.
//   "fail"    -> red cross  (status fail, tolerance blown wide)
//   "warn"    -> amber up-triangle / warn glyph (structural anomaly, over-tolerance)
//   "info"    -> dim up-arrow (over-baseline but under-tolerance)
export function severityGlyph(glyphs, level) {
  switch (String(level).toLowerCase()) {
    case "fail":
    case "blocking":
      return glyphs.cross;
    case "warn":
    case "warning":
      return glyphs.warn;
    case "info":
    default:
      return glyphs.up;
  }
}

// Map an internal status to its glyph slot.
export function statusGlyph(glyphs, status) {
  switch (String(status).toUpperCase()) {
    case "PASS":
    case "SHIP":
      return glyphs.check;
    case "FAIL":
    case "DO_NOT_SHIP":
      return glyphs.cross;
    case "INCOMPLETE":
    case "PARTIAL":
      return glyphs.warn;
    case "BLOCKED":
      return glyphs.pause;
    case "SKIPPED":
    case "DRY-RUN":
    case "DRY_RUN":
      return glyphs.bullet;
    default:
      return glyphs.bullet;
  }
}
