import { required } from "../cli.mjs";
import { platformInfo } from "../platform.mjs";
import { loadRegistryContext } from "../registries/context.mjs";
import { loadProfile } from "../registries/profiles.mjs";
import { validateScenarioRun } from "../registries/scenarios.mjs";
import { resolveTarget } from "../targets.mjs";
import { matrixControlSummary } from "./controls.mjs";
import { applyMatrixControls, expandProfile } from "./expand.mjs";
import { validateProfileTarget } from "./profile.mjs";
import { assertResolvedCoverageIsRunnable, resolveCoverageObligations } from "./resolver.mjs";

export async function resolveMatrixPlan(flags, options = {}) {
  const registry = await loadRegistryContext();
  const profile = await loadProfile(required(flags.profile, "--profile"));
  options.validateProfile?.(profile, flags);

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

  return {
    registry,
    profile,
    target,
    targetPlan,
    fromPlan,
    platform,
    entries,
    resolvedCoverage,
    controls: matrixControlSummary(flags, targetPlan)
  };
}
