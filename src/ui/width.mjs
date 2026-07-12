// Width resolution + horizontal framing.
//
// Wide terminals stretch our verdict bands, KPI strips, and tables out
// of their designed proportions. We cap content at a soft maximum and
// leave the rest of the terminal as empty margin.
//
// Width resolution is numeric; final line fitting uses shared ANSI-aware text
// helpers so rendered output stays within the chosen terminal-cell budget.

import { truncate, visualWidth, wrap } from "./text.mjs";
import { stripAnsi } from "./color.mjs";

export const WIDTH_DEFAULT = 80;
export const WIDTH_MIN = 40;
export const WIDTH_ENV = "KOVA_WIDTH";
export const ALIGN_ENV = "KOVA_ALIGN";

// resolveWidth(termCols, flags, env) -> { width, leftPad, capped, align }
//
// terminalCols  raw stream.columns (or default)
// flags.width   "auto" | "full" | "off" | number | true | undefined
// flags.align   "left" | "center" | undefined
// env.KOVA_WIDTH same shape as flags.width
// env.KOVA_ALIGN same shape as flags.align
export function resolveWidth(termCols, flags = {}, env = process.env) {
  const terminalWidth = positiveInteger(termCols) ?? WIDTH_DEFAULT;
  const align = pickAlign(flags.align, env[ALIGN_ENV]);
  const target = pickWidth(flags.width, env[WIDTH_ENV], terminalWidth);
  const width = Math.min(terminalWidth, Math.max(WIDTH_MIN, target));
  const slack = terminalWidth - width;
  const leftPad = align === "center" ? Math.floor(slack / 2) : 0;
  return { width, leftPad, capped: width < terminalWidth, align };
}

function pickWidth(flag, envVal, termCols) {
  for (const v of [flag, envVal]) {
    if (v == null || v === "" || v === true || v === "auto") continue;
    const s = String(v).toLowerCase();
    if (s === "full" || s === "off" || s === "none") return termCols;
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return WIDTH_DEFAULT;
}

function pickAlign(flag, envVal) {
  for (const v of [flag, envVal]) {
    if (v == null || v === "" || v === true) continue;
    const s = String(v).toLowerCase();
    if (s === "center" || s === "centre" || s === "middle") return "center";
    if (s === "left" || s === "start") return "left";
  }
  return "left";
}

function positiveInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

// withMargin(text, leftPad, width) -> text constrained to `width` content
// cells with `leftPad` spaces prepended. Margin is part of line fitting so
// wrapped shell expressions never gain whitespace between literal chunks.
export function withMargin(text, leftPad, width = null) {
  const contentWidth = positiveInteger(width);
  const margin = positiveInteger(leftPad) ?? 0;
  const pad = " ".repeat(margin);
  const totalWidth = contentWidth === null ? null : contentWidth + margin;
  return String(text)
    .split("\n")
    .flatMap((line) => constrainLine(line === "" ? line : pad + line, totalWidth))
    .join("\n");
}

function constrainLine(line, width) {
  if (!width || visualWidth(line) <= width) return [line];
  const plain = stripAnsi(line);
  const command = plain.match(/^(\s*(?:→|->)\s+)(.+)$/u);
  if (command) {
    const rawCommandIndex = line.lastIndexOf(command[2]);
    const rawPrefix = rawCommandIndex >= 0 ? line.slice(0, rawCommandIndex) : command[1];
    return constrainCommandLine(rawPrefix, command[2], width);
  }
  const leading = line.match(/^\s*/u)?.[0] ?? "";
  const indentWidth = Math.min(visualWidth(leading), Math.max(0, width - 1));
  const indent = " ".repeat(indentWidth);
  const bodyWidth = Math.max(1, width - indentWidth);
  return wrap(line.slice(leading.length), bodyWidth).map((part) => indent + part);
}

function constrainCommandLine(prefix, command, width) {
  if (width < 12) return [truncate(prefix + command, width)];
  if (!isSimpleShellCommand(command)) return constrainShellExpression(prefix, command, width);
  const prefixFits = visualWidth(prefix) + 3 <= width;
  const continuationWidth = prefixFits ? visualWidth(prefix) : 0;
  const continuation = " ".repeat(continuationWidth);
  const bodyWidth = Math.max(1, width - continuationWidth - 2);
  const chunks = wrapShellCommand(command, bodyWidth);
  if (!chunks) return constrainShellExpression(prefix, command, width);
  const lines = prefixFits ? [] : [truncate(prefix, width)];
  chunks.forEach((chunk, index) => {
    const linePrefix = prefixFits && index === 0 ? prefix : continuation;
    const suffix = index < chunks.length - 1 ? " \\" : "";
    lines.push(linePrefix + chunk.text + suffix);
  });
  return lines;
}

function wrapShellCommand(command, width) {
  const chunks = [];
  let current = "";
  for (const word of String(command).trim().split(/\s+/u)) {
    if (visualWidth(word) > width) return null;
    if (current && visualWidth(`${current} ${word}`) <= width) {
      current += ` ${word}`;
      continue;
    }
    if (current) {
      chunks.push({ text: current });
      current = "";
    }
    current = word;
  }
  if (current) chunks.push({ text: current });
  return chunks;
}

function isSimpleShellCommand(command) {
  return /^[A-Za-z0-9_@%+=:,./-]+(?:\s+[A-Za-z0-9_@%+=:,./-]+)*$/u.test(command);
}

function constrainShellExpression(prefix, command, width) {
  let inlinePrefix = visualWidth(prefix) + 9 < width ? prefix : "";
  let chunks = splitShellLiteral(command, width - visualWidth(inlinePrefix) - 6);
  if (!chunks && inlinePrefix) {
    inlinePrefix = "";
    chunks = splitShellLiteral(command, width - 6);
  }
  if (!chunks) return [truncate(prefix + command, width)];

  const lines = inlinePrefix ? [] : [truncate(prefix, width)];
  chunks.forEach((chunk, index) => {
    const linePrefix = index === 0 ? `${inlinePrefix}eval ` : "";
    const suffix = index < chunks.length - 1 ? "\\" : "";
    lines.push(linePrefix + quoteShellLiteral(chunk) + suffix);
  });
  return lines;
}

function splitShellLiteral(value, width) {
  if (width < 2) return null;
  const chunks = [];
  let current = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    const candidate = current + segment;
    if (visualWidth(quoteShellLiteral(candidate)) <= width) {
      current = candidate;
      continue;
    }
    if (!current) return null;
    chunks.push(current);
    current = segment;
    if (visualWidth(quoteShellLiteral(current)) > width) return null;
  }
  if (current) chunks.push(current);
  return chunks;
}

function quoteShellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
