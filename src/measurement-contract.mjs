export const MEASUREMENT_SCOPES = new Set(["product", "harness", "cleanup"]);

export function normalizeMeasurementScope(value, phaseId = null) {
  if (MEASUREMENT_SCOPES.has(value)) {
    return value;
  }
  if (
    phaseId === "target-setup" ||
    phaseId === "auth-prepare" ||
    phaseId === "auth-setup" ||
    phaseId === "prepare" ||
    phaseId?.startsWith("state-")
  ) {
    return "harness";
  }
  if (phaseId === "cleanup" || phaseId === "auth-cleanup" || phaseId === "env-cleanup") {
    return "cleanup";
  }
  return "product";
}

export function measuredProductPhase(phase) {
  return measurementScopeForPhase(phase) === "product";
}

export function measurementScopeForPhase(phase) {
  if (MEASUREMENT_SCOPES.has(phase?.measurementScope)) {
    return phase.measurementScope;
  }
  if (
    phase?.id === "provision" &&
    (phase.commands ?? []).some((command) => /(?:^|\s)--no-service(?:\s|$)/.test(command))
  ) {
    return "harness";
  }
  return normalizeMeasurementScope(phase?.measurementScope, phase?.id);
}
