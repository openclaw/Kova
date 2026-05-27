const SESSION_POLICIES = new Set([
  "isolated-flow",
  "same-case-continuity",
  "multi-turn-continuity"
]);

export function workflowSessionPolicy(workflowCase) {
  const explicit = typeof workflowCase?.sessionPolicy === "string"
    ? workflowCase.sessionPolicy
    : null;
  if (explicit && SESSION_POLICIES.has(explicit)) {
    return explicit;
  }
  if (requiresSameCaseContinuity(workflowCase)) {
    return "same-case-continuity";
  }
  return "isolated-flow";
}

export function withWorkflowFlowScope(workflowCase, { index }) {
  const sessionPolicy = workflowSessionPolicy(workflowCase);
  const scopeKey = sessionPolicy === "multi-turn-continuity"
    ? multiTurnScopeKey(workflowCase)
    : `${workflowCase.id}:${Number.isInteger(index) ? index : 0}`;
  return {
    ...workflowCase,
    flowScope: {
      schemaVersion: "kova.channelFlowScope.v1",
      sessionPolicy,
      scopeKey,
      ordinal: Number.isInteger(index) ? index : 0
    }
  };
}

function requiresSameCaseContinuity(workflowCase) {
  const expects = workflowCase?.expects && typeof workflowCase.expects === "object" && !Array.isArray(workflowCase.expects)
    ? workflowCase.expects
    : {};
  return expects.noSelfTrigger === true ||
    (expects.livePreview && typeof expects.livePreview === "object" && !Array.isArray(expects.livePreview)) ||
    workflowCase?.matrix?.lifecycle === "bot-echo" ||
    workflowCase?.matrix?.lifecycle === "ambiguous-send";
}

function multiTurnScopeKey(workflowCase) {
  const explicit = typeof workflowCase?.sessionScope === "string" && workflowCase.sessionScope.trim().length > 0
    ? workflowCase.sessionScope.trim()
    : null;
  return explicit ?? workflowCase.workflow ?? workflowCase.id;
}
