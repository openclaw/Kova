// TTY for `kova self-check`: live per-check stream + final receipt.

import {
  makeUi, ruleSection, renderKovaHeader, kpiStrip,
  renderTable, repeat, withMargin,
} from "../ui/index.mjs";

export function createSelfCheckProgress({ flags = {}, env = process.env, stream = process.stderr } = {}) {
  const silent = flags.json === true || flags.plain === true || flags.no_progress === true;
  if (silent) return { runStart() {}, checkDone() {}, runFinish() {} };
  const ui = makeUi(flags, env, stream);
  const { c, g } = ui;
  const start = process.hrtime.bigint();
  let count = 0;

  return {
    runStart() {
      stream.write(`${c.head("[SELF-CHECK]")} ${c.dim("running")}\n`);
    },
    checkDone(check) {
      count += 1;
      const status = String(check.status ?? "?").toUpperCase();
      const glyph = status === "PASS" ? c.ok(g.check)
                  : status === "FAIL" ? c.err(g.cross)
                  : status === "WARN" ? c.warn(g.warn)
                  : c.dim(g.bullet);
      const label = status === "PASS" ? c.ok("PASS")
                  : status === "FAIL" ? c.err("FAIL")
                  : status === "WARN" ? c.warn("WARN")
                  : c.dim(status);
      stream.write(`  ${glyph} ${label}  ${c.bold(check.id ?? "?")}${check.message ? c.dim(`  ${g.sep} ${truncate1Line(check.message)}`) : ""}\n`);
    },
    runFinish({ ok, total }) {
      const dur = fmtDuration(elapsedMs(start));
      const tag = ok ? c.ok("OK") : c.err("FAIL");
      stream.write(`${c.head(g.arrow)} ${c.dim(`finished ${total ?? count} ${(total ?? count) === 1 ? "check" : "checks"} in ${dur}`)}  ${tag}\n`);
    },
  };
}

export function renderSelfCheckReceipt(result, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  const verdict = deriveVerdict(result);

  const checks = result.checks ?? [];
  const pass = checks.filter((cc) => cc.status === "PASS").length;
  const fail = checks.filter((cc) => cc.status === "FAIL").length;

  sections.push(renderKovaHeader({
    surface: "self-check",
    verdict: verdict.label,
    headline: result.ok
      ? `${pass}/${checks.length} passed`
      : `${fail} failed ${ui.g.sep} ${pass}/${checks.length} passed`,
    meta: `generated: ${formatTimestamp(result.generatedAt)}`,
    ui,
  }));
  sections.push("");
  sections.push(renderKpi(result, ui));

  const failed = (result.checks ?? []).filter((c) => c.status === "FAIL");
  if (failed.length > 0) {
    sections.push("");
    sections.push(renderFailures(failed, ui));
  }

  sections.push("");
  sections.push(renderFooter(result, ui));
  return withMargin(sections.join("\n"), ui.leftPad);
}

function deriveVerdict(result) {
  if (result.ok) return { label: "GREEN", tone: "PASS", status: "PASS" };
  return { label: "RED", tone: "FAIL", status: "FAIL" };
}

function renderKpi(result, ui) {
  const checks = result.checks ?? [];
  const pass = checks.filter((c) => c.status === "PASS").length;
  const fail = checks.filter((c) => c.status === "FAIL").length;
  const other = checks.length - pass - fail;
  return kpiStrip([
    { label: "Total",  value: String(checks.length), hint: "checks", tone: "neutral" },
    { label: "Passed", value: String(pass), hint: `of ${checks.length}`, tone: pass > 0 ? "ok" : "dim", bar: { filled: pass, total: checks.length } },
    { label: "Failed", value: String(fail), hint: other > 0 ? `+${other} other` : null, tone: fail > 0 ? "err" : "dim", bar: { filled: fail, total: checks.length } },
  ], ui);
}

function renderFailures(failed, ui) {
  const { c } = ui;
  const lines = [ruleSection("failures", ui.width, ui)];
  const rows = failed.map((check) => ({
    status: c.err("FAIL"),
    id: c.bold(check.id ?? "?"),
    detail: c.dim(check.message ?? ""),
  }));
  lines.push(indentBlock(renderTable({
    columns: [
      { key: "status", header: c.dim("status"), align: "left", minWidth: 5 },
      { key: "id",     header: c.dim("check"),  align: "left", minWidth: 22 },
      { key: "detail", header: c.dim("detail"), align: "left", minWidth: 24 },
    ],
    rows, gap: 2,
  }), 2));
  return lines.join("\n");
}

function renderFooter(result, ui) {
  const { c, g } = ui;
  const lines = [ruleSection("next", ui.width, ui)];
  if (result.ok) {
    lines.push(`  ${c.ok(g.check)} ${c.dim("All checks passed. Kova is ready to run.")}`);
    lines.push(`  ${c.head(g.arrow)} ${c.dim("kova plan --json")}`);
    lines.push(`  ${c.head(g.arrow)} ${c.dim("kova matrix run --profile smoke --target runtime:stable --execute")}`);
  } else {
    lines.push(`  ${c.err(g.cross)} ${c.dim("One or more checks failed. Inspect the failures panel above.")}`);
    lines.push(`  ${c.head(g.arrow)} ${c.dim("kova self-check --json | jq '.checks[] | select(.status==\"FAIL\")'")}`);
  }
  return lines.join("\n");
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function elapsedMs(from) { return Number((process.hrtime.bigint() - from) / 1_000_000n); }
function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso ?? "—";
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch { return iso ?? "—"; }
}
function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
function truncate1Line(s) {
  const oneLine = String(s).split("\n")[0];
  return oneLine.length > 80 ? oneLine.slice(0, 79) + "…" : oneLine;
}
