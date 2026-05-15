import { profileSummary } from "../matrix/profile.mjs";
import { buildCoverage } from "../matrix/coverage.mjs";
import { platformInfo } from "../platform.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { renderPlan } from "../reporting/render-plan.mjs";

export async function runPlanCommand(flags) {
  const registry = await loadRegistryContext();
  const scenarios = filterRegistry(registry.scenarios, flags.scenario, "scenario");
  const states = filterRegistry(registry.states, flags.state, "state");
  const profiles = flags.profile ? filterRegistry(registry.profiles, flags.profile, "profile") : registry.profiles;
  const platform = platformInfo();
  const coverage = buildCoverage({ ...registry, platform });

  const planJson = {
    schemaVersion: "kova.plan.v1",
    generatedAt: new Date().toISOString(),
    platform,
    surfaces: registry.surfaces,
    processRoles: registry.processRoles,
    metrics: registry.metrics,
    scenarios,
    states,
    profiles: profiles.map(profileSummary),
    coverage,
  };

  if (flags.json) {
    console.log(JSON.stringify(planJson, null, 2));
    return;
  }

  if (!flags.plain) {
    console.log(renderPlan(planJson, flags));
    return;
  }

  for (const scenario of scenarios) {
    console.log(`${scenario.id}: ${scenario.title}`);
    console.log(`  Surface: ${scenario.surface}`);
    console.log(`  Objective: ${scenario.objective}`);
    console.log(`  Tags: ${scenario.tags.join(", ")}`);
    console.log("  Phases:");
    for (const phase of scenario.phases) {
      console.log(`    - ${phase.id}: ${phase.title}`);
    }
    console.log("");
  }
}

function filterRegistry(items, selectedId, kind) {
  if (!selectedId) {
    return items;
  }
  const filtered = items.filter((item) => item.id === selectedId);
  if (filtered.length === 0) {
    throw new Error(`no ${kind} found for ${selectedId}`);
  }
  return filtered;
}
