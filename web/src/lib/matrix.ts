/**
 * Matrix view aggregator: combines per-scenario history with per-release
 * headline metrics for the `/matrix` page.
 *
 * The matrix is rendered in three views (Table, Heatmap, Cards) — all of
 * which share the same data shape produced here so they cannot drift.
 *
 * Honest data only: where a release has no `scenarios[]`, the matrix cell
 * is `null` (rendered as "not measured"), not faked.
 */

import { allReleases } from "./releases";
import { scenarioHistories, type ScenarioHistory, type TrendPoint } from "./scenarios";
import type { Release, Scenario } from "../content.config";

export interface MatrixRelease {
  ver: string;
  date: string;
  sha: string;
  releaseDate: Date;
  passed: boolean;
  /** Counts derived from release.scenarios[]; zero when release is a stub. */
  counts: { pass: number; fail: number; block: number; total: number };
}

export interface MatrixCell {
  value: number | null;
  state: Scenario["state"] | null;
  threshold: number;
  /** Δ% vs the previous chronological column for the same scenario. */
  deltaPct: number | null;
  /** True when the release ran the scenario but produced no sample. */
  blocked: boolean;
}

export interface MatrixRow {
  id: string;
  unit: string;
  lowerIsBetter: boolean;
  threshold: number;
  /** Cells aligned to `releases[]` (oldest → newest). */
  cells: MatrixCell[];
  /** Total breaches (state==="fail") across all measured cells. */
  breaches: number;
  /** Total blocked cells. */
  blocks: number;
  /** Most recent non-null point — used for cards headline. */
  latest: TrendPoint | null;
}

export interface HeadlineColumn {
  startup: { value: number | null; breach: boolean } | null;
  turn:    { value: number | null; breach: boolean } | null;
  pre:     { value: number | null; breach: boolean } | null;
  gw:      { value: number | null; breach: boolean } | null;
}

export interface MatrixData {
  releases: MatrixRelease[];
  rows: MatrixRow[];
  /** Per-release headline values (one per release, aligned to `releases[]`). */
  headlines: HeadlineColumn[];
}

const COLD_ID = "release-runtime-startup";
const GW_ID = "gateway-performance";
const TURN_ID = "gateway-session-send-turn";

function rowFromHistory(h: ScenarioHistory, releases: MatrixRelease[]): MatrixRow {
  const byVer = new Map(h.points.map((p) => [p.ver, p] as const));
  const cells: MatrixCell[] = [];
  let breaches = 0;
  let blocks = 0;
  let lastSeenValue: number | null = null;
  let latest: TrendPoint | null = null;

  for (const rel of releases) {
    const p = byVer.get(rel.ver);
    if (!p) {
      cells.push({ value: null, state: null, threshold: 0, deltaPct: null, blocked: false });
      continue;
    }
    if (p.value != null) latest = p;
    let deltaPct: number | null = null;
    if (p.value != null && lastSeenValue != null && lastSeenValue !== 0) {
      deltaPct = ((p.value - lastSeenValue) / lastSeenValue) * 100;
    }
    cells.push({
      value: p.value,
      state: p.state,
      threshold: p.threshold,
      deltaPct,
      blocked: p.value == null,
    });
    if (p.state === "fail") breaches++;
    if (p.value == null) blocks++;
    if (p.value != null) lastSeenValue = p.value;
  }

  return {
    id: h.id,
    unit: h.unit,
    lowerIsBetter: h.lowerIsBetter,
    threshold: h.points[h.points.length - 1]?.threshold ?? 0,
    cells,
    breaches,
    blocks,
    latest,
  };
}

export async function matrixData(): Promise<MatrixData> {
  const releasesDesc = await allReleases(); // newest first
  // We render oldest → newest so deltas read forward in time.
  const releasesAsc = [...releasesDesc].reverse();

  const matrixReleases: MatrixRelease[] = releasesAsc.map((r) => {
    let pass = 0, fail = 0, block = 0;
    for (const s of r.scenarios ?? []) {
      if (s.state === "pass") pass++;
      else if (s.state === "fail") fail++;
      else block++;
    }
    return {
      ver: r.ver,
      date: r.date,
      sha: r.sha,
      releaseDate: r.releaseDate,
      passed: r.passed,
      counts: { pass, fail, block, total: (r.scenarios ?? []).length },
    };
  });

  const histories = await scenarioHistories();
  const rows = [...histories.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((h) => rowFromHistory(h, matrixReleases));

  // Headlines per release: startup and agent turn are the public story.
  // Gateway p95 stays as a responsiveness guardrail; RSS remains detail-only.
  const headlines: HeadlineColumn[] = releasesAsc.map((r) => {
    const scenarios = r.scenarios ?? [];
    const startup = headlineMetric(r, ["startup.s", "cold.ready.s"]) ?? scenarioMetric(scenarios.find((s) => s.id === COLD_ID), "s");
    const turn = headlineMetric(r, ["agent.turn.s"]) ?? scenarioMetric(scenarios.find((s) => s.id === TURN_ID), "s");
    const pre = headlineMetric(r, ["agent.pre_provider.s"]);
    const gw = headlineMetric(r, ["health.p95.ms"]) ?? scenarioMetric(scenarios.find((s) => s.id === GW_ID), "ms");
    return {
      startup,
      turn,
      pre,
      gw,
    };
  });

  return { releases: matrixReleases, rows, headlines };
}

function headlineMetric(r: Release, metrics: string[]): { value: number | null; breach: boolean } | null {
  const hit = r.headline?.find((h) => metrics.includes(h.metric ?? ""));
  if (!hit) return null;
  return { value: hit.value, breach: false };
}

function scenarioMetric(s: Scenario | undefined, unit: "s" | "ms"): { value: number | null; breach: boolean } | null {
  if (!s) return null;
  const divisor = unit === "s" && s.unit === "ms" ? 1000 : 1;
  return {
    value: s.value == null ? null : s.value / divisor,
    breach: s.state === "fail",
  };
}

/** Returns Δ% between two consecutive non-null values in a sequence. */
export function pctDelta(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}
