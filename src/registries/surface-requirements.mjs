export const knownTargetKinds = ["npm", "channel", "runtime", "local-build"];

export function requirementsForScenario(surface, scenario) {
  return requirementsForIds(surface, scenario?.proves ?? []);
}

export function requirementsForIds(surface, ids) {
  const requirements = surface?.requirements ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export function targetKindsForRequirements(requirements) {
  return [...new Set((requirements ?? []).flatMap((requirement) => requirement.targetKinds ?? []))].sort();
}

export function stateSatisfiesRequirement(state, requirement) {
  const states = requirement?.states ?? [];
  const traits = requirement?.stateTraits ?? [];
  if (states.length === 0 && traits.length === 0) {
    return { ok: true, reason: null };
  }
  if (state?.id && states.includes(state.id)) {
    return { ok: true, reason: null };
  }
  const stateTraits = new Set(state?.traits ?? []);
  if (traits.some((trait) => stateTraits.has(trait))) {
    return { ok: true, reason: null };
  }
  return {
    ok: false,
    reason: `state '${state?.id ?? "unknown"}' does not satisfy requirement state ids or traits`
  };
}

export function scenarioSupportsState({ scenario, surface, state }) {
  if ((scenario?.states ?? []).length > 0) {
    return {
      ok: scenario.states.includes(state?.id),
      reason: scenario.states.includes(state?.id)
        ? null
        : `scenario '${scenario.id}' supports only states: ${scenario.states.join(", ")}`
    };
  }

  const requirements = requirementsForScenario(surface, scenario);
  if (requirements.length === 0) {
    return {
      ok: false,
      reason: `scenario '${scenario?.id ?? "unknown"}' has no known requirements for surface '${surface?.id ?? "unknown"}'`
    };
  }
  if (requirements.some((requirement) => stateSatisfiesRequirement(state, requirement).ok)) {
    return { ok: true, reason: null };
  }
  return {
    ok: false,
    reason: `state '${state?.id ?? "unknown"}' does not satisfy scenario '${scenario.id}' requirement state ids or traits`
  };
}

export function surfaceSupportsState({ surface, state }) {
  const requirements = surface?.requirements ?? [];
  if (requirements.length === 0) {
    return {
      ok: false,
      reason: `surface '${surface?.id ?? "unknown"}' has no requirements`
    };
  }
  if (requirements.some((requirement) => stateSatisfiesRequirement(state, requirement).ok)) {
    return { ok: true, reason: null };
  }
  return {
    ok: false,
    reason: `state '${state?.id ?? "unknown"}' does not satisfy surface '${surface.id}' requirement state ids or traits`
  };
}
