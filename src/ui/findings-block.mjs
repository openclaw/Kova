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
export function findingsBlock({ findings, compare = false, ui, limit = null, indent = 0 } = {}) {
  if (!findings || findings.length === 0) return "";
  const c = ui.c;
  const g = ui.g;
  const width = Math.max(20, (ui.width ?? 80) - indent);
  const top = limit ? findings.slice(0, limit) : findings;

  const lines = [];
  for (const f of top) {
    const sev = severityToStatus(f.severity);
    const glyph = colorize(c, sev, statusGlyph(g, sev));
    const signCh = compare && f.sign ? `${signColor(c, f.sign)} ` : "";
    // Drop the owner suffix when it equals the implicit default ("OpenClaw").
    // Every Kova finding belongs to OpenClaw; only surface owner when it
    // differs (e.g. "test", subsystem owners).
    const ownerLabel = normalizeOwner(f.ownerArea);
    const ownerSuffix = ownerLabel ? ` ${g.sep} ${ownerLabel}` : "";

    // Build the prefix exactly once so we can measure it for hanging-indent
    // wrapping. Visible cols: 2 margin + signCh + glyph + 1 space.
    const prefixPlain = `  ${stripAnsiSafe(signCh)}${stripAnsiSafe(glyph)} `;
    const prefixWidth = visualWidth(prefixPlain);

    const summary = tightenSummary(f.summary ?? "");
    const headLines = wrapSummaryWithOwner(summary, ownerSuffix, width - prefixWidth);

    headLines.forEach((line, i) => {
      const pad = i === 0 ? `  ${signCh}${glyph} ` : repeat(" ", prefixWidth);
      // Bold only the summary text; owner suffix stays dim. Owner is appended
      // verbatim to the last visible line (already accounted for in wrap).
      const isLast = i === headLines.length - 1;
      if (isLast && ownerSuffix && line.endsWith(ownerSuffix)) {
        const body = line.slice(0, line.length - ownerSuffix.length);
        lines.push(`${pad}${c.bold(body)}${c.dim(ownerSuffix)}`);
      } else {
        lines.push(`${pad}${c.bold(line)}`);
      }
    });

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

// stripAnsiSafe: visualWidth already handles ANSI, but for the prefix we
// build a "plain" copy to keep the math obvious. Local helper avoids an
// extra import; the prefix only contains the sign + glyph so the strip
// pattern is intentionally simple.
function stripAnsiSafe(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

function normalizeOwner(owner) {
  if (!owner) return "";
  const trimmed = String(owner).trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase() === "openclaw") return "";
  return trimmed;
}

// Tighten verbose evaluator phrasing so headlines fit without truncation.
// Pure presentation transform; the underlying message stays unchanged in
// the JSON report and in `summary` fields used by tests.
function tightenSummary(text) {
  let s = String(text ?? "");
  // ", over threshold 4000ms" -> " (cap 4,000ms)"
  s = s.replace(/,\s*over threshold\s+(\d[\d,]*)\s*(ms|MB|mb)\b/gi, (_m, n, u) => ` (cap ${commaNum(n)} ${u.toLowerCase() === "mb" ? "MB" : "ms"})`);
  // "exceeded threshold 900 MB" -> "(cap 900 MB)"
  s = s.replace(/\s*exceeded threshold\s+(\d[\d,]*)\s*(ms|MB|mb)\b/gi, (_m, n, u) => ` (cap ${commaNum(n)} ${u.toLowerCase() === "mb" ? "MB" : "ms"})`);
  // "spent 11792ms before provider work" -> "took 11,792ms pre-provider"
  s = s.replace(/\bspent\s+(\d[\d,]*)\s*ms\s+before provider work\b/gi, (_m, n) => `took ${commaNum(n)}ms pre-provider`);
  // "pre-provider latency was 11792ms" -> "pre-provider 11,792ms"
  s = s.replace(/\bpre-provider latency was\s+(\d[\d,]*)\s*ms\b/gi, (_m, n) => `pre-provider ${commaNum(n)}ms`);
  // Comma-format any remaining bare 4+ digit ms/MB numbers.
  s = s.replace(/(\d{4,})\s*(ms|MB)\b/g, (_m, n, u) => `${commaNum(n)} ${u}`);
  return s.replace(/\s{2,}/g, " ").trim();
}

function commaNum(n) {
  const plain = String(n).replace(/,/g, "");
  if (!/^\d+$/.test(plain)) return n;
  return plain.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Wrap the summary so the first line gets `available` cols, subsequent lines
// also get `available` cols (after the hanging indent the caller applies).
// The owner suffix is glued to the last line when it fits there; otherwise
// it gets its own continuation line.
function wrapSummaryWithOwner(summary, ownerSuffix, available) {
  const min = Math.max(20, available);
  if (!ownerSuffix) return wrap(summary, min);

  const lines = wrap(summary, min);
  const last = lines[lines.length - 1];
  if (visualWidth(last) + visualWidth(ownerSuffix) <= min) {
    lines[lines.length - 1] = last + ownerSuffix;
  } else {
    lines.push(ownerSuffix.replace(/^\s+/, ""));
  }
  return lines;
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
