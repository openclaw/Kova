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
  const nativeCalls = objectOrEmpty(expects.nativeCalls);
  return [
    invariant(`${workflowCase.id}:provider-work`, providerRequestsMatch(providerPolicy, providerRequestsDelta), providerRequestReason(workflowCase.id, providerPolicy, providerRequestsDelta)),
    invariant(`${workflowCase.id}:visible-delivery-count`, finalVisible.length === expectedVisible, `${workflowCase.id} produced ${expectedVisible} final visible delivery; observed ${finalVisible.length}`),
    invariant(`${workflowCase.id}:expected-kind`, expectedVisible === 0 || expectedKindMatches(expects.kind, finalVisible), `${workflowCase.id} produced ${expects.kind ?? "visible"} output`),
    invariant(`${workflowCase.id}:expected-text`, !expectedText || finalVisible.some((delivery) => deliveryText(delivery).includes(expectedText)), `${workflowCase.id} preserved expected text or caption`),
    invariant(`${workflowCase.id}:native-calls`, nativeCallsMatch(nativeCalls, observations), nativeCallsReason(workflowCase.id, nativeCalls, observations)),
    invariant(`${workflowCase.id}:route`, !expectsVisibleDelivery || !requiresRoutePreservation(workflowCase) || finalVisible.every((delivery) => delivery.route?.key === observations.inbound?.route?.key), `${workflowCase.id} preserved the inbound route`),
    invariant(`${workflowCase.id}:reply-target`, !expectsVisibleDelivery || !requiresReplyPreservation(workflowCase) || finalVisible.some((delivery) => delivery.replyTo?.key === observations.inbound?.messageKey), `${workflowCase.id} preserved the reply target`),
    invariant(`${workflowCase.id}:silent`, expects.silent !== true || finalVisible.every((delivery) => delivery.silent === true), `${workflowCase.id} preserved silent delivery intent`),
    invariant(`${workflowCase.id}:media-present`, expects.kind !== "media" || finalVisible.some((delivery) => delivery.kind === "media" && delivery.media?.some((media) => media.present)), `${workflowCase.id} delivered media through a native media send`),
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

function nativeCallsMatch(expected, observations) {
  const entries = Object.entries(expected);
  if (entries.length === 0) {
    return true;
  }
  const byMethod = objectOrEmpty(observations?.nativeCallSummary?.byMethod);
  return entries.every(([method, count]) => Number(byMethod[method] ?? 0) >= count);
}

function nativeCallsReason(caseId, expected, observations) {
  const entries = Object.entries(expected);
  if (entries.length === 0) {
    return `${caseId} has no native call expectation`;
  }
  const byMethod = objectOrEmpty(observations?.nativeCallSummary?.byMethod);
  const expectedText = entries.map(([method, count]) => `${method}:${count}`).join(", ");
  const observedText = entries.map(([method]) => `${method}:${byMethod[method] ?? 0}`).join(", ");
  return `${caseId} made at least expected native platform calls (${expectedText}); observed ${observedText}`;
}

function deliveryText(delivery) {
  return [delivery.text, delivery.caption]
    .filter((value) => typeof value === "string")
    .join("\n");
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
