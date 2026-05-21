export function evaluateWorkflowCase({
  workflowCase,
  observations,
  providerRequestsDelta,
  providerRequestsAfterEcho
}) {
  const expects = objectOrEmpty(workflowCase.expects);
  const deliveries = Array.isArray(observations?.deliveries) ? observations.deliveries : [];
  const visible = deliveries.filter((delivery) => delivery.visible === true);
  const expectedVisible = Number.isInteger(expects.visibleDeliveries) ? expects.visibleDeliveries : 1;
  const expectedText = typeof expects.text === "string" ? expects.text : null;
  const providerPolicy = objectOrEmpty(workflowCase.providerRequests);
  return [
    invariant(`${workflowCase.id}:provider-work`, providerRequestsMatch(providerPolicy, providerRequestsDelta), providerRequestReason(workflowCase.id, providerPolicy, providerRequestsDelta)),
    invariant(`${workflowCase.id}:visible-delivery-count`, visible.length === expectedVisible, `${workflowCase.id} produced ${expectedVisible} visible delivery; observed ${visible.length}`),
    invariant(`${workflowCase.id}:expected-kind`, expectedKindMatches(expects.kind, visible), `${workflowCase.id} produced ${expects.kind ?? "visible"} output`),
    invariant(`${workflowCase.id}:expected-text`, !expectedText || visible.some((delivery) => deliveryText(delivery).includes(expectedText)), `${workflowCase.id} preserved expected text or caption`),
    invariant(`${workflowCase.id}:route`, !requiresRoutePreservation(workflowCase) || visible.every((delivery) => delivery.route?.key === observations.inbound?.route?.key), `${workflowCase.id} preserved the inbound route`),
    invariant(`${workflowCase.id}:reply-target`, !requiresReplyPreservation(workflowCase) || visible.some((delivery) => delivery.replyTo?.key === observations.inbound?.messageKey), `${workflowCase.id} preserved the reply target`),
    invariant(`${workflowCase.id}:silent`, expects.silent !== true || visible.every((delivery) => delivery.silent === true), `${workflowCase.id} preserved silent delivery intent`),
    invariant(`${workflowCase.id}:media-present`, expects.kind !== "media" || visible.some((delivery) => delivery.kind === "media" && delivery.media?.some((media) => media.present)), `${workflowCase.id} delivered media through a native media send`),
    invariant(`${workflowCase.id}:no-duplicate-final`, expects.allowMultipleFinalSends === true || visible.length <= expectedVisible, `${workflowCase.id} did not duplicate visible final delivery`),
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
  if (expectedKind === "payload") {
    return visible.length > 0;
  }
  return visible.length > 0;
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
