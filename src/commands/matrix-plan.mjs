import { required } from "../cli.mjs";
import { applyMatrixControls, expandProfile } from "../matrix/expand.mjs";
import { matrixControlSummary } from "../matrix/controls.mjs";
import { profileSummary, validateProfileTarget } from "../matrix/profile.mjs";
import { assertResolvedCoverageIsRunnable, resolveCoverageObligations } from "../matrix/resolver.mjs";
import { platformInfo } from "../platform.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { loadProfile } from "../registries/profiles.mjs";
import { validateScenarioRun } from "../registries/scenarios.mjs";
import { resolveTarget } from "../targets.mjs";

export async function runMatrixPlan(flags) {
  const registry = await loadRegistryContext();
  const profile = await loadProfile(required(flags.profile, "--profile"));
  const target = required(flags.target, "--target");
  const targetPlan = resolveTarget(target, "target");
  validateProfileTarget(profile, targetPlan);
  const fromPlan = flags.from ? resolveTarget(flags.from, "from") : null;
  const platform = platformInfo();
  const entries = applyMatrixControls(await expandProfile(profile), flags, platform);
  const resolvedCoverage = resolveCoverageObligations({
    profile,
    entries,
    surfaces: registry.surfaces,
    targetPlan
  });
  assertResolvedCoverageIsRunnable(resolvedCoverage);
  for (const entry of entries.filter((item) => !item.skipReason)) {
    validateScenarioRun(entry.scenario, flags, { targetPlan, fromPlan });
  }
  const response = {
    schemaVersion: "kova.matrix.plan.v1",
    generatedAt: new Date().toISOString(),
    platform,
    profile: profileSummary(profile),
    target,
    from: flags.from ?? null,
    controls: matrixControlSummary(flags, targetPlan),
    resolvedCoverage,
    entries: entries.map((entry) => entry.plan)
  };

  if (flags.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(`${profile.id}: ${profile.title}`);
  console.log(`Target: ${target}`);
  if (flags.from) {
    console.log(`From: ${flags.from}`);
  }
  for (const entry of entries) {
    const suffix = entry.skipReason ? ` [SKIP: ${entry.skipReason}]` : "";
    console.log(`- ${entry.scenario.id} / ${entry.state.id}: ${entry.scenario.title}${suffix}`);
  }
}
