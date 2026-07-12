// Scenarios roll-up. The top-level table that lists every scenario in
// the run with its verdict, sample count, and worst-metric headline.
//
// Single-run shape:
//
//   Scenarios                samples  verdict   worst metric
//     fresh-install          5/5      PASS      agent.turn.ms within budget
//     agent-cold-warm        5/5      FAIL      agent.turn.ms over by 240 ms
//
// Matrix shape adds a target column:
//
//   Scenarios                target   samples  verdict   worst metric
//     fresh-install          stable   5/5      PASS      —
//     fresh-install          canary   5/5      FAIL      health.startup over by 1.1 s
//
import { renderTable } from "./tables.mjs";
import { badge } from "./badges.mjs";
import { visualWidth, truncate } from "./text.mjs";
import { METRIC_LABELS } from "../reporting/scenario-aggregate.mjs";

// scenariosRollup({ rows, matrix, ui }) -> string
//
//   rows (single-run):
//     [{ id, passed, total, verdict, worst, delta }]
//   rows (matrix):
//     [{ id, target, passed, total, verdict, worst, delta }]
//   delta is an optional pre-formatted string for compare mode (e.g. "+12%").
export function scenariosRollup({ rows, matrix = false, compare = false, ui } = {}) {
  if (!rows || rows.length === 0) return "";
  const c = ui.c;
  const termWidth = ui?.width ?? 100;

  const shaped = rows.map((r) => {
    const passed = r.passed ?? 0;
    const total = r.total ?? passed;
    const worst = formatWorstCell(r.worst, c, termWidth);
    return {
      id:      c.bold(r.id),
      target:  r.target ? c.dim(r.target) : "—",
      samples: total > 0 ? `${passed}/${total}` : "—",
      verdict: r.verdict ? badge(r.verdict, r.verdict, ui) : c.dim("—"),
      worst:   worst.cell,
      delta:   r.delta ? colorDelta(r.delta, c) : c.dim("—"),
      __after: worst.after,
    };
  });

  const cols = [
    { key: "id",      header: c.dim("scenario"), align: "left",  minWidth: 20 },
  ];
  if (matrix) cols.push({ key: "target", header: c.dim("target"), align: "left", minWidth: 8 });
  cols.push(
    { key: "samples", header: c.dim("samples"), align: "right", minWidth: 7 },
    { key: "verdict", header: c.dim("verdict"), align: "left",  minWidth: 9 },
  );
  if (compare) cols.push({ key: "delta", header: c.dim("Δ"), align: "right", minWidth: 7 });
  cols.push({ key: "worst", header: c.dim("worst metric"), align: "left", minWidth: 0 });

  return renderTable({ columns: cols, rows: shaped, gap: 2, maxWidth: termWidth });
}

// Worst-metric cell + optional continuation line.
//
// Inline when the note is compact (threshold form "value > cap"). When the
// note is prose, keep just the metric label in the cell and emit the full
// reason on a dim continuation line below the row. This keeps the table
// one-row-per-scenario and screenshot-friendly while never losing detail.
function formatWorstCell(worst, c, termWidth) {
  if (!worst) return { cell: c.dim("—"), after: null };
  if (typeof worst === "string") return { cell: worst, after: null };

  const { label: rawLabel, note, tone } = worst;
  const label = shortenMetricLabel(rawLabel);
  const color = tone === "err" ? c.err
    : tone === "warn" ? c.warn
    : tone === "ok" ? c.ok
    : c.dim;

  if (!note) return { cell: color(label), after: null };

  // Threshold form: "988.8MB > 900MB" / "97% > 80%" — always inline.
  if (isCompactThreshold(note)) {
    return { cell: color(`${label} ${note}`), after: null };
  }

  // Prose note: label in cell, full reason on continuation line.
  const indent = "    ↳ ";
  const budget = Math.max(1, termWidth - visualWidth(indent));
  const fit = visualWidth(note) > budget ? truncate(note, budget) : note;
  return { cell: color(label), after: c.dim(indent + fit) };
}

function isCompactThreshold(note) {
  // Matches "<num><unit?> <op> <num><unit?>" e.g. "988.8MB > 900MB", "97% > 80%".
  return /^[\d.,+\-]+\S* (?:>|<|≥|≤|>=|<=) [\d.,+\-]+\S*$/.test(note);
}

// Strip the verbose `resourceByRole.<role>.<metric>` path down to
// "<role> <metric.label>". The continuation line below the row still
// carries the threshold detail, but the cell now identifies both the
// scope (role) and the metric kind without the noisy field-path prefix.
function shortenMetricLabel(label) {
  if (typeof label !== "string") return label;
  const m = label.match(/^resourceByRole\.([^.]+)\.([^.]+)$/);
  if (!m) return label;
  const [, role, metricKey] = m;
  const friendly = METRIC_LABELS[metricKey] ?? metricKey;
  return `${role} ${friendly}`;
}

function colorDelta(text, c) {
  // Caller passes pre-formatted text. We just color based on leading sign.
  if (text.startsWith("+")) return c.neg(text);
  if (text.startsWith("-") || text.startsWith("−")) return c.pos(text);
  return c.dim(text);
}
