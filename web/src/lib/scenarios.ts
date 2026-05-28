/**
 * Aggregations for cross-release queries: per-scenario history,
 * compatible-pair filtering, and comparison route generation.
 *
 * Compatibility key = `(scenario.id, unit, lowerIsBetter)`. If any of those
 * change for a given scenario id across releases, we split into separate
 * series so deltas can't lie.
 */

import { allReleases } from "./releases";
import type { Release, Scenario } from "../content.config";

export interface TrendPoint {
  ver: string;
  releaseDate: Date;
  /** null when the release ran the scenario but produced no sample (blocked). */
  value: number | null;
  state: Scenario["state"];
  threshold: number;
  metric?: string;
}

export interface ScenarioHistory {
  id: string;
  metric?: string;
  unit: string;
  lowerIsBetter: boolean;
  points: TrendPoint[];
}

/**
 * Build per-scenario history. Releases without `scenarios[]` (history stubs)
 * contribute nothing. Mismatched (unit, lowerIsBetter) across versions are
 * split into compatibility buckets first so trend math never crosses units.
 * The public route is `/scenarios/<id>`, so when an id has multiple buckets we
 * expose the bucket with the newest datapoint as the canonical scenario page.
 */
export async function scenarioHistories(): Promise<Map<string, ScenarioHistory>> {
  const releases = await allReleases();
  const byKey = new Map<string, ScenarioHistory>();

  // Iterate oldest → newest so points are chronological.
  for (const r of [...releases].reverse()) {
    if (!r.scenarios) continue;
    for (const s of r.scenarios) {
      const lib = s.lowerIsBetter !== false;
      const key = `${s.id}::${s.unit}::${lib ? "low" : "high"}`;
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = { id: s.id, metric: s.metric, unit: s.unit, lowerIsBetter: lib, points: [] };
        byKey.set(key, bucket);
      }
      bucket.metric = s.metric ?? bucket.metric;
      bucket.points.push({
        ver: r.ver,
        releaseDate: r.releaseDate,
        value: s.value,
        state: s.state,
        threshold: s.threshold,
        metric: s.metric,
      });
    }
  }
  return canonicalByScenarioId(byKey);
}

function canonicalByScenarioId(histories: Map<string, ScenarioHistory>): Map<string, ScenarioHistory> {
  const byId = new Map<string, ScenarioHistory>();
  for (const history of histories.values()) {
    const current = byId.get(history.id);
    if (!current || latestPointTime(history) > latestPointTime(current)) {
      byId.set(history.id, history);
    }
  }
  return byId;
}

function latestPointTime(history: ScenarioHistory): number {
  const latest = history.points[history.points.length - 1];
  return latest ? latest.releaseDate.getTime() : -Infinity;
}

/**
 * Releases (newer) that ship a precomputed `comparison` block. Used as the
 * authoritative list for `/releases/[a]/vs/[b]` route generation. Linear in
 * number of releases — no N² blow-up.
 */
export async function comparisonPairs(): Promise<
  Array<{ a: Release & { id: string }; b: Release & { id: string } | null; vsVer: string }>
> {
  const all = await allReleases();
  const byVer = new Map(all.map((r) => [r.ver, r] as const));
  const pairs: Array<{ a: Release & { id: string }; b: Release & { id: string } | null; vsVer: string }> = [];
  for (const a of all) {
    if (!a.comparison) continue;
    pairs.push({ a, b: byVer.get(a.comparison.vsVer) ?? null, vsVer: a.comparison.vsVer });
  }
  return pairs;
}
