import {
  attributedSpanIntervals as collectAttributedSpanIntervals,
  buildPreProviderAttribution,
  preProviderMarkdownRows,
  summarizePreProviderAttributions
} from "./pre-provider-attribution.mjs";

export const GATEWAY_SESSION_PRE_PROVIDER_ATTRIBUTION_SCHEMA = "kova.gatewaySessionPreProviderAttribution.v1";
export const GATEWAY_SESSION_PRE_PROVIDER_SUMMARY_SCHEMA = "kova.gatewaySessionPreProviderAttributionSummary.v1";

export function buildGatewaySessionPreProviderAttribution({
  label,
  phaseId,
  activeStartedAtEpochMs,
  activeFinishedAtEpochMs,
  attribution,
  timelineSummary
}) {
  return buildPreProviderAttribution({
    schemaVersion: GATEWAY_SESSION_PRE_PROVIDER_ATTRIBUTION_SCHEMA,
    label,
    phaseId,
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    attribution,
    timelineSummary,
    isAttributedSpanName: isGatewaySessionAttributedSpanName,
    shouldIncludeSpan: includeGatewaySessionSpanInWindow,
    missingEventsError: "timeline contains no Gateway session turn attribution events"
  });
}

export function summarizeGatewaySessionPreProviderAttributions(turns) {
  return summarizePreProviderAttributions({
    schemaVersion: GATEWAY_SESSION_PRE_PROVIDER_SUMMARY_SCHEMA,
    turns,
    fieldName: "gatewaySessionPreProviderAttribution"
  });
}

export function gatewaySessionPreProviderMarkdownRows(turns) {
  return preProviderMarkdownRows({
    title: "Gateway session pre-provider attribution",
    turns,
    fieldName: "gatewaySessionPreProviderAttribution"
  });
}

export function attributedSpanIntervals(events) {
  return collectAttributedSpanIntervals(events, isGatewaySessionAttributedSpanName);
}

function isGatewaySessionAttributedSpanName(name) {
  const text = String(name ?? "");
  return text === "plugins.metadata.scan" ||
    text.startsWith("gateway.chat_send") ||
    text.startsWith("auto_reply") ||
    text.startsWith("reply.");
}

function includeGatewaySessionSpanInWindow(span, { windowStartEpochMs, windowEndEpochMs }) {
  if (span.name !== "plugins.metadata.scan") {
    return true;
  }
  return span.endEpochMs >= windowStartEpochMs && span.endEpochMs <= windowEndEpochMs;
}
