import { loadScenarios } from "../registries/scenarios.mjs";
import { loadState } from "../registries/states.mjs";

export async function expandProfile(profile) {
  const entries = [];
  for (const entry of profile.entries) {
    const [scenario] = await loadScenarios(entry.scenario);
    const state = await loadState(entry.state);
    entries.push({
      scenario: {
        id: scenario.id,
        surface: scenario.surface,
        title: scenario.title,
        objective: scenario.objective,
        tags: scenario.tags
      },
      state: {
        id: state.id,
        title: state.title,
        objective: state.objective,
        tags: state.tags
      },
      entry: {
        timeoutMs: entry.timeoutMs ?? null,
        platforms: entry.platforms ?? null
      },
      fullScenario: scenario,
      fullState: state
    });
  }

  return entries.map((entry) => ({
    scenario: entry.fullScenario,
    state: entry.fullState,
    timeoutMs: entry.entry.timeoutMs,
    platforms: entry.entry.platforms,
    plan: {
      scenario: entry.scenario,
      state: entry.state,
      surface: entry.fullScenario.surface,
      timeoutMs: entry.entry.timeoutMs ?? entry.fullScenario.timeoutMs ?? null,
      platforms: entry.entry.platforms ?? entry.fullScenario.platforms ?? null
    }
  }));
}

export function applyMatrixControls(entries, flags, platform) {
  const included = parseFilterList(flags.include);
  const excluded = parseFilterList(flags.exclude);
  return entries
    .filter((entry) => included.length === 0 || included.some((filter) => entryMatchesFilter(entry, filter)))
    .filter((entry) => !excluded.some((filter) => entryMatchesFilter(entry, filter)))
    .map((entry) => {
      const skipReason = platformSkipReason(entry, platform);
      return {
        ...entry,
        skipReason,
        plan: {
          ...entry.plan,
          status: skipReason ? "SKIPPED" : "SELECTED",
          skipReason
        }
      };
    });
}

export function parseFilterList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function entryMatchesFilter(entry, filter) {
  const [kind, value] = filter.includes(":") ? filter.split(":", 2) : ["any", filter];
  if (kind === "scenario") {
    return entry.scenario.id === value;
  }
  if (kind === "state") {
    return entry.state.id === value;
  }
  if (kind === "tag") {
    return [...(entry.scenario.tags ?? []), ...(entry.state.tags ?? [])].includes(value);
  }
  return entry.scenario.id === value || entry.state.id === value ||
    (entry.scenario.tags ?? []).includes(value) || (entry.state.tags ?? []).includes(value);
}

function platformSkipReason(entry, platform) {
  for (const policy of [entry.scenario.platforms, entry.platforms]) {
    const reason = platformPolicySkipReason(policy, platform);
    if (reason) {
      return reason;
    }
  }
  return null;
}

function platformPolicySkipReason(policy, platform) {
  if (!policy) {
    return null;
  }
  const keys = platformKeys(platform);
  if (Array.isArray(policy.include) && policy.include.length > 0 && !policy.include.some((item) => keys.includes(item))) {
    return `platform ${platform.os}/${platform.arch} not included`;
  }
  if (Array.isArray(policy.exclude) && policy.exclude.some((item) => keys.includes(item))) {
    return `platform ${platform.os}/${platform.arch} excluded`;
  }
  return null;
}

function platformKeys(platform) {
  return [
    platform.os,
    platform.arch,
    `${platform.os}-${platform.arch}`,
    platform.release
  ].filter(Boolean);
}
