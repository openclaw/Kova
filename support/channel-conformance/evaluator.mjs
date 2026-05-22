import { basename } from "node:path";
import { expectedFinalDeliveries } from "./final-deliveries.mjs";

export function evaluateWorkflowCase({
  workflowCase,
  observations,
  providerRequestsDelta,
  providerRequestsAfterEcho
}) {
  const expects = objectOrEmpty(workflowCase.expects);
  const visibleDeliveries = allVisibleDeliveries(observations);
  const finalVisible = expectedFinalDeliveries(workflowCase, observations);
  const expectedVisible = Number.isInteger(expects.visibleDeliveries) ? expects.visibleDeliveries : 1;
  const expectsVisibleDelivery = expectedVisible > 0;
  const expectedText = typeof expects.text === "string" ? expects.text : null;
  const providerPolicy = objectOrEmpty(workflowCase.providerRequests);
  const nativeActions = objectOrEmpty(expects.nativeActions);
  const unmatchedNative = unmatchedNativeVisibleSends(workflowCase, observations, finalVisible, visibleDeliveries);
  return [
    invariant(`${workflowCase.id}:provider-work`, providerRequestsMatch(providerPolicy, providerRequestsDelta), providerRequestReason(workflowCase.id, providerPolicy, providerRequestsDelta)),
    invariant(`${workflowCase.id}:visible-delivery-count`, finalVisible.length === expectedVisible, `${workflowCase.id} produced ${expectedVisible} final visible delivery; observed ${finalVisible.length}`),
    invariant(`${workflowCase.id}:expected-kind`, expectedVisible === 0 || expectedKindMatches(expects.kind, finalVisible), `${workflowCase.id} produced ${expects.kind ?? "visible"} output`),
    invariant(`${workflowCase.id}:expected-text`, !expectedText || visibleDeliveries.some((delivery) => deliveryText(delivery).includes(expectedText)), `${workflowCase.id} preserved expected text or caption`),
    invariant(`${workflowCase.id}:native-actions`, nativeActionsMatch(nativeActions, observations), nativeActionsReason(workflowCase.id, nativeActions, observations)),
    invariant(`${workflowCase.id}:inbound-media`, inboundMediaMatches(workflowCase, observations), inboundMediaReason(workflowCase.id, workflowCase, observations)),
    invariant(`${workflowCase.id}:route`, !expectsVisibleDelivery || !requiresRoutePreservation(workflowCase) || finalVisible.every((delivery) => delivery.route?.key === observations.inbound?.route?.key), `${workflowCase.id} preserved the inbound route`),
    invariant(`${workflowCase.id}:reply-target`, !expectsVisibleDelivery || !requiresReplyPreservation(workflowCase) || replyTargetMatches(workflowCase, observations, finalVisible, visibleDeliveries), replyTargetReason(workflowCase.id, workflowCase, observations, finalVisible, visibleDeliveries)),
    invariant(`${workflowCase.id}:silent`, expects.silent !== true || finalVisible.every((delivery) => delivery.silent === true), `${workflowCase.id} preserved silent delivery intent`),
    invariant(`${workflowCase.id}:media-present`, expects.kind !== "media" || finalVisible.some((delivery) => delivery.kind === "media" && delivery.media?.some((media) => media.present)), `${workflowCase.id} delivered media through a native media send`),
    invariant(`${workflowCase.id}:media-source`, mediaSourceMatches(expects, finalVisible), mediaSourceReason(workflowCase.id, expects, finalVisible)),
    invariant(`${workflowCase.id}:native-message-proof`, expectedVisible === 0 || finalVisible.every((delivery) => Array.isArray(delivery.nativeMessages) && delivery.nativeMessages.length > 0), `${workflowCase.id} linked logical delivery to native platform message proof`),
    invariant(`${workflowCase.id}:unmatched-native-visible-sends`, unmatchedNative.length === 0, unmatchedNativeVisibleReason(workflowCase.id, unmatchedNative)),
    invariant(`${workflowCase.id}:no-duplicate-final`, expects.allowMultipleFinalSends === true || finalVisible.length <= expectedVisible, `${workflowCase.id} did not duplicate visible final delivery`),
    invariant(`${workflowCase.id}:no-self-trigger`, expects.noSelfTrigger !== true || providerRequestsAfterEcho === 0, `${workflowCase.id} did not start provider work from bot-authored channel echo`)
  ];
}

