export const COLLECTION_POLICY_SCHEMA = "kova.collectionPolicy.v1";

export const ENV_COLLECTOR_IDS = [
  "service",
  "process",
  "readiness",
  "health",
  "logs",
  "openclaw-diagnostics",
  "timeline",
  "diagnostics",
  "node-profiles",
  "heap-snapshot",
  "diagnostic-report"
];

export function fullCollectionPolicy(reason = "full collection preserves existing evidence behavior", context = {}) {
  return {
    schemaVersion: COLLECTION_POLICY_SCHEMA,
    mode: "full",
    reason,
    context: normalizePolicyContext(context),
    collectors: Object.fromEntries(ENV_COLLECTOR_IDS.map((id) => [id, true])),
    skipped: []
  };
}

export function skippedEnvCollectionPolicy(reason, context = {}) {
  return {
    schemaVersion: COLLECTION_POLICY_SCHEMA,
    mode: "skip-env",
    reason,
    context: normalizePolicyContext(context),
    collectors: Object.fromEntries(ENV_COLLECTOR_IDS.map((id) => [id, false])),
    skipped: [...ENV_COLLECTOR_IDS]
  };
}

export function resolveCollectionPolicy(context = {}) {
  if (context.kind === "auth-phase" &&
      context.resultStatus === "success" &&
      (context.phaseId === "auth-prepare" || context.phaseId === "auth-cleanup")) {
    return skippedEnvCollectionPolicy(
      "successful auth setup boundary phase does not need env metrics; final and product phase metrics remain full",
      context
    );
  }
  return fullCollectionPolicy(policyReason(context), context);
}

function policyReason(context) {
  if (context.kind === "failure-diagnostics") {
    return "failure diagnostics require full collection";
  }
  if (context.kind === "final") {
    return "final metrics require full collection before cleanup";
  }
  if (context.kind === "scenario-phase") {
    return "scenario phase evidence requires full collection";
  }
  if (context.kind === "auth-phase") {
    return "auth phase currently keeps full collection for behavior parity";
  }
  if (context.kind === "state-lifecycle") {
    return "state lifecycle evidence currently keeps full collection for behavior parity";
  }
  if (context.kind === "evidence-snapshot") {
    return "evidence snapshot phases currently keep full collection for behavior parity";
  }
  return "full collection preserves existing evidence behavior";
}

function normalizePolicyContext(context) {
  return {
    kind: context.kind ?? "unknown",
    scenario: context.scenario ?? null,
    surface: context.surface ?? null,
    phaseId: context.phaseId ?? null,
    phaseHealthScope: context.phaseHealthScope ?? null,
    measurementScope: context.measurementScope ?? null,
    resultStatus: context.resultStatus ?? null
  };
}
