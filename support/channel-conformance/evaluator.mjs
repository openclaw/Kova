import { expectedFinalDeliveries } from "./final-deliveries.mjs";

export function evaluateWorkflowCase({
  workflowCase,
  observations,
  providerRequestsDelta,
  providerRequestsAfterEcho
}) {
  const expects = objectOrEmpty(workflowCase.expects);
  const finalVisible = expectedFinalDeliveries(workflowCase, observations);
  const expectedVisible = Number.isInteger(expects.visibleDeliveries) ? expects.visibleDeliveries : 1;
  const expectsVisibleDelivery = expectedVisible > 0;
  const expectedText = typeof expects.text === "string" ? expects.text : null;
  const providerPolicy = objectOrEmpty(workflowCase.providerRequests);
  const nativeActions = objectOrEmpty(expects.nativeActions);
  return [
    invariant(`${workflowCase.id}:provider-work`, providerRequestsMatch(providerPolicy, providerRequestsDelta), providerRequestReason(workflowCase.id, providerPolicy, providerRequestsDelta)),
    invariant(`${workflowCase.id}:visible-delivery-count`, finalVisible.length === expectedVisible, `${workflowCase.id} produced ${expectedVisible} final visible delivery; observed ${finalVisible.length}`),
    invariant(`${workflowCase.id}:expected-kind`, expectedVisible === 0 || expectedKindMatches(expects.kind, finalVisible), `${workflowCase.id} produced ${expects.kind ?? "visible"} output`),
    invariant(`${workflowCase.id}:expected-text`, !expectedText || finalVisible.some((delivery) => deliveryText(delivery).includes(expectedText)), `${workflowCase.id} preserved expected text or caption`),
    invariant(`${workflowCase.id}:native-actions`, nativeActionsMatch(nativeActions, observations), nativeActionsReason(workflowCase.id, nativeActions, observations)),
    invariant(`${workflowCase.id}:route`, !expectsVisibleDelivery || !requiresRoutePreservation(workflowCase) || finalVisible.every((delivery) => delivery.route?.key === observations.inbound?.route?.key), `${workflowCase.id} preserved the inbound route`),
    invariant(`${workflowCase.id}:reply-target`, !expectsVisibleDelivery || !requiresReplyPreservation(workflowCase) || finalVisible.some((delivery) => delivery.replyTo?.key === observations.inbound?.messageKey), replyTargetReason(workflowCase.id, observations, finalVisible)),
    invariant(`${workflowCase.id}:silent`, expects.silent !== true || finalVisible.every((delivery) => delivery.silent === true), `${workflowCase.id} preserved silent delivery intent`),
    invariant(`${workflowCase.id}:media-present`, expects.kind !== "media" || finalVisible.some((delivery) => delivery.kind === "media" && delivery.media?.some((media) => media.present)), `${workflowCase.id} delivered media through a native media send`),
    invariant(`${workflowCase.id}:native-message-proof`, expectedVisible === 0 || finalVisible.every((delivery) => Array.isArray(delivery.nativeMessages) && delivery.nativeMessages.length > 0), `${workflowCase.id} linked logical delivery to native platform message proof`),
    invariant(`${workflowCase.id}:unmatched-native-visible-sends`, unmatchedNativeVisibleSends(observations).length === 0, unmatchedNativeVisibleReason(workflowCase.id, observations)),
    invariant(`${workflowCase.id}:no-duplicate-final`, expects.allowMultipleFinalSends === true || finalVisible.length <= expectedVisible, `${workflowCase.id} did not duplicate visible final delivery`),
    invariant(`${workflowCase.id}:no-self-trigger`, expects.noSelfTrigger !== true || providerRequestsAfterEcho === 0, `${workflowCase.id} did not start provider work from bot-authored channel echo`)
  ];
}

function requiresRoutePreservation(workflowCase) {
  return ["thread", "reply-thread"].includes(workflowCase.matrix?.route) ||
    objectOrEmpty(workflowCase.expects).threadId != null;
}

