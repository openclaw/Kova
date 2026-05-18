import { normalizeCollectionIntent } from "./collection-contract.mjs";

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
    readiness: "wait",
    healthSamples: true,
    collectors: Object.fromEntries(ENV_COLLECTOR_IDS.map((id) => [id, true])),
    skipped: []
  };
}

export function postReadyHealthCollectionPolicy(reason, context = {}) {
  return {
    schemaVersion: COLLECTION_POLICY_SCHEMA,
    mode: "post-ready-health",
    reason,
    context: normalizePolicyContext(context),
    readiness: "none",
    healthSamples: true,
    collectors: Object.fromEntries(ENV_COLLECTOR_IDS.map((id) => [id, true])),
    skipped: ["readiness-wait"]
  };
}

export function serviceOnlyCollectionPolicy(reason, context = {}) {
  return {
    schemaVersion: COLLECTION_POLICY_SCHEMA,
    mode: "service-only",
    reason,
    context: normalizePolicyContext(context),
    readiness: "none",
    healthSamples: false,
    collectors: {
      service: true,
      process: true,
      readiness: false,
      health: false,
      logs: false,
      "openclaw-diagnostics": false,
      timeline: false,
      diagnostics: false,
      "node-profiles": false,
      "heap-snapshot": false,
      "diagnostic-report": false
    },
    skipped: [
      "readiness",
      "health",
      "logs",
      "openclaw-diagnostics",
      "timeline",
      "diagnostics",
      "node-profiles",
      "heap-snapshot",
      "diagnostic-report"
    ]
  };
}

export function skippedEnvCollectionPolicy(reason, context = {}) {
  return {
    schemaVersion: COLLECTION_POLICY_SCHEMA,
    mode: "skip-env",
    reason,
    context: normalizePolicyContext(context),
    readiness: "none",
    healthSamples: false,
    collectors: Object.fromEntries(ENV_COLLECTOR_IDS.map((id) => [id, false])),
    skipped: [...ENV_COLLECTOR_IDS]
  };
}

export function resolveCollectionPolicy(context = {}) {
  const intent = normalizeCollectionIntent(context.collectionIntent);
  if (context.resultStatus !== "success") {
    return fullCollectionPolicy(policyReason(context), context);
  }
  if (intent === "skip-env") {
    return skippedEnvCollectionPolicy(
      "collection contract marks this successful phase as command-receipt-only; env metrics are skipped",
      context
    );
  }
  if (intent === "service-only") {
    return serviceOnlyCollectionPolicy(
      "collection contract marks this successful phase as service-summary proof; only service summary is collected",
      context
    );
  }
  if (intent === "post-ready-health") {
    return postReadyHealthCollectionPolicy(
      "collection contract marks this phase as post-ready health sampling without repeating startup readiness wait",
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
    resultStatus: context.resultStatus ?? null,
    collectionIntent: context.collectionIntent ?? null,
    lifecycleKind: context.lifecycleKind ?? null,
    lifecycleCommandScope: context.lifecycleCommandScope ?? null
  };
}