function inboundMediaMatches(workflowCase, observations) {
  const expectedCount = expectedInboundMediaCount(workflowCase);
  if (expectedCount === 0) {
    return true;
  }
  const proof = objectOrEmpty(observations?.inboundMedia);
  const inboundMedia = Array.isArray(observations?.inbound?.media) ? observations.inbound.media : [];
  return inboundMedia.length >= expectedCount &&
    Number(proof.metadataResolvedCount ?? 0) >= expectedCount &&
    Number(proof.contentFetchedCount ?? 0) >= expectedCount;
}

function inboundMediaReason(caseId, workflowCase, observations) {
  const expectedCount = expectedInboundMediaCount(workflowCase);
  if (expectedCount === 0) {
    return `${caseId} has no inbound media expectation`;
  }
  const proof = objectOrEmpty(observations?.inboundMedia);
  const inboundMedia = Array.isArray(observations?.inbound?.media) ? observations.inbound.media : [];
  return `${caseId} resolved inbound media through the channel adapter; expected ${expectedCount}, observed inbound ${inboundMedia.length}, metadata ${Number(proof.metadataResolvedCount ?? 0)}, fetched ${Number(proof.contentFetchedCount ?? 0)}`;
}

function expectedInboundMediaCount(workflowCase) {
  return workflowCase?.input?.media && typeof workflowCase.input.media === "object" && !Array.isArray(workflowCase.input.media)
    ? 1
    : 0;
}

function requiresRoutePreservation(workflowCase) {
  return ["thread", "reply", "reply-thread"].includes(workflowCase.matrix?.route) ||
    objectOrEmpty(workflowCase.expects).threadId != null;
}

function requiresReplyPreservation(workflowCase) {
  return ["reply", "reply-thread"].includes(workflowCase.matrix?.route) ||
    objectOrEmpty(workflowCase.expects).replyTo === "inbound-message";
}

function replyTargetMatches(workflowCase, observations, finalVisible, visibleDeliveries) {
  const expected = observations.inbound?.messageKey;
  if (!expected) {
    return false;
  }
  if (requiresEveryFinalReplyTarget(workflowCase)) {
    return finalVisible.every((delivery) => delivery.replyTo?.key === expected);
  }
  return visibleDeliveries.some((delivery) => delivery.replyTo?.key === expected);
}

function requiresEveryFinalReplyTarget(workflowCase) {
  const expects = objectOrEmpty(workflowCase.expects);
  if (expects.replyTargetPolicy === "every-final-delivery") {
    return true;
  }
  if (expects.replyTargetPolicy === "response-group-anchor") {
    return false;
  }
  const expectedVisible = Number.isInteger(expects.visibleDeliveries) ? expects.visibleDeliveries : 1;
  return expectedVisible <= 1 && expects.allowMultipleFinalSends !== true;
}

function allVisibleDeliveries(observations) {
  return (Array.isArray(observations?.deliveries) ? observations.deliveries : [])
    .filter((delivery) => delivery.visible === true);
}

