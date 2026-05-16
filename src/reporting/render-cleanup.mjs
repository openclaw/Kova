// TTY receipts for `kova cleanup envs` and `kova cleanup artifacts`.

import {
  makeUi, ruleSection, renderKovaHeader, kpiStrip,
  renderTable, repeat, withMargin,
} from "../ui/index.mjs";

export function renderCleanupEnvs({ envs, results, execute }, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  const verdict = deriveEnvsVerdict({ envs, results, execute });
  sections.push(renderKovaHeader({
    surface: "cleanup envs",
    verdict: verdict.label,
    headline: buildEnvsHeadline({ envs, results, execute }),
    meta: execute ? "mode: execute" : "mode: dry-run",
    ui,
  }));
  sections.push("");
  sections.push(renderEnvsKpi({ envs, results, execute }, ui));

  if (envs.length > 0) {
    sections.push("");
    sections.push(renderEnvsTable({ envs, results, execute }, ui));
  }

  sections.push("");
  sections.push(renderHint(execute, envs.length === 0 ? "no-envs" : "envs", ui, { kind: "envs" }));
  return withMargin(sections.join("\n"), ui.leftPad);
}

export function renderCleanupArtifacts({ candidates, results, execute, artifactsDir, olderThanDays }, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  const verdict = deriveArtifactsVerdict({ candidates, results, execute });
  sections.push(renderKovaHeader({
    surface: "cleanup artifacts",
    verdict: verdict.label,
    headline: buildArtifactsHeadline({ candidates, results, execute }),
    meta: `older-than: ${olderThanDays}d ${ui.g.sep} mode: ${execute ? "execute" : "dry-run"}`,
    ui,
  }));
  sections.push("");
  sections.push(renderArtifactsKpi({ candidates, results, execute }, ui));

  if (candidates.length > 0) {
    sections.push("");
    sections.push(renderArtifactsTable({ candidates, results, execute }, ui));
  }

  sections.push("");
  sections.push(renderHint(execute, candidates.length === 0 ? "none" : "candidates", ui, { kind: "artifacts", olderThanDays, artifactsDir }));
  return withMargin(sections.join("\n"), ui.leftPad);
}

function deriveEnvsVerdict({ envs, results, execute }) {
  if (!execute) {
    if (envs.length === 0) return { label: "CLEAN", tone: "PASS", status: "NOTHING-TO-DO" };
    return { label: "DRY-RUN", tone: "INCOMPLETE", status: "PLANNED" };
  }
  const failed = results.filter((r) => r.status !== 0).length;
  if (failed > 0) return { label: "PARTIAL", tone: "FAIL", status: "FAILED" };
  return { label: "CLEANED", tone: "PASS", status: "DONE" };
}

function deriveArtifactsVerdict({ candidates, results, execute }) {
  if (!execute) {
    if (candidates.length === 0) return { label: "CLEAN", tone: "PASS", status: "NOTHING-TO-DO" };
    return { label: "DRY-RUN", tone: "INCOMPLETE", status: "PLANNED" };
  }
  const failed = results.filter((r) => r.status !== 0).length;
  if (failed > 0) return { label: "PARTIAL", tone: "FAIL", status: "FAILED" };
  return { label: "CLEANED", tone: "PASS", status: "DONE" };
}

function buildEnvsHeadline({ envs, results, execute }) {
  if (!execute) return envs.length === 0 ? "nothing to do" : `${envs.length} would be removed`;
  const removed = results.filter((r) => r.status === 0).length;
  const failed = results.filter((r) => r.status !== 0).length;
  if (failed > 0) return `${removed} removed · ${failed} failed`;
  return `${removed} removed`;
}

function buildArtifactsHeadline({ candidates, results, execute }) {
  if (!execute) return candidates.length === 0 ? "nothing to do" : `${candidates.length} would be removed`;
  const removed = results.filter((r) => r.status === 0).length;
  const failed = results.filter((r) => r.status !== 0).length;
  if (failed > 0) return `${removed} removed · ${failed} failed`;
  return `${removed} removed`;
}

function renderEnvsKpi({ envs, results, execute }, ui) {
  const removed = execute ? results.filter((r) => r.status === 0).length : 0;
  const failed = execute ? results.filter((r) => r.status !== 0).length : 0;
  return kpiStrip([
    { label: "Stale envs", value: String(envs.length), hint: "matched", tone: "neutral" },
    {
      label: execute ? "Removed" : "Would remove",
      value: execute ? String(removed) : String(envs.length),
      hint: execute ? "destroyed" : "with --execute",
      tone: execute ? (removed > 0 ? "ok" : "dim") : "neutral",
    },
    { label: "Failed", value: String(failed), hint: failed > 0 ? "review below" : null, tone: failed > 0 ? "err" : "dim" },
  ], ui);
}

