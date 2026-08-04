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
    isAttributedSpan: isGatewaySessionAttributedSpan,
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
  return collectAttributedSpanIntervals(events, isGatewaySessionAttributedSpan);
}

function isGatewaySessionAttributedSpan(event) {
  const name = String(event?.name ?? "");
  return name === "plugins.metadata.scan" ||
    name.startsWith("gateway.chat_send") ||
    name.startsWith("auto_reply") ||
    name.startsWith("reply.");
}

function includeGatewaySessionSpanInWindow(span, { windowStartEpochMs, windowEndEpochMs }) {
  if (span.name !== "plugins.metadata.scan") {
    return true;
  }
  return span.endEpochMs >= windowStartEpochMs && span.endEpochMs <= windowEndEpochMs;
}
