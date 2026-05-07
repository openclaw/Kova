export const MEASUREMENT_SCOPES = new Set(["product", "harness", "cleanup"]);

export function normalizeMeasurementScope(value, phaseId = null) {
  if (MEASUREMENT_SCOPES.has(value)) {
    return value;
  }
  if (phaseId === "target-setup" || phaseId === "auth-prepare" || phaseId === "auth-setup" || phaseId === "prepare" || phaseId?.startsWith("state-")) {
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
  if (phase?.id === "provision" && (phase.commands ?? []).some((command) => /(?:^|\s)--no-service(?:\s|$)/.test(command))) {
    return "harness";
  }
  return normalizeMeasurementScope(phase?.measurementScope, phase?.id);
}

export function driverKindForCommand(command) {
  const text = String(command ?? "");
  if (text.includes("run-gateway-session-send-turn.mjs")) {
    return "gateway-rpc";
  }
  if (text.includes("run-openai-compatible-turn.mjs")) {
    return "gateway-http";
  }
  if (text.includes("run-tui-message-turn.mjs")) {
    return "gateway-rpc";
  }
  if (/\bocm\s+@[^ ]+\s+--\s+agent\b/.test(text)) {
    return text.includes("--local") ? "openclaw-cli-local" : "openclaw-cli-gateway";
  }
  if (/\bocm\s+@[^ ]+\s+--\s+gateway\s+call\b/.test(text)) {
    return "gateway-rpc-via-cli";
  }
  if (/\bocm\b/.test(text)) {
    return "ocm";
  }
  if (/\bnode\b/.test(text)) {
    return "kova-helper";
  }
  return "unknown";
}

export function phaseDriverKind(phase, commands = phase?.commands ?? []) {
  if (phase?.driverKind) {
    return phase.driverKind;
  }
  const kinds = new Set(commands.map(driverKindForCommand));
  if (kinds.size === 1) {
    return [...kinds][0];
  }
  if (kinds.size === 0) {
    return "none";
  }
  return "mixed";
}