function requiresReplyPreservation(workflowCase) {
  return ["reply", "reply-thread"].includes(workflowCase.matrix?.route) ||
    objectOrEmpty(workflowCase.expects).replyTo === "inbound-message";
}

function replyTargetReason(caseId, observations, finalVisible) {
  const expected = observations.inbound?.messageKey;
  const observed = finalVisible
    .map((delivery) => delivery.replyTo?.key)
    .filter((value) => typeof value === "string" && value.length > 0);
  if (!expected) {
    return `${caseId} has no inbound reply target to preserve`;
  }
  if (observed.length === 0) {
    return `${caseId} expected reply target ${expected}; observed no reply target on final delivery`;
  }
  return `${caseId} expected reply target ${expected}; observed ${observed.join(", ")}`;
}

function expectedKindMatches(expectedKind, visible) {
  if (!expectedKind) {
    return visible.length > 0;
  }
  if (expectedKind === "text") {
    return visible.some((delivery) => delivery.kind === "text");
  }
  if (expectedKind === "media") {
    return visible.some((delivery) => delivery.kind === "media");
  }
  if (expectedKind === "poll") {
    return visible.some((delivery) => delivery.kind === "poll");
  }
  if (expectedKind === "payload") {
    return visible.length > 0;
  }
  return visible.length > 0;
}

function nativeActionsMatch(expected, observations) {
  const entries = Object.entries(expected);
  if (entries.length === 0) {
    return true;
  }
  const byAction = objectOrEmpty(observations?.nativeCallSummary?.byAction);
  return entries.every(([action, count]) => Number(byAction[action] ?? 0) >= count);
}

function nativeActionsReason(caseId, expected, observations) {
  const entries = Object.entries(expected);
  if (entries.length === 0) {
    return `${caseId} has no native action expectation`;
  }
  const byAction = objectOrEmpty(observations?.nativeCallSummary?.byAction);
  const expectedText = entries.map(([action, count]) => `${action}:${count}`).join(", ");
  const observedText = entries.map(([action]) => `${action}:${byAction[action] ?? 0}`).join(", ");
  return `${caseId} made at least expected native platform actions (${expectedText}); observed ${observedText}`;
}

function deliveryText(delivery) {
  return [delivery.text, delivery.caption]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function unmatchedNativeVisibleSends(observations) {
  return (Array.isArray(observations?.unmatchedNativeMessages) ? observations.unmatchedNativeMessages : [])
    .filter((message) => message.visible === true);
}

function unmatchedNativeVisibleReason(caseId, observations) {
  const unmatched = unmatchedNativeVisibleSends(observations);
  if (unmatched.length === 0) {
    return `${caseId} had no unmatched native visible platform sends`;
  }
  const methods = unmatched.map((message) => message.method).join(", ");
  return `${caseId} had unmatched native visible platform sends: ${methods}`;
}

function providerRequestsMatch(policy, observed) {
  if (policy.mode === "minimum") {
    return observed >= expectedProviderMinimum(policy);
  }
  if (Number.isInteger(policy.exact)) {
    return observed === policy.exact;
  }
  return observed > 0;
}

function expectedProviderMinimum(policy) {
  return Number.isInteger(policy.min) ? policy.min : 1;
}

function providerRequestReason(caseId, policy, observed) {
  if (policy.mode === "minimum") {
    return `${caseId} made at least ${expectedProviderMinimum(policy)} provider request(s); observed ${observed}`;
  }
  if (Number.isInteger(policy.exact)) {
    return `${caseId} made exactly ${policy.exact} provider request(s); observed ${observed}`;
  }
  return `${caseId} made provider requests through OpenClaw; observed ${observed}`;
}

function invariant(id, passed, summary) {
  return {
    id,
    status: passed ? "passed" : "failed",
    summary,
    reason: passed ? null : summary
  };
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
