/**
 * Aggregations over the `releases` content collection. Centralized so pages
 * don't repeat sort/filter logic.
 */

import { getCollection } from "astro:content";
import type { Release, Scenario } from "../content.config";

export async function allReleases(): Promise<Array<Release & { id: string }>> {
  const entries = await getCollection("releases");
  return entries
    .map((e) => ({ id: e.id, ...e.data }))
    .sort((a, b) => b.releaseDate.getTime() - a.releaseDate.getTime());
}

export async function latestRelease(): Promise<Release & { id: string }> {
  const all = await allReleases();
  const withScenarios = all.find((r) => r.scenarios && r.scenarios.length > 0);
  if (!withScenarios) {
    throw new Error("No release in src/content/releases has scenarios populated");
  }
  return withScenarios;
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
