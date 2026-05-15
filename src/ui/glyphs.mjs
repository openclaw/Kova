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
  spark: [".", ".", "-", "-", "=", "=", "#", "#"],
  spinner: ["|", "/", "-", "\\"],
};

export function makeGlyphs(ui) {
  return ui && ui.ascii ? ASCII : UNICODE;
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
