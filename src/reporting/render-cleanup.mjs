// TTY receipts for `kova cleanup envs` and `kova cleanup artifacts`.

import {
  makeUi, heavyBand, ruleSection, card, sideBySide,
  badge, renderTable, repeat,
} from "../ui/index.mjs";

const TARGET_WIDTH_FOR_DASHBOARD = 100;

export function renderCleanupEnvs({ envs, results, execute }, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  const verdict = deriveEnvsVerdict({ envs, results, execute });
  sections.push(heavyBand({
    badgeText: badge(verdict.label, verdict.tone, ui),
    status: verdict.status,
    title: "KOVA CLEANUP ENVS",
    meta: execute ? "mode: execute" : "mode: dry-run",
    width: ui.width,
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
  return sections.join("\n");
}

export function renderCleanupArtifacts({ candidates, results, execute, artifactsDir, olderThanDays }, flags = {}, env = process.env, stream = process.stdout) {
  const ui = makeUi(flags, env, stream);
  const sections = [];
  const verdict = deriveArtifactsVerdict({ candidates, results, execute });
  sections.push(heavyBand({
    badgeText: badge(verdict.label, verdict.tone, ui),
    status: verdict.status,
    title: "KOVA CLEANUP ARTIFACTS",
    meta: `older-than: ${olderThanDays}d  ${ui.g.sep}  mode: ${execute ? "execute" : "dry-run"}`,
    width: ui.width,
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
  return sections.join("\n");
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

function renderEnvsKpi({ envs, results, execute }, ui) {
  const { c } = ui;
  const removed = execute ? results.filter((r) => r.status === 0).length : 0;
  const failed = execute ? results.filter((r) => r.status !== 0).length : 0;
  const cardWidth = computeCardWidth(ui, 3);

  return sideBySide([
    card({ title: "Stale envs", width: cardWidth, ui,
      lines: [c.bold(String(envs.length)), c.dim("matched")] }),
    card({ title: execute ? "Removed" : "Would remove", width: cardWidth, ui,
      lines: [execute ? (removed > 0 ? c.ok(c.bold(String(removed))) : c.dim("0")) : c.bold(String(envs.length)),
              c.dim(execute ? "destroyed" : "with --execute")] }),
    card({ title: "Failed", width: cardWidth, ui,
      lines: [failed > 0 ? c.err(c.bold(String(failed))) : c.dim("0"), c.dim(failed === 0 ? "—" : "review below")] }),
  ], { width: ui.width, gap: 2, minWidth: TARGET_WIDTH_FOR_DASHBOARD });
}

function renderArtifactsKpi({ candidates, results, execute }, ui) {
  const { c } = ui;
  const removed = execute ? results.filter((r) => r.status === 0).length : 0;
  const failed = execute ? results.filter((r) => r.status !== 0).length : 0;
  const cardWidth = computeCardWidth(ui, 3);

  return sideBySide([
    card({ title: "Candidates", width: cardWidth, ui,
      lines: [c.bold(String(candidates.length)), c.dim("matched")] }),
    card({ title: execute ? "Removed" : "Would remove", width: cardWidth, ui,
      lines: [execute ? (removed > 0 ? c.ok(c.bold(String(removed))) : c.dim("0")) : c.bold(String(candidates.length)),
              c.dim(execute ? "deleted" : "with --execute")] }),
    card({ title: "Failed", width: cardWidth, ui,
      lines: [failed > 0 ? c.err(c.bold(String(failed))) : c.dim("0"), c.dim(failed === 0 ? "—" : "review below")] }),
  ], { width: ui.width, gap: 2, minWidth: TARGET_WIDTH_FOR_DASHBOARD });
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

function computeCardWidth(ui, n) {
  const stack = ui.width < TARGET_WIDTH_FOR_DASHBOARD;
  return stack ? Math.max(20, ui.width) : Math.max(20, Math.floor((ui.width - (n - 1) * 2) / n));
}

function indentBlock(text, n) {
  const pad = repeat(" ", n);
  return String(text).split("\n").map((line) => pad + line).join("\n");
}
