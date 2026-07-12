// ANSI-aware text utilities: width measurement, padding, truncation, wrapping.

import cliTruncate from "cli-truncate";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { stripAnsi } from "./color.mjs";

export function visualWidth(text) {
  if (text == null) return 0;
  return stringWidth(String(text));
}

export function padEnd(text, width, char = " ") {
  const w = visualWidth(text);
  if (w >= width) return text;
  return text + char.repeat(width - w);
}

export function padStart(text, width, char = " ") {
  const w = visualWidth(text);
  if (w >= width) return text;
  return char.repeat(width - w) + text;
}

export function truncate(text, width, ellipsis = "…") {
  const columns = normalizeColumns(width);
  if (columns === 0) return "";
  return cliTruncate(String(text), columns, { truncationCharacter: ellipsis });
}

export function repeat(char, n) {
  if (n <= 0) return "";
  return char.repeat(n);
}

// Wrap at word boundaries while preserving ANSI styling. Long words are hard
// wrapped so no returned line exceeds the requested terminal-cell width.
export function wrap(text, width) {
  const columns = normalizeColumns(width);
  if (columns === 0) return [""];
  const source = String(text);
  const lines = wrapAnsi(source, columns, {
    hard: true,
    trim: true,
    wordWrap: true,
  }).split("\n");
  if (
    lines.length > 1
    && visualWidth(lines[0]) === 0
    && !stripAnsi(source).startsWith("\n")
  ) {
    lines.shift();
  }
  return lines.map((line) => (visualWidth(line) <= columns ? line : truncate(line, columns)));
}

// Indent every line of a multi-line string with the given prefix.
export function indent(text, prefix = "  ") {
  return String(text).split("\n").map((line) => prefix + line).join("\n");
}

function normalizeColumns(width) {
  const columns = Number(width);
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 0;
}
