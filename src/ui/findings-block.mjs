// Findings block. Renders a bulleted list of findings with optional
// sign-prefix for compare mode (+ new, − resolved).
//
//   Findings
//     ✗ agent.turn.ms over threshold by 240 ms                  agent-runtime
//       scenario/state · evidence excerpt
//     ⚠ readiness slow                                          gateway
//
// Compare variant prefixes the glyph with "+" (new finding) or "−"
// (resolved finding):
//
//   Findings
//     + ✗ agent.turn.ms over threshold by 240 ms                agent-runtime
//     − ✗ readiness slow                                        gateway

import { statusGlyph } from "./glyphs.mjs";
import { visualWidth, repeat, wrap } from "./text.mjs";

// findingsBlock({ findings, compare, ui, limit }) -> string
//
//   findings:
//     [{ severity, summary, scope?, evidence?, ownerArea?, sign? }]
//   sign: "+" (new) | "-" (resolved) — only honored when compare === true
export function findingsBlock({ findings, compare = false, ui, limit = null } = {}) {
  if (!findings || findings.length === 0) return "";
  const c = ui.c;
  const g = ui.g;
  const width = ui.width;
  const top = limit ? findings.slice(0, limit) : findings;

  const lines = [];
  for (const f of top) {
    const sev = severityToStatus(f.severity);
    const glyph = colorize(c, sev, statusGlyph(g, sev));
    const signCh = compare && f.sign ? `${signColor(c, f.sign)} ` : "";
    const owner = f.ownerArea ? c.dim(` ${g.sep} ${f.ownerArea}`) : "";
    const head = `  ${signCh}${glyph} ${c.bold(truncate(f.summary ?? "", width - 24))}${owner}`;
    lines.push(head);

    const scope = formatScope(f);
    const evidence = (f.evidence ?? []).slice(0, 2).join("; ");
    const detail = [scope, evidence].filter(Boolean).join("  ");
    if (detail) {
      const indent = 6;
      const wrapped = wrap(detail, Math.max(20, width - indent));
      for (const w of wrapped) lines.push(repeat(" ", indent) + c.dim(w));
    }
  }

  const more = findings.length - top.length;
  if (more > 0) {
    lines.push(`  ${c.dim(`+ ${more} more finding${more === 1 ? "" : "s"} (--full)`)}`);
  }
  return lines.join("\n");
}

function formatScope(f) {
  const parts = [];
  if (f.scope) return String(f.scope);
  if (f.scenario) parts.push(f.scenario);
  if (f.state) parts.push(f.state);
  return parts.join("/");
}

function severityToStatus(sev) {
  switch (String(sev ?? "").toLowerCase()) {
    case "blocking":
    case "fail":
      return "FAIL";
    case "incomplete":
    case "warning":
    case "diagnostic-gap":
      return "INCOMPLETE";
    case "blocked":
      return "BLOCKED";
    default:
      return "SKIPPED";
  }
}

function signColor(c, sign) {
  if (sign === "+") return c.neg("+");
  if (sign === "-") return c.pos("−");
  return c.dim(sign);
}

function colorize(c, status, text) {
  if (status === "FAIL") return c.err(text);
  if (status === "INCOMPLETE") return c.warn(text);
  if (status === "BLOCKED") return c.block(text);
  if (status === "PASS") return c.ok(text);
  return c.dim(text);
}

function truncate(text, max) {
  if (max <= 4) return text;
  if (visualWidth(text) <= max) return text;
  return text.slice(0, max - 1) + "…";
}
