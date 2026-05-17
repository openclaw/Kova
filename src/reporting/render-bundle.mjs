// kova report bundle <report.json> - confirmation panel.

import { makeUi, ruleSection, renderKovaHeader, visualWidth, repeat, wrap, withMargin } from "../ui/index.mjs";
import { relative } from "node:path";

export function renderBundleReceipt(receipt, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const { c, g } = ui;
  const cwd = process.cwd();

  const sections = [];
  sections.push(renderKovaHeader({
    surface: "report bundle",
    verdict: "OK",
    headline: `bundled ${receipt.artifactIndex?.fileCount ?? receipt.included?.length ?? 0} file${(receipt.artifactIndex?.fileCount ?? receipt.included?.length ?? 0) === 1 ? "" : "s"}`,
    meta: receipt.runId ? `run: ${receipt.runId}` : "",
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
  sections.push(ruleSection("next", ui.width, ui));
  sections.push("");
  sections.push(`  ${c.dim(g.arrow)} kova report ${relative(cwd, receipt.outputPath ?? "")}`);
  if (receipt.runId) sections.push(`  ${c.dim(g.arrow)} kova report ${receipt.runId}`);

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
