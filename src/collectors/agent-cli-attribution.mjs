import {
  buildPreProviderAttribution,
  preProviderMarkdownRows,
  summarizePreProviderAttributions
} from "./pre-provider-attribution.mjs";

export const AGENT_CLI_PRE_PROVIDER_ATTRIBUTION_SCHEMA = "kova.agentCliPreProviderAttribution.v1";
export const AGENT_CLI_PRE_PROVIDER_SUMMARY_SCHEMA = "kova.agentCliPreProviderAttributionSummary.v1";

export function buildAgentCliPreProviderAttribution({
  label,
  phaseId,
  activeStartedAtEpochMs,
  activeFinishedAtEpochMs,
  attribution,
  timelineSummary
}) {
  return buildPreProviderAttribution({
    schemaVersion: AGENT_CLI_PRE_PROVIDER_ATTRIBUTION_SCHEMA,
    label,
    phaseId,
    activeStartedAtEpochMs,
    activeFinishedAtEpochMs,
    attribution,
    timelineSummary,
    isAttributedSpanName: isAgentCliAttributedSpanName,
    missingEventsError: "timeline contains no agent CLI attribution events"
  });
}

export function summarizeAgentCliPreProviderAttributions(turns) {
  return summarizePreProviderAttributions({
    schemaVersion: AGENT_CLI_PRE_PROVIDER_SUMMARY_SCHEMA,
    turns,
    fieldName: "agentCliPreProviderAttribution"
  });
}

export function agentCliPreProviderMarkdownRows(turns) {
  return preProviderMarkdownRows({
    title: "Agent CLI pre-provider attribution",
    turns,
    fieldName: "agentCliPreProviderAttribution"
  });
}

function isAgentCliAttributedSpanName(name) {
  const text = String(name ?? "");
  return text === "agent.prepare" ||
    text === "plugins.metadata.scan" ||
    text === "runtimeDeps.stage" ||
    text === "channel.capabilities" ||
    text === "models.catalog" ||
    text.startsWith("models.catalog.") ||
    text.startsWith("models.discovery") ||
    text.startsWith("channel.plugin.");
}
