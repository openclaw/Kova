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
}

export interface ScenarioHistory {
  id: string;
  unit: string;
  lowerIsBetter: boolean;
  points: TrendPoint[];
}

/**
 * Build per-scenario history. Releases without `scenarios[]` (history stubs)
 * contribute nothing. Mismatched (unit, lowerIsBetter) across versions are
 * split into separate compatibility buckets.
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
        bucket = { id: s.id, unit: s.unit, lowerIsBetter: lib, points: [] };
        byKey.set(key, bucket);
      }
      bucket.points.push({
        ver: r.ver,
        releaseDate: r.releaseDate,
        value: s.value,
        state: s.state,
        threshold: s.threshold,
      });
    }
  }
  return byKey;
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
