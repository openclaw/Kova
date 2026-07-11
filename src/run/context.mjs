import { positiveIntegerFlag, profileIntegerFlag } from "./options.mjs";

export function buildRunContext({
  flags,
  registry,
  target,
  targetPlan,
  from = null,
  fromPlan = null,
  state,
  runId,
  auth,
  timeoutMs,
  profile = null,
  controls = null,
  targetSetup = { completed: false, failed: false, results: [] }
}) {
  const networkFrontage = controls?.networkFrontage ?? flags.networkFrontage ?? flags.network_frontage_controls ?? null;
  return {
    target,
    targetPlan,
    ...(profile ? { profile } : {}),
    from,
    fromPlan,
    state,
    sourceEnv: flags.source_env,
    runId,
    ...(controls ? { controls } : {}),
    execute: flags.execute === true,
    keepEnv: flags.keep_env === true,
    retainOnFailure: flags.retain_on_failure === true,
    timeoutMs,
    healthSamples: profileIntegerFlag(flags, "health_samples", flags.deep_profile === true ? 10 : 3),
    healthIntervalMs: positiveIntegerFlag(flags, "health_interval_ms", 250),
    readinessIntervalMs: profileIntegerFlag(flags, "readiness_interval_ms", flags.deep_profile === true ? 100 : 250),
    heapSnapshot: flags.heap_snapshot === true || flags.deep_profile === true,
    diagnosticReport: flags.deep_profile === true,
    nodeProfile: flags.node_profile === true || flags.deep_profile === true,
    deepProfile: flags.deep_profile === true,
    profileOnFailure: flags.profile_on_failure === true,
    resourceSampleIntervalMs: profileIntegerFlag(flags, "resource_sample_interval_ms", flags.deep_profile === true ? 250 : 1000),
    processRoles: registry.processRoles,
    surfacesById: Object.fromEntries(registry.surfaces.map((surface) => [surface.id, surface])),
    targetSetup,
    auth,
    networkFrontage
  };
}
