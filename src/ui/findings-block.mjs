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
  const width = Math.max(1, (ui.width ?? 80) - indent);
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
    const evidence = (f.evidence ?? []).slice(0, 2).map(tightenSummary).join("; ");
    const detail = [scope, evidence].filter(Boolean).join(" ");
    if (detail) {
      const detailIndent = Math.min(6, Math.max(0, width - 1));
      const wrapped = wrap(detail, Math.max(1, width - detailIndent));
      for (const w of wrapped) lines.push(repeat(" ", detailIndent) + c.dim(w));
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

  // Massive leaked-process messages: keep the headline ("…leaked N
  // process(es); first leak <kind> pid <pid>") and drop the trailing
  // command line / library paths that can run hundreds of chars.
  s = s.replace(/^(.*?leaked\s+\d+\s+process\(es\))\s*(?:after completion)?;\s*first leak\s+(\S+)\s+pid\s+(\d+)[\s\S]*$/i,
    (_m, head, kind, pid) => `${head}; first leak ${kind} pid ${pid}`);

  // Long command-line "<command line> took Xms, over threshold Yms" — drop
  // the command portion when it's a giant shell invocation. Keep the
  // subject word (agent/gateway/plugin/etc.) for context.
  s = s.replace(/^[\s\S]*?\b(agent|gateway|tui|dashboard|provider|plugin|browser|mcp|matrix)\b[\s\S]*?took\s+(\d[\d,]*)\s*ms,\s*over threshold\s+(\d[\d,]*)\s*ms\s*$/i,
    (_m, subject, actual, cap) => `${subject} command took ${commaNum(actual)} ms (cap ${commaNum(cap)} ms)`);

  // ", over threshold 4000ms" -> " (cap 4,000 ms)"
  s = s.replace(/,\s*over threshold\s+(\d[\d,]*)\s*(ms|MB|mb)\b/gi, (_m, n, u) => ` (cap ${commaNum(n)} ${u.toLowerCase() === "mb" ? "MB" : "ms"})`);
  // "exceeded threshold 900 MB" -> "(cap 900 MB)"
  s = s.replace(/\s*exceeded threshold\s+(\d[\d,]*)\s*(ms|MB|mb)\b/gi, (_m, n, u) => ` (cap ${commaNum(n)} ${u.toLowerCase() === "mb" ? "MB" : "ms"})`);
  // "beyond the 30000ms threshold" -> "(cap 30,000 ms)"
  s = s.replace(/,?\s*beyond the\s+(\d[\d,]*)\s*ms\s+threshold\b/gi, (_m, n) => ` (cap ${commaNum(n)} ms)`);
  // "spent 11792ms before provider work" -> "took 11,792 ms pre-provider"
  s = s.replace(/\bspent\s+(\d[\d,]*)\s*ms\s+before provider work\b/gi, (_m, n) => `took ${commaNum(n)} ms pre-provider`);
  // "pre-provider latency was 11792ms" -> "pre-provider 11,792 ms"
  s = s.replace(/\bpre-provider latency was\s+(\d[\d,]*)\s*ms\b/gi, (_m, n) => `pre-provider ${commaNum(n)} ms`);

  // Phrase tightening — agent-turn family.
  s = s.replace(/\bagent message command finished without a usable assistant response\b/gi,
    "agent turn produced no usable assistant response");
  s = s.replace(/\bcold agent turn did not produce the expected assistant response\b/gi,
    "cold turn missing expected assistant response");
  s = s.replace(/\bcold agent turn response did not include expected marker\b/gi,
    "cold turn missing marker");
  s = s.replace(/\bcold agent turn ran with mock auth but no mock provider request was captured\b/gi,
    "cold turn (mock auth): no provider request captured");
  s = s.replace(/\bNo provider request happened during the agent turn\.?/gi,
    "no provider request during agent turn");

  // Diagnostics-span and pattern-count phrasing.
  s = s.replace(/\b(\d+)\s+missing dependency\/plugin load error patterns found\b/gi,
    (_m, n) => `${n} dependency/plugin load error pattern${n === "1" ? "" : "s"}`);
  s = s.replace(/\b(\d+)\s+plugin load failure patterns found\b/gi,
    (_m, n) => `${n} plugin load failure${n === "1" ? "" : "s"}`);
  s = s.replace(/\b(\d+)\s+required OpenClaw diagnostics span\(s\) were not observed:/gi,
    (_m, n) => `${n} OpenClaw diagnostics span${n === "1" ? "" : "s"} missing:`);
  s = s.replace(/\b(\d+)\s+gateway readiness windows expired before health was ready\b/gi,
    (_m, n) => `${n} gateway readiness window${n === "1" ? "" : "s"} expired`);

  // Gateway-hard-failure / slow-startup / health-failures phrasing.
  s = s.replace(/\bgateway hard failure:\s*gateway\s+/gi, "gateway hard failure: ");
  s = s.replace(/\s+before the hard deadline\b/gi, "");
  s = s.replace(/\bgateway slow startup:\s*gateway became healthy after\s+(\d[\d,]*)\s*ms\b/gi,
    (_m, n) => `gateway slow startup: healthy at ${commaNum(n)} ms`);
  s = s.replace(/\bgateway was not healthy after agent command;\s*gateway=running,\s*health failures=(\d+)\b/gi,
    (_m, n) => `gateway unhealthy after agent command (${n} health failure${n === "1" ? "" : "s"})`);

  // Comma-format any remaining bare 4+ digit ms/MB numbers. Use a space
  // separator to match the (cap N ms) style we emit above.
  s = s.replace(/(\d{4,})\s*(ms|MB)\b/g, (_m, n, u) => `${commaNum(n)} ${u}`);
  return s.replace(/\s{2,}/g, " ").trim().replace(/\.+$/, "");
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
  const width = Math.max(1, available);
  if (!ownerSuffix) return wrap(summary, width);

  const lines = wrap(summary, width);
  const last = lines[lines.length - 1];
  if (visualWidth(last) + visualWidth(ownerSuffix) <= width) {
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
