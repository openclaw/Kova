import { loadMetrics } from "./metrics.mjs";
import { loadChannelCapabilities } from "./channel-capabilities.mjs";
import { loadProcessRoles } from "./process-roles.mjs";
import { loadProfiles } from "./profiles.mjs";
import { loadScenarios } from "./scenarios.mjs";
import { loadStates } from "./states.mjs";
import { loadSurfaces } from "./surfaces.mjs";
import { validateRegistryReferences } from "./validate.mjs";

export async function loadRegistryContext() {
  const [surfaces, processRoles, metrics, channelCapabilities, scenarios, states, profiles] = await Promise.all([
    loadSurfaces(),
    loadProcessRoles(),
    loadMetrics(),
    loadChannelCapabilities(),
    loadScenarios(),
    loadStates(),
    loadProfiles()
  ]);
  validateRegistryReferences({ scenarios, states, profiles, surfaces, processRoles, metrics });
  return { surfaces, processRoles, metrics, channelCapabilities, scenarios, states, profiles };
}
