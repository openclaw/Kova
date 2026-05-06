import {
  attributedSpanIntervals as collectAttributedSpanIntervals,
  buildPreProviderAttribution,
  preProviderMarkdownRows,
  summarizePreProviderAttributions
} from "./pre-provider-attribution.mjs";

export const DASHBOARD_PRE_PROVIDER_ATTRIBUTION_SCHEMA = "kova.dashboardPreProviderAttribution.v1";
export const DASHBOARD_PRE_PROVIDER_SUMMARY_SCHEMA = "kova.dashboardPreProviderAttributionSummary.v1";

export function buildDashboardPreProviderAttribution({
  label,
  phaseId,
  activeStartedAtEpochMs,
  activeFinishedAtEpochMs,
  attribution,
  timelineSummary
}) {
  return buildPreProviderAttribution({
    schemaVersion: DASHBOARD_PRE_PROVIDER_ATTRIBUTION_SCHEMA,
    label,
    phaseId,
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    attribution,
    timelineSummary,
    isAttributedSpanName: isDashboardAttributedSpanName,
    missingEventsError: "timeline contains no dashboard turn attribution events"
  });
}

export function summarizeDashboardPreProviderAttributions(turns) {
  return summarizePreProviderAttributions({
    schemaVersion: DASHBOARD_PRE_PROVIDER_SUMMARY_SCHEMA,
    turns,
    fieldName: "dashboardPreProviderAttribution"
  });
}

export function dashboardPreProviderMarkdownRows(turns) {
  return preProviderMarkdownRows({
    title: "Dashboard pre-provider attribution",
    turns,
    fieldName: "dashboardPreProviderAttribution"
  });
}

export function attributedSpanIntervals(events) {
  return collectAttributedSpanIntervals(events, isDashboardAttributedSpanName);
}

function isDashboardAttributedSpanName(name) {
  const text = String(name ?? "");
  return text.startsWith("gateway.chat_send") ||
    text.startsWith("auto_reply") ||
    text.startsWith("reply.");
}
