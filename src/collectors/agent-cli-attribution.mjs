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
    isAttributedSpan: isAgentCliAttributedSpan,
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

function isAgentCliAttributedSpan(event) {
  const name = String(event?.name ?? "");
  const phase = String(event?.phase ?? "");
  return phase === "cli.startup" ||
    phase === "cli.command-startup" ||
    phase === "agent.startup" ||
    name === "agent.prepare" ||
    name === "plugins.metadata.scan" ||
    name === "runtimeDeps.stage" ||
    name === "channel.capabilities" ||
    name === "models.catalog" ||
    name.startsWith("models.catalog.") ||
    name.startsWith("models.discovery") ||
    name.startsWith("channel.plugin.");
}
