import { stateSatisfiesRequirement } from "../registries/surface-requirements.mjs";

export const RESOLVED_COVERAGE_SCHEMA = "kova.resolvedCoverage.v1";

export function resolveCoverageObligations({ profile, entries, surfaces, targetPlan }) {
  const surfaceById = new Map((surfaces ?? []).map((surface) => [surface.id, surface]));
  const obligations = [];
  const warnings = [];

  for (const entry of entries ?? []) {
    const scenario = entry.scenario;
    const state = entry.state;
    const surface = surfaceById.get(scenario?.surface);
    if (!surface) {
      obligations.push(obligationFor(entry, {
        surface: scenario?.surface ?? null,
        requirement: null,
        targetPlan,
        status: "invalid",
        reason: `scenario '${scenario?.id ?? "unknown"}' references missing surface '${scenario?.surface ?? ""}'`
      }));
      continue;
    }

    const requirements = new Map((surface.requirements ?? []).map((requirement) => [requirement.id, requirement]));
    const proves = scenario.proves ?? [];
    if (proves.length === 0) {
      obligations.push(obligationFor(entry, {
        surface: surface.id,
        requirement: null,
        targetPlan,
        status: "missing-proof",
        reason: `scenario '${scenario.id}' does not declare proved requirements for surface '${surface.id}'`
      }));
      continue;
    }

    for (const requirementId of proves) {
      const requirement = requirements.get(requirementId);
      if (!requirement) {
        obligations.push(obligationFor(entry, {
          surface: surface.id,
          requirement: requirementId,
          targetPlan,
          status: "invalid",
          reason: `scenario '${scenario.id}' proves unknown requirement '${surface.id}:${requirementId}'`
        }));
        continue;
      }

      const stateResult = stateSatisfiesRequirement(state, requirement);
      const targetResult = targetSatisfiesRequirement(targetPlan, requirement);
      const status = entry.skipReason
        ? "skipped"
        : !stateResult.ok
          ? "unsupported-state"
          : !targetResult.ok
            ? "unsupported-target"
            : "planned";
      obligations.push(obligationFor(entry, {
        surface: surface.id,
        requirement: requirement.id,
        requirementContract: requirement,
        targetPlan,
        status,
        reason: entry.skipReason ?? stateResult.reason ?? targetResult.reason ?? null
      }));
    }
  }

  const gaps = buildRequirementGaps(profile, obligations);

  return {
    schemaVersion: RESOLVED_COVERAGE_SCHEMA,
    purpose: profile?.purpose ?? null,
    targetKind: targetPlan?.kind ?? null,
    total: obligations.length,
    statuses: countStatuses(obligations),
    obligations,
    gaps,
    warnings
  };
}

export function assertResolvedCoverageIsRunnable(resolved) {
  const invalid = (resolved?.obligations ?? []).filter((obligation) =>
    ["invalid", "missing-proof", "unsupported-state", "unsupported-target"].includes(obligation.status)
  );
  if (invalid.length === 0) {
    return;
  }
  const messages = invalid.slice(0, 5).map((obligation) =>
    `${obligation.scenario}/${obligation.state ?? "no-state"} -> ${obligation.surface}:${obligation.requirement ?? "none"} ${obligation.status}${obligation.reason ? ` (${obligation.reason})` : ""}`
  );
  throw new Error(`resolved coverage contains invalid obligation(s):\n- ${messages.join("\n- ")}`);
}

function obligationFor(entry, options) {
  const requirement = options.requirementContract ?? {};
  return {
    surface: options.surface,
    requirement: options.requirement,
    scenario: entry.scenario?.id ?? null,
    state: entry.state?.id ?? null,
    stateTraits: entry.state?.traits ?? [],
    targetKind: options.targetPlan?.kind ?? null,
    status: options.status,
    reason: options.reason,
    requiredStates: requirement.states ?? [],
    requiredStateTraits: requirement.stateTraits ?? [],
    requiredTargetKinds: requirement.targetKinds ?? [],
    requiredMetrics: requirement.metrics ?? []
  };
}

function targetSatisfiesRequirement(targetPlan, requirement) {
  const targetKinds = requirement.targetKinds ?? [];
  if (targetKinds.length === 0 || targetKinds.includes(targetPlan?.kind)) {
    return { ok: true, reason: null };
  }
  return {
    ok: false,
    reason: `target kind '${targetPlan?.kind ?? "unknown"}' is not supported by requirement`
  };
}

function buildRequirementGaps(profile, obligations) {
  const required = profileRequirementCoverage(profile);
  if (required.length === 0) {
    return [];
  }
  const planned = new Set(obligations
    .filter((obligation) => obligation.status === "planned")
    .map((obligation) => requirementKey(obligation.surface, obligation.requirement)));
  return required
    .filter((item) => !planned.has(item.key))
    .map((item) => ({
      surface: item.surface,
      requirement: item.requirement,
      severity: item.severity,
      reason: "no selected runnable scenario/state/target obligation proves this requirement"
    }));
}

function profileRequirementCoverage(profile) {
  const coverage = profile?.gate?.coverage?.requirements;
  if (!coverage) {
    return [];
  }
  return [
    ...coverageEntries(coverage.blocking, "blocking"),
    ...coverageEntries(coverage.warning, "warning")
  ];
}

function coverageEntries(values, severity) {
  return (values ?? []).map((value) => {
    const [surface, requirement] = String(value).split(":");
    return {
      surface,
      requirement,
      severity,
      key: requirementKey(surface, requirement)
    };
  });
}

function requirementKey(surface, requirement) {
  return `${surface}:${requirement}`;
}

function countStatuses(obligations) {
  const counts = {};
  for (const obligation of obligations) {
    counts[obligation.status] = (counts[obligation.status] ?? 0) + 1;
  }
  return counts;
}
