// Lightweight columnar table renderer. Right-aligns numeric columns,
// left-aligns text. No borders; uses whitespace alignment.

import { padEnd, padStart, visualWidth, truncate, wrap } from "./text.mjs";

// renderTable({
//   columns: [
//     { key: "label", header: "metric", align: "left" },
//     { key: "value", header: "current", align: "right" },
//   ],
//   rows: [{ label: "...", value: "..." }, ...],
//   gap: 2,
//   maxWidth: 80,   // optional. If total row width exceeds this, shrinks
//                   // the widest shrinkable left-aligned column down to its
//                   // minWidth. Cells beyond their column width are truncated.
// })
//
// Per-column `wrap: true` opts a left-aligned column into hanging-indent
// wrapping: cells that exceed the column width emit multiple visual lines
// (continuation rows pad the other columns with spaces). Use this for the
// most variable-length column when you'd rather grow vertically than lose
// information to an ellipsis.
//
// Per-row `__after` (string) is emitted as a stand-alone line directly
// below the row, untouched by column alignment. Use it for a full-width
// dim continuation line (e.g. a long reason that won't fit in any cell).
export function renderTable({ columns, rows, gap = 2, maxWidth = null }) {
  const structuralWidth = columns.reduce(
    (total, col) => total + Math.max(col.minWidth ?? 0, visualWidth(String(col.header ?? ""))),
    Math.max(0, columns.length - 1) * gap,
  );
  if (typeof maxWidth === "number" && maxWidth > 0 && maxWidth < structuralWidth) {
    return renderCompactTable(columns, rows, Math.floor(maxWidth));
  }

  const widths = columns.map((col) => {
    const header = col.header ?? "";
    const max = rows.reduce(
      (acc, row) => Math.max(acc, visualWidth(cellText(row[col.key]))),
      visualWidth(String(header)),
    );
    return Math.max(max, col.minWidth ?? 0);
  });

  if (typeof maxWidth === "number" && maxWidth > 0) {
    fitWidths(columns, widths, gap, maxWidth);
  }

  const lines = [];
  const gapStr = " ".repeat(gap);

  if (columns.some((col) => col.header != null)) {
    lines.push(columns.map((col, i) => alignCell(col.header ?? "", widths[i], col.align)).join(gapStr).replace(/\s+$/, ""));
  }

  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const raw = row[col.key];
      const isObj = raw != null && typeof raw === "object" && "text" in raw;
      const text = String(isObj ? raw.text : (raw ?? ""));
      const color = isObj && typeof raw.color === "function" ? raw.color : (s) => s;
      if (col.wrap && visualWidth(text) > widths[i]) {
        return wrap(text, widths[i]).map(color);
      }
      return [color(text)];
    });
    const rowHeight = cells.reduce((acc, c) => Math.max(acc, c.length), 1);
    for (let line = 0; line < rowHeight; line += 1) {
      const parts = columns.map((col, i) => {
        const cellLines = cells[i];
        const txt = line < cellLines.length ? cellLines[line] : "";
        return alignCell(txt, widths[i], col.align);
      });
      lines.push(parts.join(gapStr).replace(/\s+$/, ""));
    }
    if (typeof row.__after === "string" && row.__after.length > 0) {
      lines.push(row.__after);
    }
  }

  return lines.join("\n");
}

function renderCompactTable(columns, rows, maxWidth) {
  const lines = [];
  for (const row of rows) {
    for (const col of columns) {
      const raw = row[col.key];
      const isObj = raw != null && typeof raw === "object" && "text" in raw;
      const text = String(isObj ? raw.text : (raw ?? ""));
      if (text.length === 0) continue;
      const color = isObj && typeof raw.color === "function" ? raw.color : (value) => value;
      const label = String(col.header ?? col.key ?? "").trim();
      const prefix = label ? `${label}: ` : "";
      if (prefix && visualWidth(prefix) >= maxWidth) {
        lines.push(truncate(label, maxWidth));
        const valueIndent = " ".repeat(Math.min(2, Math.max(0, maxWidth - 1)));
        const valueWidth = Math.max(1, maxWidth - visualWidth(valueIndent));
        for (const line of wrap(text, valueWidth)) {
          lines.push(truncate(valueIndent + color(line), maxWidth));
        }
        continue;
      }
      const available = Math.max(1, maxWidth - visualWidth(prefix));
      const wrapped = wrap(text, available);
      lines.push(truncate(prefix + color(wrapped[0] ?? ""), maxWidth));
      const indent = " ".repeat(Math.min(visualWidth(prefix), Math.max(0, maxWidth - 1)));
      for (const line of wrapped.slice(1)) {
        lines.push(truncate(indent + color(line), maxWidth));
      }
    }
    if (typeof row.__after === "string" && row.__after.length > 0) {
      lines.push(...wrap(row.__after, maxWidth));
    }
  }
  return lines.join("\n");
}

function fitWidths(columns, widths, gap, maxWidth) {
  const totalGap = Math.max(0, columns.length - 1) * gap;
  let total = widths.reduce((a, b) => a + b, 0) + totalGap;
  while (total > maxWidth) {
    // Find the most-overgrown left-aligned column (largest width above minWidth).
    let pick = -1;
    let bestSlack = 0;
    for (let i = 0; i < columns.length; i += 1) {
      if (columns[i].align === "right") continue;
      const slack = widths[i] - (columns[i].minWidth ?? 0);
      if (slack > bestSlack) { bestSlack = slack; pick = i; }
    }
    if (pick === -1) break;
    widths[pick] -= 1;
    total -= 1;
  }
}

function alignCell(text, width, align) {
  const truncated = visualWidth(text) > width ? truncate(text, width) : text;
  if (align === "right") return padStart(truncated, width);
  return padEnd(truncated, width);
}

function cellText(raw) {
  if (raw == null) return "";
  if (typeof raw === "object" && "text" in raw) return String(raw.text ?? "");
  return String(raw);
}
