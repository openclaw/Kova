export function profileSummary(profile) {
  return {
    id: profile.id,
    title: profile.title,
    objective: profile.objective,
    purpose: profile.purpose ?? null,
    entryCount: profile.entries.length,
    targetKinds: profile.targetKinds ?? null,
    ...(profile.localBuildProfile ? { localBuildProfile: profile.localBuildProfile } : {}),
    diagnostics: profile.diagnostics ?? null,
    calibration: profile.calibration ? {
      surfaceCount: Object.keys(profile.calibration.surfaces ?? {}).length,
      roleCount: Object.keys(profile.calibration.roles ?? {}).length
    } : null,
    gate: profile.gate ? {
      id: profile.gate.id ?? `${profile.id}-gate`,
      blockingCount: Array.isArray(profile.gate.blocking) ? profile.gate.blocking.length : profile.entries.length,
      warningCount: Array.isArray(profile.gate.warning) ? profile.gate.warning.length : 0
    } : null
  };
}

export function validateProfileTarget(profile, targetPlan) {
  const targetKinds = profile.targetKinds ?? [];
  if (targetKinds.length === 0) {
    return;
  }
  if (!targetKinds.includes(targetPlan.kind)) {
    throw new Error(`profile '${profile.id}' requires target kind ${targetKinds.join(", ")}, got ${targetPlan.kind}`);
  }
}