function replyTargetReason(caseId, workflowCase, observations, finalVisible, visibleDeliveries) {
  if (!requiresReplyPreservation(workflowCase)) {
    return `${caseId} does not require reply target preservation`;
  }
  const expected = observations.inbound?.messageKey;
  const scope = requiresEveryFinalReplyTarget(workflowCase) ? "final delivery" : "visible response group";
  const observed = (requiresEveryFinalReplyTarget(workflowCase) ? finalVisible : visibleDeliveries)
    .map((delivery) => delivery.replyTo?.key)
    .filter((value) => typeof value === "string" && value.length > 0);
  if (!expected) {
    return `${caseId} has no inbound reply target to preserve`;
  }
  if (observed.length === 0) {
    return `${caseId} expected reply target ${expected}; observed no reply target on ${scope}`;
  }
  if (requiresEveryFinalReplyTarget(workflowCase) && observed.length < finalVisible.length) {
    return `${caseId} expected reply target ${expected} on ${finalVisible.length} final deliveries; observed ${observed.join(", ")}`;
  }
  return `${caseId} expected reply target ${expected} on ${scope}; observed ${observed.join(", ")}`;
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

function unmatchedNativeVisibleSends(workflowCase, observations, finalVisible, visibleDeliveries) {
  const explicitUnmatched = (Array.isArray(observations?.unmatchedNativeMessages) ? observations.unmatchedNativeMessages : [])
    .filter((message) => message.visible === true);
  const deliveryUnmatched = unexpectedVisibleDeliveries(workflowCase, finalVisible, visibleDeliveries)
    .flatMap((delivery) => Array.isArray(delivery.nativeMessages) ? delivery.nativeMessages : [])
    .filter((message) => message.visible === true);
  return [...explicitUnmatched, ...deliveryUnmatched];
}

function unmatchedNativeVisibleReason(caseId, unmatched) {
  if (unmatched.length === 0) {
    return `${caseId} had no unmatched native visible platform sends`;
  }
  const methods = unmatched.map((message) => message.method).join(", ");
  return `${caseId} had unmatched native visible platform sends: ${methods}`;
}

function unexpectedVisibleDeliveries(workflowCase, finalVisible, visibleDeliveries) {
  const finalSet = new Set(finalVisible);
  let companionTextAllowed = allowsCompanionTextDelivery(workflowCase);
  return visibleDeliveries.filter((delivery) => {
    if (finalSet.has(delivery)) {
      return false;
    }
    if (companionTextAllowed && isCompanionTextDelivery(workflowCase, delivery)) {
      companionTextAllowed = false;
      return false;
    }
    return true;
  });
}

function allowsCompanionTextDelivery(workflowCase) {
  const expects = objectOrEmpty(workflowCase.expects);
  return expects.kind === "media" && typeof expects.text === "string" && expects.text.length > 0;
}

function isCompanionTextDelivery(workflowCase, delivery) {
  const expectedText = objectOrEmpty(workflowCase.expects).text;
  return delivery?.kind === "text" &&
    typeof expectedText === "string" &&
    deliveryText(delivery).includes(expectedText);
}

function mediaSourceMatches(expects, finalVisible) {
  const policy = typeof expects.mediaSourcePolicy === "string" ? expects.mediaSourcePolicy : null;
  const expectedSources = expectedMediaSources(expects);
  if (!policy && expectedSources.length === 0) {
    return true;
  }
  const observed = observedMedia(finalVisible).filter((media) => media.present === true);
  if (policy === "exact") {
    return expectedSources.length > 0 &&
      expectedSources.every((source) => observed.some((media) => mediaMatchesExpectedSource(media, source, expects)));
  }
  return observed.length > 0;
}

function mediaSourceReason(caseId, expects, finalVisible) {
  const policy = typeof expects.mediaSourcePolicy === "string" ? expects.mediaSourcePolicy : null;
  const expectedSources = expectedMediaSources(expects);
  if (!policy && expectedSources.length === 0) {
    return `${caseId} has no media source expectation`;
  }
  const observed = observedMedia(finalVisible)
    .map(mediaSourceLabel)
    .filter((value) => value.length > 0);
  if (policy === "exact") {
    return `${caseId} delivered expected media source(s) ${expectedSources.map((source) => basename(source)).join(", ")}; observed ${observed.join(", ") || "none"}`;
  }
  return `${caseId} delivered present media source through native channel send; observed ${observed.join(", ") || "none"}`;
}

function expectedMediaSources(expects) {
  const sources = [];
  if (typeof expects.mediaSource === "string" && expects.mediaSource.length > 0) {
    sources.push(expects.mediaSource);
  }
  if (Array.isArray(expects.mediaSources)) {
    for (const source of expects.mediaSources) {
      if (typeof source === "string" && source.length > 0) {
        sources.push(source);
      }
    }
  }
  return sources;
}

function observedMedia(finalVisible) {
  return finalVisible.flatMap((delivery) => Array.isArray(delivery.media) ? delivery.media : []);
}

function mediaMatchesExpectedSource(media, expectedSource, expects) {
  const expectedName = basename(expectedSource);
  const expectedProof = expectedMediaSourceProof(expects, expectedSource);
  const candidates = [
    media.sourceRef,
    media.sourceName,
    media.sourceUrl,
    media.source
  ].filter((value) => typeof value === "string" && value.length > 0);
  return candidates.some((candidate) =>
    candidate === expectedSource ||
    candidate === expectedName ||
    candidate.includes(expectedSource) ||
    candidate.includes(expectedName)
  ) ||
    (expectedProof?.sha256 && media.sourceSha256 === expectedProof.sha256) ||
    (expectedProof?.fingerprint && media.sourceFingerprint === expectedProof.fingerprint);
}

function mediaSourceLabel(media) {
  return [media.sourceName, media.sourceRef, media.sourceUrl, media.sourceSha256, media.sourceFingerprint, media.source]
    .find((value) => typeof value === "string" && value.length > 0) ?? "";
}

function expectedMediaSourceProof(expects, expectedSource) {
  const proofs = Array.isArray(expects.mediaSourceProofs) ? expects.mediaSourceProofs : [];
  return proofs.find((proof) =>
    proof?.source === expectedSource ||
    proof?.path === expectedSource ||
    proof?.name === basename(expectedSource)
  ) ?? null;
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
