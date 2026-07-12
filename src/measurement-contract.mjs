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
  if ((phase?.commands ?? []).some((command) => /(?:^|\s)--no-service(?:\s|$)/.test(command))) {
    return "harness";
  }
  return normalizeMeasurementScope(phase?.measurementScope, phase?.id);
}

export function phaseResultStatus(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return "empty";
  }
  return results.every((result) => commandResultPassed(result)) ? "success" : "failure";
}

export function commandResultPassed(result) {
  if (!result) {
    return false;
  }
  // Evidence-producing helpers own the result when they emit a status.
  // Command exit fields are only the fallback for ordinary process results.
  if (typeof result.evidenceStatus === "string") {
    return result.evidenceStatus === "passed";
  }
  if (result.status === 0 || result.exitCode === 0) {
    return true;
  }
  const status = String(result.status ?? "").toUpperCase();
  return status === "PASS" || status === "PASSED";
}

export function commandResultFailed(result) {
  if (!result) {
    return false;
  }
  if (typeof result.evidenceStatus === "string") {
    return result.evidenceStatus === "failed";
  }
  if (result.timedOut === true) {
    return true;
  }
  if (typeof result.status === "number") {
    return result.status !== 0;
  }
  if (typeof result.exitCode === "number") {
    return result.exitCode !== 0;
  }
  const status = String(result.status ?? "").toUpperCase();
  return status === "FAIL" || status === "FAILED" || status === "ERROR";
}

export function commandResultFailureReason(result, subject = "command") {
  if (result?.timedOut === true) {
    return `${subject} timed out`;
  }
  if (result?.evidenceStatus === "failed") {
    const evidenceReason = typeof result.evidenceReason === "string"
      ? result.evidenceReason.trim()
      : "";
    return evidenceReason.length > 0
      ? `${subject} evidence failed: ${evidenceReason}`
      : `${subject} evidence failed`;
  }
  return `${subject} exited ${result?.status ?? result?.exitCode ?? "unknown"}`;
}

export function readinessThresholdForPhase(scenario, phase) {
  const thresholds = scenario?.thresholds ?? {};
  const defaultMs = thresholds.gatewayReadyMs ?? 30000;
  if (!phase) {
    return 0;
  }
  if ((phase.commands ?? []).some((command) => /(?:^|\s)--no-service(?:\s|$)/.test(command))) {
    return 0;
  }
  if (phase.id === "cold-start" || phase.id === "provision" || phase.id === "baseline" || phase.id === "gateway" || phase.id === "start") {
    return thresholds.coldReadyMs ?? thresholds.gatewayReadyMs ?? defaultMs;
  }
  if (phase.id === "gateway-start") {
    return thresholds.gatewayReadyMs ?? defaultMs;
  }
  if (phase.id === "warm-restart" || phase.id === "restart") {
    return thresholds.warmReadyMs ?? thresholds.restartReadyMs ?? thresholds.gatewayReadyMs ?? defaultMs;
  }
  if (phase.id === "upgrade" || phase.id === "post-upgrade" || phase.id === "source-runtime") {
    return thresholds.gatewayReadyMs ?? defaultMs;
  }
  return 0;
}

export function readinessHardTimeoutForPhase(scenario, phase, thresholdMs) {
  if (!phase || thresholdMs <= 0) {
    return 0;
  }
  const thresholds = scenario?.thresholds ?? {};
  const explicit = thresholds.gatewayReadyHardTimeoutMs ?? thresholds.readinessHardTimeoutMs;
  if (typeof explicit === "number") {
    return Math.max(explicit, thresholdMs);
  }
  return Math.max(thresholdMs * 3, thresholdMs + 30000);
}

export function driverKindForCommand(command) {
  const text = String(command ?? "");
  if (text.includes("run-gateway-session-send-turn.mjs")) {
    return "gateway-rpc";
  }
  if (text.includes("run-channel-probe-turn.mjs")) {
    return "gateway-rpc";
  }
  if (text.includes("run-openai-compatible-turn.mjs")) {
    return "gateway-http";
  }
  if (text.includes("run-tui-message-turn.mjs")) {
    return "tui-stdio";
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

export function tagCommandResult(result, phase) {
  result.measurementScope = measurementScopeForPhase(phase);
  result.driverKind = driverKindForCommand(result.command);
  return result;
}

export function withPhaseContract(phase, scope = null) {
  const ownedPhase = scope === null ? phase : { ...phase, measurementScope: scope };
  return {
    ...ownedPhase,
    measurementScope: measurementScopeForPhase(ownedPhase),
    driverKind: phaseDriverKind(ownedPhase)
  };
}

export function isAgentMessageCommand(command) {
  const text = String(command ?? "");
  return isAgentCliMessageCommand(text) ||
    text.includes("run-concurrent-agent-turns.mjs") ||
    text.includes("run-gateway-session-send-turn.mjs") ||
    text.includes("run-tui-message-turn.mjs") ||
    text.includes("run-channel-probe-turn.mjs") ||
    text.includes("run-openai-compatible-turn.mjs") ||
    text.includes("run-adversarial-inputs.mjs");
}

export function isAgentCliMessageCommand(command) {
  const text = String(command ?? "");
  return text.includes(" -- agent ") && text.includes("--message");
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