function renderArtifactsKpi({ candidates, results, execute }, ui) {
  const removed = execute ? results.filter((r) => r.status === 0).length : 0;
  const failed = execute ? results.filter((r) => r.status !== 0).length : 0;
  return kpiStrip([
    { label: "Candidates", value: String(candidates.length), hint: "matched", tone: "neutral" },
    {
      label: execute ? "Removed" : "Would remove",
      value: execute ? String(removed) : String(candidates.length),
      hint: execute ? "deleted" : "with --execute",
      tone: execute ? (removed > 0 ? "ok" : "dim") : "neutral",
    },
    { label: "Failed", value: String(failed), hint: failed > 0 ? "review below" : null, tone: failed > 0 ? "err" : "dim" },
  ], ui);
}

function renderEnvsTable({ envs, results, execute }, ui) {
  const { c, g } = ui;
  const lines = [ruleSection("envs", ui.width, ui)];
  const byEnv = new Map(results.map((r) => [extractEnvFromCommand(r.command), r]));
  const rows = envs.map((env) => {
    const result = byEnv.get(env);
    let status;
    if (!execute) status = c.dim("DRY-RUN");
    else if (!result) status = c.dim("SKIP");
    else if (result.status === 0) status = c.ok("REMOVED");
    else status = c.err("FAILED");
    const note = result?.timedOut ? c.warn("timed out") : (result?.durationMs != null ? c.dim(`${result.durationMs}ms`) : c.dim("—"));
    return { status, env: c.bold(env), note };
  });
  lines.push(indentBlock(renderTable({
    columns: [
      { key: "status", header: c.dim("status"), align: "left", minWidth: 8 },
      { key: "env",    header: c.dim("env"),    align: "left", minWidth: 24 },
      { key: "note",   header: c.dim("detail"), align: "left", minWidth: 10 },
    ],
    rows, gap: 2,
  }), 2));
  return lines.join("\n");
}

function renderArtifactsTable({ candidates, results, execute }, ui) {
  const { c } = ui;
  const lines = [ruleSection("artifacts", ui.width, ui)];
  const byPath = new Map(results.map((r) => [r.path, r]));
  const rows = candidates.map((cand) => {
    const result = byPath.get(cand.path);
    let status;
    if (!execute) status = c.dim("DRY-RUN");
    else if (!result) status = c.dim("SKIP");
    else if (result.status === 0) status = c.ok("REMOVED");
    else status = c.err("FAILED");
    const note = result?.error ? c.err(result.error) : c.dim(`${cand.ageDays}d old`);
    return { status, name: c.bold(cand.name), note };
  });
  lines.push(indentBlock(renderTable({
    columns: [
      { key: "status", header: c.dim("status"), align: "left", minWidth: 8 },
      { key: "name",   header: c.dim("artifact dir"), align: "left", minWidth: 32 },
      { key: "note",   header: c.dim("detail"), align: "left", minWidth: 10 },
    ],
    rows, gap: 2,
  }), 2));
  return lines.join("\n");
}

function renderHint(execute, kind, ui, ctx = {}) {
  const { c, g } = ui;
  const lines = [ruleSection("next", ui.width, ui)];
  if (kind === "no-envs") {
    lines.push(`  ${c.ok(g.check)} ${c.dim("No stale Kova envs found.")}`);
  } else if (kind === "none") {
    lines.push(`  ${c.ok(g.check)} ${c.dim(`No Kova run artifact dirs older than ${ctx.olderThanDays}d under ${ctx.artifactsDir}.`)}`);
  } else if (!execute) {
    const target = ctx.kind === "envs" ? "destroy the envs above" : "remove the dirs above";
    lines.push(`  ${c.head(g.arrow)} ${c.dim(`Re-run with --execute to ${target}.`)}`);
  } else {
    lines.push(`  ${c.ok(g.check)} ${c.dim("Done.")}`);
  }
  return lines.join("\n");
}

function extractEnvFromCommand(command) {
  // ocmEnvDestroy quotes the env name with single quotes; pull the first quoted token.
  const match = /'([^']+)'/.exec(command ?? "");
  return match ? match[1] : (command ?? "");
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
