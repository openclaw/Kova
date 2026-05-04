export const coveragePolicyKeys = [
  "surfaces",
  "platforms",
  "states",
  "traits",
  "scenarios",
  "stateSurfaces",
  "requirements"
];

export const primaryCoveragePolicyKeys = ["platforms", "requirements"];
export const derivedCoveragePolicyKeys = ["surfaces", "scenarios", "states", "traits", "stateSurfaces"];

export function normalizeCoveragePolicy(coverage) {
  const input = coverage && typeof coverage === "object" ? coverage : {};
  return Object.fromEntries(coveragePolicyKeys.map((key) => [key, normalizeCoverageSet(input[key])]));
}

export function deriveCoveragePolicy(coverage, obligations = []) {
  const policy = normalizeCoveragePolicy(coverage);
  const requirementSeverity = requirementSeverityByKey(policy.requirements);

  for (const obligation of obligations ?? []) {
    const key = requirementKey(obligation.surface, obligation.requirement);
    const severity = requirementSeverity.get(key);
    if (!severity) {
      continue;
    }
    add(policy.surfaces, severity, obligation.surface);
    add(policy.scenarios, severity, obligation.scenario);
    add(policy.states, severity, obligation.state);
    add(policy.stateSurfaces, severity, obligation.surface && obligation.state ? `${obligation.surface}:${obligation.state}` : null);
    for (const trait of obligation.stateTraits ?? []) {
      add(policy.traits, severity, trait);
    }
  }

  return sortCoveragePolicy(policy);
}

export function buildEntryCoverageObligations(profile, { scenarios, states }) {
  const scenarioById = new Map((scenarios ?? []).map((scenario) => [scenario.id, scenario]));
  const stateById = new Map((states ?? []).map((state) => [state.id, state]));
  const obligations = [];

  for (const entry of profile?.entries ?? []) {
    const scenario = scenarioById.get(entry.scenario);
    const state = stateById.get(entry.state);
    if (!scenario) {
      continue;
    }
    for (const requirement of scenario.proves ?? []) {
      obligations.push({
        surface: scenario.surface,
        requirement,
        scenario: scenario.id,
        state: entry.state,
        stateTraits: state?.traits ?? [],
        status: "planned"
      });
    }
  }

  return obligations;
}

export function coverageIdsFromSet(set) {
  return [...new Set([...(set?.blocking ?? []), ...(set?.warning ?? [])])].sort();
}

function normalizeCoverageSet(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    blocking: normalizeStringList(input.blocking),
    warning: normalizeStringList(input.warning)
  };
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function requirementSeverityByKey(requirements) {
  const severities = new Map();
  for (const value of requirements.warning) {
    severities.set(value, "warning");
  }
  for (const value of requirements.blocking) {
    severities.set(value, "blocking");
  }
  return severities;
}

function requirementKey(surface, requirement) {
  return `${surface}:${requirement}`;
}

function add(set, severity, value) {
  if (typeof value !== "string" || value.length === 0) {
    return;
  }
  if (!set[severity].includes(value)) {
    set[severity].push(value);
  }
}

function sortCoveragePolicy(policy) {
  return Object.fromEntries(Object.entries(policy).map(([key, value]) => [
    key,
    {
      blocking: derivedCoveragePolicyKeys.includes(key) ? [...value.blocking].sort() : value.blocking,
      warning: derivedCoveragePolicyKeys.includes(key) ? [...value.warning].sort() : value.warning
    }
  ]));
}
