// kova report bundle <report.json> - confirmation panel.

import { makeUi, heavyBand, ruleSection, badge, visualWidth, repeat, wrap, withMargin } from "../ui/index.mjs";
import { relative } from "node:path";

export function renderBundleReceipt(receipt, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const { c, g } = ui;
  const cwd = process.cwd();

  const sections = [];
  sections.push(heavyBand({
    badgeText: badge("BUNDLED", "PASS", ui),
    status: "OK",
    title: "KOVA BUNDLE",
    meta: receipt.runId ? `run: ${receipt.runId}` : "",
    width: ui.width,
    ui,
  }));
  sections.push("");
  sections.push(ruleSection("artifact", ui.width, ui));

  const labelCol = 10;
  const rows = [
    ["archive", relative(cwd, receipt.outputPath ?? "")],
    ["sha256",  relative(cwd, receipt.checksumPath ?? "")],
    ["digest",  receipt.sha256 ? receipt.sha256.slice(0, 16) + "…" : "—"],
    ["size",    formatBytes(receipt.bytes)],
    ["files",   String(receipt.artifactIndex?.fileCount ?? receipt.included?.length ?? 0)],
  ];

  for (const [label, value] of rows) {
    if (!value) continue;
    const head = `  ${c.dim(padEndPlain(label, labelCol))}  `;
    const avail = Math.max(20, ui.width - visualWidth(head));
    const wrapped = wrap(String(value), avail);
    sections.push(head + c.met(wrapped[0] ?? ""));
    for (const cont of wrapped.slice(1)) {
      sections.push(repeat(" ", visualWidth(head)) + c.met(cont));
    }
  }

  sections.push("");
  sections.push(c.dim(`Generated ${g.sep}  ${receipt.generatedAt ?? new Date().toISOString()}`));

  return withMargin(sections.join("\n"), ui.leftPad);
}

function formatBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  if (x < 1024 * 1024 * 1024) return `${(x / 1024 / 1024).toFixed(1)} MB`;
  return `${(x / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function padEndPlain(text, width) {
  const w = visualWidth(text);
  if (w >= width) return text;
  return text + repeat(" ", width - w);
}
