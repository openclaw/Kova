// Live-log progress emitter for kova run / kova matrix run.
//
// Append-only event stream (not redraw). Every sample emits a line so the
// log replays cleanly in CI and during long matrix runs. Each line carries
// a bracketed event prefix so logs can be grepped/filtered downstream:
//
//   [RUN]       mode opened
//   [START]     sample opened
//   [PHASE]     phase boundary inside a sample
//   [DONE]      sample closed (with verdict + elapsed)
//   [FINISH]    run closed (with status counts + elapsed)
//
// On TTY we add color + glyphs; on CI/non-TTY the same bracket prefixes
// stay so the events parse uniformly. --json / --plain / --no-progress
// silence the emitter (the receipt still prints).
//
// This file owns event formatting only; the run command owns the data.

import { makeUi } from "../ui/index.mjs";
import { createPulseFooter } from "../ui/pulse-footer.mjs";

export function createRunProgress({ flags = {}, env = process.env, stream = process.stderr, mode = "run" } = {}) {
  const silent = flags.json === true || flags.plain === true || flags.no_progress === true;
  if (silent) return NOOP;

  const ui = makeUi(flags, env, stream);
  const { c, g } = ui;
  const footer = createPulseFooter({ stream, env, flags, silent });
  const start = process.hrtime.bigint();
  const t0 = new Map();

  function elapsedMs(from) {
    return Number((process.hrtime.bigint() - from) / 1_000_000n);
  }

  function fmtDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  // Bracket prefix — Kova brand line. Always the first visible token on a
  // progress event so logs are grep-able even without color.
  function tag(label, tone = c.head) {
    return tone(`[${label}]`);
  }

  // Each event line: clear the transient pulse footer first, then write the
  // permanent event line. The footer is repainted with the new context so
  // the cursor sits on a live "still working" line between events.
  function emit(line, contextAfter) {
    footer.clear();
    stream.write(line);
    if (contextAfter !== undefined) footer.setContext(contextAfter);
    footer.paint();
  }

  return {
    runStart({ scenarioCount, mode: m, target, profile }) {
      const tag1 = tag((m ?? mode).toUpperCase());
      const parts = [];
      if (profile) parts.push(`profile ${c.bold(profile)}`);
      parts.push(`${c.bold(scenarioCount)} ${scenarioCount === 1 ? "entry" : "entries"}`);
      if (target) parts.push(`target ${c.bold(target)}`);
      footer.start("queued");
      emit(`${tag1} ${parts.join(`  ${g.sep}  `)}\n`, "queued");
    },

    scenarioStart({ scenarioId, stateId, iteration }) {
      const key = entryKey(scenarioId, stateId, iteration);
      t0.set(key, process.hrtime.bigint());
      const iter = iteration && iteration.total > 1 ? c.dim(` [${iteration.index}/${iteration.total}]`) : "";
      const ctx = `${scenarioId} ${g.sep} ${stateId}${iteration && iteration.total > 1 ? ` [${iteration.index}/${iteration.total}]` : ""}`;
      emit(`${tag("START", c.head)}  ${c.bold(scenarioId)}${c.dim(` ${g.sep} ${stateId}`)}${iter}\n`, ctx);
    },

    phase({ title, scenarioId, stateId }) {
      if (!title) return;
      const scope = [scenarioId, stateId].filter(Boolean).join("/");
      const where = scope ? c.dim(`  ${g.sep} ${scope}`) : "";
      const ctx = scope ? `${scope} ${g.sep} ${title}` : title;
      emit(`${tag("PHASE", c.dim)}  ${c.dim(title)}${where}\n`, ctx);
    },

    scenarioEnd({ scenarioId, stateId, iteration, status, skipReason }) {
      const key = entryKey(scenarioId, stateId, iteration);
      const dur = t0.has(key) ? fmtDuration(elapsedMs(t0.get(key))) : "—";
      t0.delete(key);
      const iter = iteration && iteration.total > 1 ? c.dim(` [${iteration.index}/${iteration.total}]`) : "";
      const { label, tone } = classify(status, skipReason, c);
      const tail = skipReason ? c.dim(`  ${g.sep} ${skipReason}`) : c.dim(`  ${g.sep} ${dur}`);
      emit(`${tag("DONE", tone)}   ${c.bold(scenarioId)}${c.dim(` ${g.sep} ${stateId}`)}${iter}  ${label}${tail}\n`, "waiting for next entry");
    },

    runFinish({ total, statuses }) {
      const dur = fmtDuration(elapsedMs(start));
      const fail = (statuses?.FAIL ?? 0) > 0;
      const blocked = (statuses?.BLOCKED ?? 0) > 0;
      const incomplete = (statuses?.INCOMPLETE ?? 0) > 0;
      const tone = fail ? c.err : blocked || incomplete ? c.warn : c.ok;
      const counts = formatCounts(statuses, c);
      footer.stop();
      stream.write(`${tag("FINISH", tone)} ${c.dim(`${total} ${total === 1 ? "entry" : "entries"} in ${dur}`)}${counts ? c.dim(`  ${g.sep}  `) + counts : ""}\n`);
    },
  };
}

function classify(status, skipReason, c) {
  if (skipReason) return { label: c.dim("SKIP"), tone: c.dim };
  switch (String(status ?? "").toUpperCase()) {
    case "PASS":    return { label: c.ok("PASS"),     tone: c.ok };
    case "FAIL":    return { label: c.err("FAIL"),    tone: c.err };
    case "BLOCKED": return { label: c.warn("BLOCKED"),tone: c.warn };
    case "DRY-RUN": return { label: c.dim("DRY-RUN"), tone: c.head };
    case "SKIP":    return { label: c.dim("SKIP"),    tone: c.dim };
    default:        return { label: c.dim(String(status ?? "?")), tone: c.dim };
  }
}

function formatCounts(statuses, c) {
  if (!statuses) return "";
  const parts = [];
  for (const [k, v] of Object.entries(statuses)) {
    if (!v) continue;
    const color = k === "FAIL" ? c.err : k === "PASS" ? c.ok : k === "BLOCKED" ? c.warn : c.dim;
    parts.push(color(`${k}=${v}`));
  }
  return parts.join(c.dim("  "));
}

function entryKey(scenarioId, stateId, iteration) {
  const ix = iteration ? `${iteration.index}/${iteration.total}` : "1";
  return `${scenarioId}::${stateId}::${ix}`;
}

const NOOP = {
  runStart() {},
  scenarioStart() {},
  phase() {},
  scenarioEnd() {},
  runFinish() {},
};
