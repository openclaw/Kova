// Layout primitives: heavy verdict band, rule sections, cards, side-by-side
// with stacked degradation. All width-aware and ANSI-aware.

import { makeColor } from "./color.mjs";
import { makeGlyphs } from "./glyphs.mjs";
import { padEnd, visualWidth, repeat, truncate, wrap } from "./text.mjs";

const SIDE_BY_SIDE_MIN_WIDTH = 120;

// heavyBand({ badge, status, title, meta, width, ui })
// Renders the chunky double-line band used on kova report's decision header.
//   ╔═══════════════════════════════════════╗
//   ║  [SHIP]  PASS   TITLE   meta...       ║
//   ╚═══════════════════════════════════════╝
export function heavyBand({ badgeText = "", status = "", title = "", meta = "", width, ui }) {
  const c = makeColor(ui);
  const g = makeGlyphs(ui);
  const frameWidth = positiveWidth(width);
  if (frameWidth < 4) {
    return truncate([badgeText, status, title, meta].filter(Boolean).join(" "), frameWidth);
  }
  const inner = frameWidth - 2;

  const top = c.head(g.tlHeavy + repeat(g.hHeavy, inner) + g.trHeavy);
  const bot = c.head(g.blHeavy + repeat(g.hHeavy, inner) + g.brHeavy);

  const statusColored = colorStatus(c, status);
  const titleColored = c.head(title);
  const metaColored = c.dim(meta);

  const parts = [badgeText, statusColored, titleColored, metaColored].filter(Boolean);
  let content = "  " + parts.join("  ");
  if (visualWidth(content) > inner) {
    // Drop the meta first - it's the lowest-priority part. If still too long,
    // truncate what remains with an ellipsis.
    content = "  " + [badgeText, statusColored, titleColored].filter(Boolean).join("  ");
    if (visualWidth(content) > inner) {
      const plain = "  " + [badgeText, status, title].filter(Boolean).join("  ");
      content = truncate(plain, inner);
    }
  }
  const padded = padEnd(content, inner);

  const middle = c.head(g.vHeavy) + padded + c.head(g.vHeavy);

  return [top, middle, bot].join("\n");
}

// ruleSection("findings", width) -> "─── findings ──────────────…"
export function ruleSection(label, width, ui) {
  const c = makeColor(ui);
  const g = makeGlyphs(ui);
  const lineWidth = positiveWidth(width);
  if (lineWidth === 0) return "";
  const prefix = repeat(g.hLight, 3) + (label ? ` ${label} ` : "");
  if (visualWidth(prefix) >= lineWidth) return c.dim(truncate(prefix, lineWidth));
  return c.dim(prefix + repeat(g.hLight, lineWidth - visualWidth(prefix)));
}

// card({ title, lines, width, ui })
// Light-box panel used for KPI cards (Proof / Health / Performance).
//   ┌─ Proof ──────────┐
//   │ <line>           │
//   │ <line>           │
//   └──────────────────┘
export function card({ title = "", lines = [], width, ui }) {
  const c = makeColor(ui);
  const g = makeGlyphs(ui);
  const frameWidth = positiveWidth(width);
  if (frameWidth < 4) {
    return [title, ...lines]
      .flatMap((line) => wrap(String(line), frameWidth))
      .join("\n");
  }
  const inner = frameWidth - 2;

  const titleBudget = Math.max(0, inner - 3);
  const titleText = titleBudget > 0 ? truncate(title, titleBudget) : "";
  const titleSegment = titleText ? `${g.hLight} ${titleText} ` : "";
  const topFill = repeat(g.hLight, Math.max(0, inner - visualWidth(titleSegment)));
  const top = c.dim(g.tlLight + titleSegment + topFill + g.trLight);
  const bot = c.dim(g.blLight + repeat(g.hLight, inner) + g.brLight);
  const body = lines.map((raw) => {
    const padded = padEnd(" " + raw + " ", inner);
    return c.dim(g.vLight) + padded + c.dim(g.vLight);
  });

  return [top, ...body, bot].join("\n");
}

// sideBySide([blockA, blockB, blockC], { width, gap, ui })
// Renders multiline blocks horizontally. Falls back to vertical stacking
// when the total width is below SIDE_BY_SIDE_MIN_WIDTH or when blocks don't fit.
export function sideBySide(blocks, { width, gap = 2, minWidth = SIDE_BY_SIDE_MIN_WIDTH } = {}) {
  if (!blocks || blocks.length === 0) return "";
  if (blocks.length === 1) return blocks[0];

  const rendered = blocks.map((b) => String(b).split("\n"));
  const blockWidths = rendered.map((lines) => lines.reduce((m, l) => Math.max(m, visualWidth(l)), 0));
  const total = blockWidths.reduce((a, b) => a + b, 0) + gap * (blocks.length - 1);

  if (width < minWidth || total > width) {
    return rendered.map((lines) => lines.join("\n")).join("\n");
  }

  const maxLines = Math.max(...rendered.map((lines) => lines.length));
  const out = [];
  for (let row = 0; row < maxLines; row += 1) {
    const cells = rendered.map((lines, i) => padEnd(lines[row] ?? "", blockWidths[i]));
    out.push(cells.join(repeat(" ", gap)));
  }
  return out.join("\n");
}

function colorStatus(c, status) {
  const upper = String(status).toUpperCase();
  if (upper === "PASS" || upper === "SHIP" || upper === "HEALTHY") return c.bold(c.ok(upper));
  if (upper === "FAIL" || upper === "DO_NOT_SHIP") return c.bold(c.err(upper));
  if (upper === "INCOMPLETE" || upper === "PARTIAL" || upper === "REGRESSION") return c.bold(c.warn(upper));
  if (upper === "BLOCKED") return c.bold(c.block(upper));
  return c.bold(upper);
}

function positiveWidth(width) {
  const value = Number(width);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export { SIDE_BY_SIDE_MIN_WIDTH };
