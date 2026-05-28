/**
 * Aggregations over the `releases` content collection. Centralized so pages
 * don't repeat sort/filter logic.
 *
 * Stable vs beta: public "latest" surfaces operate on stable releases only.
 * The releases list page surfaces betas in a dedicated grouped view. See
 * `release-flavor.ts` for the version-parsing helpers.
 */

import { getCollection } from "astro:content";
import type { Release, Scenario } from "../content.config";
import { isStable, isPreRelease } from "./release-flavor";

export async function allReleases(): Promise<Array<Release & { id: string }>> {
  const entries = await getCollection("releases");
  return entries
    .map((e) => ({ id: e.id, ...e.data }))
    .sort((a, b) => {
      const byDate = b.releaseDate.getTime() - a.releaseDate.getTime();
      if (byDate !== 0) return byDate;
      return b.ver.localeCompare(a.ver, undefined, { numeric: true, sensitivity: "base" });
    });
}

/** Stable releases only, newest first. */
export async function stableReleases(): Promise<Array<Release & { id: string }>> {
  return (await allReleases()).filter((r) => isStable(r.ver));
}

/** Pre-release (beta/rc/alpha) builds only, newest first. */
export async function betaReleases(): Promise<Array<Release & { id: string }>> {
  return (await allReleases()).filter((r) => isPreRelease(r.ver));
}

/**
 * Newest release with populated scenarios. Used by pages that need any
 * release record (e.g. the [version] detail page's "compare to current
 * latest"). Includes betas so a beta page can still reference itself.
 */
export async function latestRelease(): Promise<Release & { id: string }> {
  const all = await allReleases();
  const withScenarios = all.find((r) => r.scenarios && r.scenarios.length > 0);
  if (!withScenarios) {
    throw new Error("No release in src/content/releases has scenarios populated");
  }
  return withScenarios;
}

/**
 * Newest stable release, even if it is a history stub without detailed
 * scenarios. This is the only helper /latest should use; pre-releases must
 * not become the canonical latest target because stable data is incomplete.
 */
export async function latestStableRelease(): Promise<Release & { id: string }> {
  const stable = await stableReleases();
  const latest = stable[0];
  if (!latest) {
    throw new Error("No stable release found in web/src/content/releases");
  }
  return latest;
}

export function scenarioCounts(scenarios: Scenario[]) {
  let pass = 0, fail = 0, block = 0;
  for (const s of scenarios) {
    if (s.state === "pass") pass++;
    else if (s.state === "fail") fail++;
    else block++;
  }
  return { pass, fail, block, total: scenarios.length };
}

export function scenarioSampleSummary(release: Release): string | null {
  const counts = (release.runs ?? [])
    .flatMap((run) => run.scenarios ?? [])
    .map((scenario) => scenario.sampleCount)
    .filter((count) => Number.isFinite(count) && count > 0);
  if (counts.length === 0) return null;

  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const sampleText = max === 1 ? "sample" : "samples";
  return min === max
    ? `${max} ${sampleText}/scenario`
    : `${min}-${max} samples/scenario`;
}

export function scenarioTrendView(
  release: Release,
  releases: Release[],
  limit = 6,
): { scenarios: Scenario[]; releaseCount: number } {
  const scenarios = release.scenarios ?? [];
  const trendReleases = [...releases]
    .filter((r) => (r.scenarios ?? []).length > 0)
    .reverse()
    .slice(-limit);

  if (trendReleases.length < 2) {
    return { scenarios, releaseCount: trendReleases.length };
  }

  return {
    scenarios: scenarios.map((scenario) => withReleaseTrend(scenario, trendReleases)),
    releaseCount: trendReleases.length,
  };
}

function withReleaseTrend(scenario: Scenario, releases: Release[]): Scenario {
  const lowerIsBetter = scenario.lowerIsBetter !== false;
  const values = releases
    .map((release) => (release.scenarios ?? []).find((candidate) =>
      candidate.id === scenario.id &&
      candidate.unit === scenario.unit &&
      (candidate.lowerIsBetter !== false) === lowerIsBetter,
    ))
    .filter((candidate): candidate is Scenario => Boolean(candidate))
    .map((candidate) => candidate.value)
    .filter((value): value is number => value != null && Number.isFinite(value));

  return values.length >= 2 ? { ...scenario, spark: values } : scenario;
}
