import { buildReleaseRuntimeStartupEvidenceInvariants } from "./release-runtime-startup.mjs";
import {
  commonResourceProofOk,
  commonResourceProofReason,
  commonTimelineProofOk,
  commonTimelineProofReason,
  compareSnapshotCountInvariant,
  compareSnapshotEqualityInvariant,
  compareSnapshotSetInvariant,
  findCommandResult,
  findCommandResultInPhase,
  findSnapshotResult,
  nonNegativeNumber,
  numberOrNull,
  parseJsonObject,
  phaseCommandReceiptsOk,
  phaseCommandReceiptsReason,
  phaseMetrics,
  releaseStartupLogArtifactPath,
  releaseStartupLogsOk,
  releaseStartupLogsReason,
  sortedUnique,
  unionStrings,
  zeroCountInvariant
} from "./shared.mjs";
export function attachEvidenceInvariants(record, scenario) {
  const invariants = [];
  if (scenario.surface === "upgrade-existing-user") {
    invariants.push(...buildUpgradeStateSnapshotInvariants(record));
    invariants.push(...buildUpgradeLogDerivedInvariants(record));
  }
  if (scenario.surface === "gateway-session-send-turn") {
    invariants.push(...buildGatewaySessionEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "agent-cli-local-turn") {
    invariants.push(...buildAgentCliLocalTurnEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "agent-gateway-rpc-turn") {
    invariants.push(...buildAgentGatewayRpcTurnEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "release-runtime-startup") {
    invariants.push(...buildReleaseRuntimeStartupEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "official-plugin-install") {
    invariants.push(...buildOfficialPluginInstallEvidenceInvariants(record, scenario));
  }
  if (invariants.length > 0) {
    record.evidenceInvariants = invariants;
  }
  return record;
}

export function buildAgentGatewayRpcTurnEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const turns = record.measurements?.agentTurns ?? [];
  const expectedTurnCount = agentTurnExpectedCount(scenario, turns);
  const health = record.measurements?.health ?? {};
  const providerEvidence = record.providerEvidence ?? {};
  const providerArtifacts = Array.isArray(providerEvidence.artifacts) ? providerEvidence.artifacts : [];
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;
  const providerTimeoutMentions = record.measurements?.providerTimeoutMentions;
  const logArtifactPath = releaseStartupLogArtifactPath(record);

  return [
    {
      id: "agent-gateway-command-receipts",
      phaseId: "post-agent-health",
      required: true,
      status: phaseCommandReceiptsOk(record) ? "passed" : "missing",
      summary: "gateway RPC agent provision, service, turn, status, log, and collector command receipts were captured",
      artifactPath: null,
      reason: phaseCommandReceiptsReason(record)
    },
    {
      id: "agent-gateway-runtime-binding-proof",
      phaseId: "gateway-start",
      required: true,
      status: agentGatewayRuntimeBindingOk(record) ? "passed" : "missing",
      summary: "Gateway-backed agent run captured runtime release binding and gateway port metadata",
      artifactPath: null,
      reason: agentGatewayRuntimeBindingReason(record)
    },
    {
      id: "agent-gateway-readiness-health-proof",
      phaseId: "gateway-start",
      required: true,
      status: gatewaySessionHealthOk(record, health) ? "passed" : "missing",
      summary: "Gateway readiness, post-ready health, and final service state were measured",
      artifactPath: null,
      reason: gatewaySessionHealthReason(record, health)
    },
    {
      id: "agent-gateway-rpc-transport-proof",
      phaseId: "gateway-agent-turn",
      required: true,
      status: agentGatewayRpcTransportOk(turns, expectedTurnCount) ? "passed" : "failed",
      summary: "agent turn used the Gateway-backed CLI path without the local embedded-agent flag",
      artifactPath: null,
      reason: agentGatewayRpcTransportReason(turns, expectedTurnCount)
    },
    {
      id: "agent-gateway-response-proof",
      phaseId: "gateway-agent-turn",
      required: true,
      status: agentTurnBehaviorOk(turns, scenario, expectedTurnCount) ? "passed" : "failed",
      summary: "Gateway-backed agent turn produced the expected assistant marker",
      artifactPath: null,
      reason: agentTurnBehaviorReason(turns, scenario, expectedTurnCount)
    },
    {
      id: "agent-gateway-provider-proof",
      phaseId: "gateway-agent-turn",
      required: true,
      status: agentProviderProofOk(providerEvidence, turns, scenario, expectedTurnCount) ? "passed" : "missing",
      summary: "mock provider request/response evidence was captured and attributed to the Gateway-backed agent turn",
      artifactPath: providerEvidence.summaryPath ?? providerArtifacts[0] ?? null,
      reason: agentProviderProofReason(providerEvidence, turns, scenario, expectedTurnCount)
    },
    {
      id: "agent-gateway-latency-windows",
      phaseId: "gateway-agent-turn",
      required: true,
      status: agentTurnLatencyOk(turns, scenario, expectedTurnCount) ? "passed" : "missing",
      summary: "Gateway-backed agent total, pre-provider, provider, and post-provider latency windows were measured",
      artifactPath: null,
      reason: agentTurnLatencyReason(turns, scenario, expectedTurnCount)
    },
    {
      id: "agent-gateway-resource-proof",
      phaseId: "gateway-agent-turn",
      required: true,
      status: agentGatewayResourceProofOk(record.measurements) ? "passed" : "missing",
      summary: "Gateway and agent CLI resource samples with retained sample artifacts were captured",
      artifactPath: record.measurements?.resourceSampleArtifacts?.[0] ?? null,
      reason: agentGatewayResourceProofReason(record.measurements)
    },
    {
      id: "agent-gateway-diagnostic-timeline-proof",
      phaseId: "gateway-agent-turn",
      required: true,
      status: commonTimelineProofOk(record.measurements) ? "passed" : "missing",
      summary: "OpenClaw diagnostic timeline was captured and parsed without errors",
      artifactPath: record.measurements?.openclawTimelineArtifacts?.[0] ?? null,
      reason: commonTimelineProofReason(record.measurements)
    },
    {
      id: "agent-gateway-logs-captured",
      phaseId: "post-agent-health",
      required: true,
      status: logArtifactPath ? "passed" : "missing",
      summary: "bounded gateway logs were captured for dependency and plugin-load checks",
      artifactPath: logArtifactPath,
      reason: logArtifactPath ? null : "log artifact path was not recorded"
    },
    zeroCountInvariant({
      id: "agent-gateway-no-missing-runtime-dependency-errors",
      summary: "Gateway-backed agent logs and command output contain no missing runtime dependency errors",
      actual: missingDependencyErrors,
      metric: "missingDependencyErrors",
      phaseId: "post-agent-health"
    }),
    zeroCountInvariant({
      id: "agent-gateway-no-plugin-load-failures",
      summary: "Gateway-backed agent logs contain no plugin load failures",
      actual: pluginLoadFailures,
      metric: "pluginLoadFailures",
      phaseId: "post-agent-health"
    }),
    zeroCountInvariant({
      id: "agent-gateway-no-provider-timeout-mentions",
      summary: "Gateway-backed agent logs and command output contain no provider timeout mentions",
      actual: providerTimeoutMentions,
      metric: "providerTimeoutMentions",
      phaseId: "post-agent-health"
    })
  ];
}

function agentGatewayRuntimeBindingOk(record) {
  const service = agentGatewayBestServiceMetrics(record);
  return typeof service?.runtimeReleaseVersion === "string" &&
    service.runtimeReleaseVersion.length > 0 &&
    typeof service.runtimeReleaseChannel === "string" &&
    nonNegativeNumber(service.gatewayPort);
}

function agentGatewayRuntimeBindingReason(record) {
  const service = agentGatewayBestServiceMetrics(record);
  if (!service) {
    return "service metrics were not captured";
  }
  if (typeof service.runtimeReleaseVersion !== "string" || service.runtimeReleaseVersion.length === 0) {
    return "runtime release version was not captured";
  }
  if (typeof service.runtimeReleaseChannel !== "string") {
    return "runtime release channel was not captured";
  }
  if (!nonNegativeNumber(service.gatewayPort)) {
    return "gateway port was not captured";
  }
  return null;
}

function agentGatewayBestServiceMetrics(record) {
  const services = [];
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.service) {
      services.push(phase.metrics.service);
    }
  }
  if (record.finalMetrics?.service) {
    services.push(record.finalMetrics.service);
  }
  return services.find((service) => service.gatewayState === "running" && typeof service.runtimeReleaseVersion === "string") ??
    services.find((service) => typeof service.runtimeReleaseVersion === "string") ??
    null;
}

function agentGatewayRpcTransportOk(turns, expectedTurnCount) {
  const scopedTurns = turns.slice(0, expectedTurnCount);
  return scopedTurns.length >= expectedTurnCount &&
    scopedTurns.every((turn) =>
      !commandUsesFlag(turn.command, "--local") &&
      commandUsesToken(turn.command, "agent") &&
      !turn.gatewaySession
    );
}

function agentGatewayRpcTransportReason(turns, expectedTurnCount) {
  if (turns.length < expectedTurnCount) {
    return `expected at least ${expectedTurnCount} agent turn(s), found ${turns.length}`;
  }
  const bad = turns.slice(0, expectedTurnCount).find((turn) =>
    commandUsesFlag(turn.command, "--local") ||
    !commandUsesToken(turn.command, "agent") ||
    turn.gatewaySession
  );
  if (!bad) {
    return null;
  }
  if (commandUsesFlag(bad.command, "--local")) {
    return `${bad.phaseId} command used --local`;
  }
  if (!commandUsesToken(bad.command, "agent")) {
    return `${bad.phaseId} command did not invoke the agent CLI`;
  }
  return `${bad.phaseId} had Gateway session helper transport evidence`;
}

function commandUsesToken(command, token) {
  return new RegExp(`(^|\\s)${escapeRegex(token)}(\\s|$)`).test(command ?? "");
}

function agentGatewayResourceProofOk(measurements) {
  return commonResourceProofOk(measurements) &&
    nonNegativeNumber(measurements?.resourceByRole?.gateway?.peakRssMb) &&
    nonNegativeNumber(measurements?.resourceByRole?.["agent-cli"]?.peakRssMb);
}

function agentGatewayResourceProofReason(measurements) {
  const commonReason = commonResourceProofReason(measurements);
  if (commonReason) {
    return commonReason;
  }
  if (!nonNegativeNumber(measurements?.resourceByRole?.gateway?.peakRssMb)) {
    return "gateway role resource measurements were not captured";
  }
  if (!nonNegativeNumber(measurements?.resourceByRole?.["agent-cli"]?.peakRssMb)) {
    return "agent CLI role resource measurements were not captured";
  }
  return null;
}

export function buildAgentCliLocalTurnEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const turns = record.measurements?.agentTurns ?? [];
  const expectedTurnCount = agentTurnExpectedCount(scenario, turns);
  const providerEvidence = record.providerEvidence ?? {};
  const providerArtifacts = Array.isArray(providerEvidence.artifacts) ? providerEvidence.artifacts : [];
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;
  const providerTimeoutMentions = record.measurements?.providerTimeoutMentions;
  const logArtifactPath = releaseStartupLogArtifactPath(record);

  return [
    {
      id: "agent-cli-command-receipts",
      phaseId: "post-agent-health",
      required: true,
      status: phaseCommandReceiptsOk(record) ? "passed" : "missing",
      summary: "agent CLI provision, turn, status, and collector command receipts were captured",
      artifactPath: null,
      reason: phaseCommandReceiptsReason(record)
    },
    {
      id: "agent-cli-local-transport-proof",
      phaseId: "cold-agent-turn",
      required: true,
      status: agentCliLocalTransportOk(turns, expectedTurnCount) ? "passed" : "failed",
      summary: "agent turns used the local embedded agent CLI path, not Gateway session RPC",
      artifactPath: null,
      reason: agentCliLocalTransportReason(turns, expectedTurnCount)
    },
    {
      id: "agent-cli-response-proof",
      phaseId: "warm-agent-turn",
      required: true,
      status: agentTurnBehaviorOk(turns, scenario, expectedTurnCount) ? "passed" : "failed",
      summary: "agent turns produced the expected assistant marker or expected failure evidence",
      artifactPath: null,
      reason: agentTurnBehaviorReason(turns, scenario, expectedTurnCount)
    },
    {
      id: "agent-cli-provider-proof",
      phaseId: "warm-agent-turn",
      required: true,
      status: agentProviderProofOk(providerEvidence, turns, scenario, expectedTurnCount) ? "passed" : "missing",
      summary: "mock provider request/response evidence was captured and attributed to every successful agent turn",
      artifactPath: providerEvidence.summaryPath ?? providerArtifacts[0] ?? null,
      reason: agentProviderProofReason(providerEvidence, turns, scenario, expectedTurnCount)
    },
    {
      id: "agent-cli-latency-windows",
      phaseId: "warm-agent-turn",
      required: true,
      status: agentTurnLatencyOk(turns, scenario, expectedTurnCount) ? "passed" : "missing",
      summary: "agent total, pre-provider, provider, and post-provider latency windows were measured",
      artifactPath: null,
      reason: agentTurnLatencyReason(turns, scenario, expectedTurnCount)
    },
    {
      id: "agent-cli-no-service-health-proof",
      phaseId: "post-agent-health",
      required: true,
      status: agentCliNoServiceHealthOk(record) ? "passed" : "missing",
      summary: "no-service local agent env state and final health accounting were captured",
      artifactPath: null,
      reason: agentCliNoServiceHealthReason(record)
    },
    {
      id: "agent-cli-resource-proof",
      phaseId: "warm-agent-turn",
      required: true,
      status: agentCliResourceProofOk(record.measurements) ? "passed" : "missing",
      summary: "agent CLI resource samples and retained sample artifacts were captured",
      artifactPath: record.measurements?.resourceSampleArtifacts?.[0] ?? null,
      reason: agentCliResourceProofReason(record.measurements)
    },
    {
      id: "agent-cli-diagnostic-timeline-proof",
      phaseId: "warm-agent-turn",
      required: true,
      status: commonTimelineProofOk(record.measurements) ? "passed" : "missing",
      summary: "OpenClaw diagnostic timeline was captured and parsed without errors",
      artifactPath: record.measurements?.openclawTimelineArtifacts?.[0] ?? null,
      reason: commonTimelineProofReason(record.measurements)
    },
    {
      id: "agent-cli-logs-captured",
      phaseId: "post-agent-health",
      required: true,
      status: logArtifactPath ? "passed" : "missing",
      summary: "bounded gateway or command logs were captured for dependency and plugin-load checks",
      artifactPath: logArtifactPath,
      reason: logArtifactPath ? null : "log artifact path was not recorded"
    },
    zeroCountInvariant({
      id: "agent-cli-no-missing-runtime-dependency-errors",
      summary: "agent CLI logs and command output contain no missing runtime dependency errors",
      actual: missingDependencyErrors,
      metric: "missingDependencyErrors",
      phaseId: "post-agent-health"
    }),
    zeroCountInvariant({
      id: "agent-cli-no-plugin-load-failures",
      summary: "agent CLI logs contain no plugin load failures",
      actual: pluginLoadFailures,
      metric: "pluginLoadFailures",
      phaseId: "post-agent-health"
    }),
    zeroCountInvariant({
      id: "agent-cli-no-provider-timeout-mentions",
      summary: "agent CLI logs and command output contain no provider timeout mentions",
      actual: providerTimeoutMentions,
      metric: "providerTimeoutMentions",
      phaseId: "post-agent-health"
    })
  ];
}

function agentTurnExpectedCount(scenario, turns) {
  if (scenario.id === "agent-cold-warm-message") {
    return 2;
  }
  if (scenario.id === "agent-gateway-rpc-turn") {
    return 1;
  }
  return Math.max(1, turns.length);
}

function agentCliLocalTransportOk(turns, expectedTurnCount) {
  const scopedTurns = turns.slice(0, expectedTurnCount);
  return scopedTurns.length >= expectedTurnCount &&
    scopedTurns.every((turn) => commandUsesFlag(turn.command, "--local") && !turn.gatewaySession);
}

function agentCliLocalTransportReason(turns, expectedTurnCount) {
  if (turns.length < expectedTurnCount) {
    return `expected at least ${expectedTurnCount} agent turn(s), found ${turns.length}`;
  }
  const bad = turns.slice(0, expectedTurnCount).find((turn) => !commandUsesFlag(turn.command, "--local") || turn.gatewaySession);
  if (!bad) {
    return null;
  }
  if (!commandUsesFlag(bad.command, "--local")) {
    return `${bad.phaseId} command did not include --local`;
  }
  return `${bad.phaseId} had Gateway session transport evidence`;
}

function commandUsesFlag(command, flag) {
  return new RegExp(`(^|\\s)${escapeRegex(flag)}(\\s|$)`).test(command ?? "");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentTurnBehaviorOk(turns, scenario, expectedTurnCount) {
  const scopedTurns = turns.slice(0, expectedTurnCount);
  return scopedTurns.length >= expectedTurnCount &&
    scopedTurns.every((turn) => agentTurnExpectedFailure(turn, scenario)
      ? turn.expectedFailureObserved === true
      : turn.responseOk === true && turn.expectedTextPresent === true && typeof turn.responseText === "string" && turn.responseText.length > 0);
}

function agentTurnBehaviorReason(turns, scenario, expectedTurnCount) {
  if (turns.length < expectedTurnCount) {
    return `expected at least ${expectedTurnCount} agent turn(s), found ${turns.length}`;
  }
  const bad = turns.slice(0, expectedTurnCount).find((turn) => {
    if (agentTurnExpectedFailure(turn, scenario)) {
      return turn.expectedFailureObserved !== true;
    }
    return turn.responseOk !== true || turn.expectedTextPresent !== true || typeof turn.responseText !== "string" || turn.responseText.length === 0;
  });
  if (!bad) {
    return null;
  }
  if (agentTurnExpectedFailure(bad, scenario)) {
    return `${bad.phaseId} did not observe the expected agent failure`;
  }
  if (bad.responseOk !== true) {
    return `${bad.phaseId} responseOk was not true`;
  }
  if (bad.expectedTextPresent !== true) {
    return `${bad.phaseId} did not report expected text present`;
  }
  return `${bad.phaseId} response text was missing`;
}

function agentTurnExpectedFailure(turn, scenario) {
  if (turn?.expectedFailure === true || scenario.agent?.expectedFailure === true) {
    return true;
  }
  return (scenario.phases ?? []).some((phase) => phase.id === turn?.phaseId && phase.expectedAgentFailure === true);
}

function agentProviderProofOk(providerEvidence, turns, scenario, expectedTurnCount) {
  const successfulTurns = turns.slice(0, expectedTurnCount).filter((turn) => !agentTurnExpectedFailure(turn, scenario));
  if (successfulTurns.length === 0) {
    return true;
  }
  if (providerEvidence?.available !== true || providerEvidence.requestCount < successfulTurns.length) {
    return false;
  }
  return successfulTurns.every((turn) =>
    turn.missingProviderRequest === false &&
    (turn.requestCount ?? 0) > 0 &&
    turn.providerAfterCommandEnd !== true &&
    turn.providerStatuses.every((status) => !Number.isFinite(Number(status.value)) || Number(status.value) < 400)
  );
}

function agentProviderProofReason(providerEvidence, turns, scenario, expectedTurnCount) {
  const successfulTurns = turns.slice(0, expectedTurnCount).filter((turn) => !agentTurnExpectedFailure(turn, scenario));
  if (successfulTurns.length === 0) {
    return null;
  }
  if (providerEvidence?.available !== true) {
    return providerEvidence?.error ?? "provider evidence was not available";
  }
  if (providerEvidence.requestCount < successfulTurns.length) {
    return `provider request count ${providerEvidence.requestCount ?? 0} was below required ${successfulTurns.length}`;
  }
  const missing = successfulTurns.find((turn) => turn.missingProviderRequest === true || (turn.requestCount ?? 0) === 0);
  if (missing) {
    return `${missing.phaseId} had no attributed provider request`;
  }
  const late = successfulTurns.find((turn) => turn.providerAfterCommandEnd === true);
  if (late) {
    return `${late.phaseId} provider request arrived after command window by ${late.providerLateByMs ?? "unknown"}ms`;
  }
  const failedStatus = successfulTurns.find((turn) =>
    turn.providerStatuses.some((status) => Number.isFinite(Number(status.value)) && Number(status.value) >= 400)
  );
  if (failedStatus) {
    return `${failedStatus.phaseId} had provider HTTP error status evidence`;
  }
  return null;
}

function agentTurnLatencyOk(turns, scenario, expectedTurnCount) {
  const scopedTurns = turns.slice(0, expectedTurnCount);
  return scopedTurns.length >= expectedTurnCount &&
    scopedTurns.every((turn) => {
      if (!nonNegativeNumber(turn.totalTurnMs) || !nonNegativeNumber(turn.rawCommandDurationMs)) {
        return false;
      }
      if (agentTurnExpectedFailure(turn, scenario)) {
        return true;
      }
      return nonNegativeNumber(turn.preProviderMs) &&
        nonNegativeNumber(turn.providerFinalMs) &&
        nonNegativeNumber(turn.postProviderMs);
    });
}

function agentTurnLatencyReason(turns, scenario, expectedTurnCount) {
  if (turns.length < expectedTurnCount) {
    return `expected at least ${expectedTurnCount} agent turn(s), found ${turns.length}`;
  }
  const bad = turns.slice(0, expectedTurnCount).find((turn) => !agentTurnLatencyOk([turn], scenario, 1));
  if (!bad) {
    return null;
  }
  const required = ["totalTurnMs", "rawCommandDurationMs"];
  if (!agentTurnExpectedFailure(bad, scenario)) {
    required.push("preProviderMs", "providerFinalMs", "postProviderMs");
  }
  const missing = required.filter((key) => !nonNegativeNumber(bad[key]));
  return `${bad.phaseId} missing latency field(s): ${missing.join(", ")}`;
}

function agentCliNoServiceHealthOk(record) {
  const final = record.measurements?.health?.final;
  return record.measurements?.finalGatewayState === "disabled" &&
    final?.failureCount === 0 &&
    findCommandResult(record, (result) => result.command?.includes(" -- status"))?.status === 0;
}

function agentCliNoServiceHealthReason(record) {
  if (record.measurements?.finalGatewayState !== "disabled") {
    return `final gateway state was ${record.measurements?.finalGatewayState ?? "missing"}`;
  }
  if (record.measurements?.health?.final?.failureCount !== 0) {
    return `final health failures were ${record.measurements?.health?.final?.failureCount ?? "missing"}`;
  }
  if (findCommandResult(record, (result) => result.command?.includes(" -- status"))?.status !== 0) {
    return "post-agent status command did not pass";
  }
  return null;
}

function agentCliResourceProofOk(measurements) {
  return commonResourceProofOk(measurements) &&
    (nonNegativeNumber(measurements?.resourceByRole?.["agent-cli"]?.peakRssMb) ||
      nonNegativeNumber(measurements?.resourceByRole?.["agent-process"]?.peakRssMb));
}

function agentCliResourceProofReason(measurements) {
  const commonReason = commonResourceProofReason(measurements);
  if (commonReason) {
    return commonReason;
  }
  if (!nonNegativeNumber(measurements?.resourceByRole?.["agent-cli"]?.peakRssMb) &&
    !nonNegativeNumber(measurements?.resourceByRole?.["agent-process"]?.peakRssMb)) {
    return "agent CLI role resource measurements were not captured";
  }
  return null;
}

export function buildOfficialPluginInstallEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const health = record.measurements?.health ?? {};
  const evidence = record.measurements?.officialPluginEvidence ?? {};
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;
  const logsResult = findCommandResult(record, (result) => result.command?.startsWith("ocm logs "));

  return [
    {
      id: "official-plugin-command-receipts",
      phaseId: "install",
      required: true,
      status: officialPluginCommandReceiptsOk(record) ? "passed" : "missing",
      summary: "official plugin provision, install, restart, verification, and log command receipts were captured",
      artifactPath: null,
      reason: officialPluginCommandReceiptsReason(record)
    },
    {
      id: "official-plugin-install-proof",
      phaseId: "install",
      required: true,
      status: officialPluginInstallProofStatus(evidence),
      summary: "required official plugins installed, listed, and refreshed through the user command path",
      artifactPath: evidence.artifactPath ?? null,
      reason: officialPluginInstallProofReason(evidence)
    },
    {
      id: "official-plugin-security-proof",
      phaseId: "install",
      required: true,
      status: officialPluginSecurityStatus(evidence),
      summary: "official plugin install produced no security scanner blocks",
      artifactPath: evidence.artifactPath ?? null,
      reason: officialPluginSecurityReason(evidence)
    },
    {
      id: "official-plugin-readiness-health-proof",
      phaseId: "restart",
      required: true,
      status: officialPluginHealthMissing(record, health) ? "missing" : officialPluginHealthOk(record, health) ? "passed" : "failed",
      summary: "gateway readiness, post-install health, and final service state were measured",
      artifactPath: null,
      reason: officialPluginHealthReason(record, health)
    },
    {
      id: "official-plugin-command-usability-proof",
      phaseId: "post-restart-verify",
      required: true,
      status: nonNegativeNumber(record.measurements?.pluginsListMs) ? "passed" : "missing",
      summary: "post-install plugin list command completed with latency measurement",
      artifactPath: null,
      reason: nonNegativeNumber(record.measurements?.pluginsListMs) ? null : "plugin list latency was not measured"
    },
    {
      id: "official-plugin-resource-proof",
      phaseId: "install",
      required: true,
      status: commonResourceProofOk(record.measurements) ? "passed" : "missing",
      summary: "official plugin install resource samples and retained sample artifacts were captured",
      artifactPath: record.measurements?.resourceSampleArtifacts?.[0] ?? null,
      reason: commonResourceProofReason(record.measurements)
    },
    {
      id: "official-plugin-diagnostic-timeline-proof",
      phaseId: "post-restart-verify",
      required: true,
      status: commonTimelineProofOk(record.measurements) ? "passed" : "missing",
      summary: "OpenClaw diagnostic timeline was captured and parsed without errors",
      artifactPath: record.measurements?.openclawTimelineArtifacts?.[0] ?? null,
      reason: commonTimelineProofReason(record.measurements)
    },
    {
      id: "official-plugin-logs-captured",
      phaseId: "post-restart-verify",
      required: true,
      status: releaseStartupLogsOk(logsResult) ? "passed" : "missing",
      summary: "post-install gateway logs were captured for dependency and plugin-load checks",
      artifactPath: releaseStartupLogArtifactPath(record),
      reason: releaseStartupLogsReason(logsResult)
    },
    zeroCountInvariant({
      id: "official-plugin-no-missing-runtime-dependency-errors",
      summary: "post-install logs and command output contain no missing runtime dependency errors",
      actual: missingDependencyErrors,
      metric: "missingDependencyErrors",
      phaseId: "post-restart-verify"
    }),
    zeroCountInvariant({
      id: "official-plugin-no-plugin-load-failures",
      summary: "post-install logs contain no plugin load failures",
      actual: pluginLoadFailures,
      metric: "pluginLoadFailures",
      phaseId: "post-restart-verify"
    })
  ];
}

function officialPluginCommandReceiptsOk(record) {
  return officialPluginRequiredCommands().every(([_, phaseId, predicate]) => {
    const result = findCommandResultInPhase(record, phaseId, predicate);
    return result?.status === 0 && result.durationMs !== undefined;
  });
}

function officialPluginCommandReceiptsReason(record) {
  for (const [label, phaseId, predicate] of officialPluginRequiredCommands()) {
    const result = findCommandResultInPhase(record, phaseId, predicate);
    if (!result) {
      return `${label} receipt was not captured`;
    }
    if (result.status !== 0) {
      return `${label} exited ${result.status}`;
    }
    if (result.durationMs === undefined) {
      return `${label} duration was not captured`;
    }
  }
  return null;
}

function officialPluginRequiredCommands() {
  return [
    ["ocm start", "provision", (result) => result.command?.startsWith("ocm start ")],
    ["baseline plugins list", "provision", (result) => result.command?.includes(" -- plugins list")],
    ["official plugin install helper", "install", (result) => result.command?.includes("run-official-plugin-install.mjs")],
    ["gateway restart helper", "restart", (result) => result.command?.includes("ensure-gateway-running.mjs")],
    ["service status", "post-restart-verify", (result) => result.command?.startsWith("ocm service status ")],
    ["post-install plugins list", "post-restart-verify", (result) => result.command?.includes(" -- plugins list")],
    ["post-install logs", "post-restart-verify", (result) => result.command?.startsWith("ocm logs ")]
  ];
}

function officialPluginInstallProofStatus(evidence) {
  if (evidence?.available !== true) {
    return "missing";
  }
  return officialPluginInstallProofOk(evidence) ? "passed" : "failed";
}

function officialPluginInstallProofOk(evidence) {
  return evidence?.ok === true &&
    evidence.installed === true &&
    evidence.listed === true &&
    evidence.registryRefreshed === true &&
    (evidence.requiredPluginCount ?? 0) > 0 &&
    (evidence.failedRequiredCount ?? 0) === 0;
}

function officialPluginInstallProofReason(evidence) {
  if (evidence?.available !== true) {
    return "official plugin install helper JSON was not captured";
  }
  if ((evidence.requiredPluginCount ?? 0) <= 0) {
    return "official plugin state had no required plugin proof";
  }
  if ((evidence.failedRequiredCount ?? 0) !== 0) {
    return `failed required official plugin count was ${evidence.failedRequiredCount}`;
  }
  if (evidence.installed !== true) {
    return "one or more official plugin install commands failed";
  }
  if (evidence.listed !== true) {
    return "one or more official plugins were not listed after install";
  }
  if (evidence.registryRefreshed !== true) {
    return "official plugin registry refresh did not succeed";
  }
  if (evidence.ok !== true) {
    return "official plugin helper did not report ok";
  }
  return null;
}

function officialPluginSecurityStatus(evidence) {
  if (evidence?.available !== true) {
    return "missing";
  }
  return (evidence.securityBlockCount ?? 0) === 0 ? "passed" : "failed";
}

function officialPluginSecurityReason(evidence) {
  if (evidence?.available !== true) {
    return "official plugin install helper JSON was not captured";
  }
  if ((evidence.securityBlockCount ?? 0) !== 0) {
    return `security block count was ${evidence.securityBlockCount}`;
  }
  return null;
}

function officialPluginHealthOk(record) {
  const restartReadiness = phaseMetrics(record, "restart")?.readiness;
  const postVerifyHealth = phaseMetrics(record, "post-restart-verify")?.healthSummary;
  const finalHealth = record.measurements?.health?.final;
  return restartReadiness?.classification?.state === "ready" &&
    Number.isFinite(restartReadiness.healthReadyAtMs) &&
    (postVerifyHealth?.count ?? 0) > 0 &&
    (postVerifyHealth?.failureCount ?? 0) === 0 &&
    (finalHealth?.failureCount ?? 0) === 0 &&
    record.measurements?.finalGatewayState === "running";
}

function officialPluginHealthMissing(record) {
  const restartReadiness = phaseMetrics(record, "restart")?.readiness;
  const postVerifyHealth = phaseMetrics(record, "post-restart-verify")?.healthSummary;
  return !restartReadiness ||
    !Number.isFinite(restartReadiness.healthReadyAtMs) ||
    (postVerifyHealth?.count ?? 0) <= 0 ||
    record.measurements?.finalGatewayState === undefined;
}

function officialPluginHealthReason(record) {
  const restartReadiness = phaseMetrics(record, "restart")?.readiness;
  const postVerifyHealth = phaseMetrics(record, "post-restart-verify")?.healthSummary;
  const finalHealth = record.measurements?.health?.final;
  if (!restartReadiness) {
    return "restart readiness measurement was not collected";
  }
  if (restartReadiness.classification?.state !== "ready") {
    return `restart readiness classification was ${restartReadiness.classification?.state ?? "missing"}`;
  }
  if (!Number.isFinite(restartReadiness.healthReadyAtMs)) {
    return "restart health-ready timing was not collected";
  }
  if ((postVerifyHealth?.count ?? 0) <= 0) {
    return "post-restart verification health samples were not collected";
  }
  if ((postVerifyHealth?.failureCount ?? 0) !== 0) {
    return `post-restart verification health failures were ${postVerifyHealth.failureCount}`;
  }
  if ((finalHealth?.failureCount ?? 0) !== 0) {
    return `final health failures were ${finalHealth.failureCount}`;
  }
  if (record.measurements?.finalGatewayState !== "running") {
    return `final gateway state was ${record.measurements?.finalGatewayState ?? "missing"}`;
  }
  return null;
}

export function buildGatewaySessionEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const turns = collectGatewaySessionTurnResults(record);
  const expectedTurnCount = scenario.id === "gateway-session-send-turn" ? 2 : Math.max(1, turns.length);
  const health = record.measurements?.health ?? {};
  const providerEvidence = record.providerEvidence ?? {};
  const agentTurns = record.measurements?.agentTurns ?? [];
  const providerArtifacts = Array.isArray(providerEvidence.artifacts) ? providerEvidence.artifacts : [];
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;

  return [
    {
      id: "gateway-session-turn-json-captured",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => turn.result?.status === 0 && turn.payload)
        ? "passed"
        : "missing",
      summary: "cold/warm Gateway session helper command JSON was captured",
      artifactPath: null,
      reason: turns.length >= expectedTurnCount
        ? missingGatewaySessionPayloadReason(turns)
        : `expected at least ${expectedTurnCount} Gateway session turn result(s), found ${turns.length}`
    },
    {
      id: "gateway-session-direct-rpc-transport",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => turn.payload?.gatewayTransport?.kind === "direct-gateway-rpc")
        ? "passed"
        : "failed",
      summary: "Gateway session sends used direct Gateway RPC transport",
      artifactPath: null,
      reason: gatewaySessionTransportReason(turns)
    },
    {
      id: "gateway-session-response-content",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => gatewaySessionResponseOk(turn.payload))
        ? "passed"
        : "failed",
      summary: "Gateway session turns produced the expected assistant marker and assistant-count evidence",
      artifactPath: null,
      reason: gatewaySessionResponseReason(turns)
    },
    {
      id: "gateway-session-latency-windows",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => gatewaySessionLatencyOk(turn.payload))
        ? "passed"
        : "missing",
      summary: "Gateway session active-turn and response latency windows were measured",
      artifactPath: null,
      reason: gatewaySessionLatencyReason(turns)
    },
    {
      id: "gateway-session-provider-proof",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: providerProofOk(providerEvidence, agentTurns, expectedTurnCount) ? "passed" : "missing",
      summary: "provider request/response evidence was captured and attributed to every Gateway session turn",
      artifactPath: providerEvidence.summaryPath ?? providerArtifacts[0] ?? null,
      reason: providerProofReason(providerEvidence, agentTurns, expectedTurnCount)
    },
    {
      id: "gateway-session-readiness-health-proof",
      phaseId: "gateway-start",
      required: true,
      status: gatewaySessionHealthOk(record, health) ? "passed" : "missing",
      summary: "Gateway readiness, post-ready health, and final service state were measured",
      artifactPath: null,
      reason: gatewaySessionHealthReason(record, health)
    },
    zeroCountInvariant({
      id: "gateway-session-no-missing-runtime-dependency-errors",
      summary: "gateway logs and command output contain no missing runtime dependency errors",
      actual: missingDependencyErrors,
      metric: "missingDependencyErrors",
      phaseId: "post-gateway-session-health"
    }),
    zeroCountInvariant({
      id: "gateway-session-no-plugin-load-failures",
      summary: "gateway logs contain no plugin load failures",
      actual: pluginLoadFailures,
      metric: "pluginLoadFailures",
      phaseId: "post-gateway-session-health"
    })
  ];
}

function collectGatewaySessionTurnResults(record) {
  const turns = [];
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (!result?.command?.includes("run-gateway-session-send-turn.mjs")) {
        continue;
      }
      turns.push({
        phaseId: phase.id,
        result,
        payload: parseJsonObject(result.stdout)
      });
    }
  }
  return turns;
}

function missingGatewaySessionPayloadReason(turns) {
  const bad = turns.find((turn) => turn.result?.status !== 0 || !turn.payload);
  if (!bad) {
    return null;
  }
  if (bad.result?.status !== 0) {
    return `${bad.phaseId} command exited ${bad.result?.status ?? "unknown"}`;
  }
  return `${bad.phaseId} did not emit parseable JSON`;
}

function gatewaySessionTransportReason(turns) {
  const bad = turns.find((turn) => turn.payload?.gatewayTransport?.kind !== "direct-gateway-rpc");
  if (!bad) {
    return null;
  }
  const transport = bad.payload?.gatewayTransport?.kind ?? "missing";
  const fallbackReason = bad.payload?.gatewayTransport?.fallbackReason;
  return `${bad.phaseId} used ${transport}${fallbackReason ? ` (${fallbackReason})` : ""}`;
}

function gatewaySessionResponseOk(payload) {
  if (!payload || payload.ok !== true || payload.expectedTextPresent !== true) {
    return false;
  }
  const assistantCount = numberOrNull(payload.assistantMessageCount);
  const minAssistantCount = numberOrNull(payload.minAssistantCount);
  return typeof payload.finalAssistantVisibleText === "string" &&
    payload.finalAssistantVisibleText.length > 0 &&
    assistantCount !== null &&
    minAssistantCount !== null &&
    assistantCount >= minAssistantCount;
}

function gatewaySessionResponseReason(turns) {
  const bad = turns.find((turn) => !gatewaySessionResponseOk(turn.payload));
  if (!bad) {
    return null;
  }
  if (!bad.payload) {
    return `${bad.phaseId} JSON payload was missing`;
  }
  if (bad.payload.ok !== true) {
    return `${bad.phaseId} payload ok was not true`;
  }
  if (bad.payload.expectedTextPresent !== true) {
    return `${bad.phaseId} did not report expected text present`;
  }
  const assistantCount = numberOrNull(bad.payload.assistantMessageCount);
  const minAssistantCount = numberOrNull(bad.payload.minAssistantCount);
  if (assistantCount === null || minAssistantCount === null || assistantCount < minAssistantCount) {
    return `${bad.phaseId} assistant count ${assistantCount ?? "missing"} was below required ${minAssistantCount ?? "missing"}`;
  }
  return `${bad.phaseId} final assistant text was missing`;
}

function gatewaySessionLatencyOk(payload) {
  return payload &&
    nonNegativeNumber(payload.activeTurnMs) &&
    nonNegativeNumber(payload.sendDurationMs) &&
    nonNegativeNumber(payload.timeToMatchedAssistantMs) &&
    nonNegativeNumber(payload.historyPollCount) &&
    numberOrNull(payload.historyErrorCount) === 0;
}

function gatewaySessionLatencyReason(turns) {
  const bad = turns.find((turn) => !gatewaySessionLatencyOk(turn.payload));
  if (!bad) {
    return null;
  }
  if (!bad.payload) {
    return `${bad.phaseId} JSON payload was missing`;
  }
  const missing = ["activeTurnMs", "sendDurationMs", "timeToMatchedAssistantMs", "historyPollCount"]
    .filter((key) => !nonNegativeNumber(bad.payload[key]));
  if (missing.length > 0) {
    return `${bad.phaseId} missing latency field(s): ${missing.join(", ")}`;
  }
  return `${bad.phaseId} historyErrorCount was ${bad.payload.historyErrorCount ?? "missing"}`;
}

function providerProofOk(providerEvidence, agentTurns, expectedTurnCount) {
  if (providerEvidence?.available !== true || providerEvidence.requestCount < expectedTurnCount) {
    return false;
  }
  const gatewayTurns = agentTurns.filter((turn) => turn.gatewaySession);
  if (gatewayTurns.length < expectedTurnCount) {
    return false;
  }
  return gatewayTurns.every((turn) =>
    turn.missingProviderRequest === false &&
    (turn.requestCount ?? 0) > 0 &&
    turn.providerAfterCommandEnd !== true &&
    turn.providerStatuses.every((status) => !Number.isFinite(Number(status.value)) || Number(status.value) < 400)
  );
}

function providerProofReason(providerEvidence, agentTurns, expectedTurnCount) {
  if (providerEvidence?.available !== true) {
    return providerEvidence?.error ?? "provider evidence was not available";
  }
  if (providerEvidence.requestCount < expectedTurnCount) {
    return `provider request count ${providerEvidence.requestCount ?? 0} was below required ${expectedTurnCount}`;
  }
  const gatewayTurns = agentTurns.filter((turn) => turn.gatewaySession);
  if (gatewayTurns.length < expectedTurnCount) {
    return `agent turn attribution count ${gatewayTurns.length} was below required ${expectedTurnCount}`;
  }
  const missing = gatewayTurns.find((turn) => turn.missingProviderRequest === true || (turn.requestCount ?? 0) === 0);
  if (missing) {
    return `${missing.phaseId} had no attributed provider request`;
  }
  const late = gatewayTurns.find((turn) => turn.providerAfterCommandEnd === true);
  if (late) {
    return `${late.phaseId} provider request arrived after command window by ${late.providerLateByMs ?? "unknown"}ms`;
  }
  const failedStatus = gatewayTurns.find((turn) =>
    turn.providerStatuses.some((status) => Number.isFinite(Number(status.value)) && Number(status.value) >= 400)
  );
  if (failedStatus) {
    return `${failedStatus.phaseId} had provider HTTP error status evidence`;
  }
  return null;
}

function gatewaySessionHealthOk(record, health) {
  return health?.readiness?.classification === "ready" &&
    Number.isFinite(health.readiness.healthReadyAtMs) &&
    (health.postReadySamples?.count ?? 0) > 0 &&
    (health.postReadySamples?.failureCount ?? 0) === 0 &&
    (health.final?.failureCount ?? 0) === 0 &&
    record.measurements?.finalGatewayState === "running";
}

function gatewaySessionHealthReason(record, health) {
  if (!health?.readiness) {
    return "readiness measurement was not collected";
  }
  if (health.readiness.classification !== "ready") {
    return `readiness classification was ${health.readiness.classification ?? "missing"}`;
  }
  if (!Number.isFinite(health.readiness.healthReadyAtMs)) {
    return "readiness health-ready timing was not collected";
  }
  if ((health.postReadySamples?.count ?? 0) <= 0) {
    return "post-ready health samples were not collected";
  }
  if ((health.postReadySamples?.failureCount ?? 0) !== 0) {
    return `post-ready health failures were ${health.postReadySamples.failureCount}`;
  }
  if ((health.final?.failureCount ?? 0) !== 0) {
    return `final health failures were ${health.final.failureCount}`;
  }
  if (record.measurements?.finalGatewayState !== "running") {
    return `final gateway state was ${record.measurements?.finalGatewayState ?? "missing"}`;
  }
  return null;
}

export function buildUpgradeLogDerivedInvariants(record) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;
  const doctor = findCommandResult(record, (result) => result.command?.includes(" -- doctor"));

  return [
    zeroCountInvariant({
      id: "no-missing-runtime-dependency-errors",
      summary: "gateway logs and command output contain no missing runtime dependency errors",
      actual: missingDependencyErrors,
      metric: "missingDependencyErrors"
    }),
    zeroCountInvariant({
      id: "no-plugin-load-failures",
      summary: "gateway logs contain no plugin load failures",
      actual: pluginLoadFailures,
      metric: "pluginLoadFailures"
    }),
    {
      id: "doctor-output-captured",
      phaseId: doctor?.phaseId ?? "post-upgrade",
      required: true,
      status: doctorOutputStatus(doctor),
      summary: "post-upgrade doctor output was captured for interpretation",
      artifactPath: null,
      reason: doctorOutputReason(doctor)
    }
  ];
}

function doctorOutputStatus(result) {
  if (!result) {
    return "missing";
  }
  if (result.status !== 0) {
    return "failed";
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.length > 0 ? "passed" : "missing";
}

function doctorOutputReason(result) {
  if (!result) {
    return "doctor command result was not recorded";
  }
  if (result.status !== 0) {
    return `doctor command exited ${result.status}`;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.length > 0 ? null : "doctor command produced no captured output";
}


export function buildUpgradeStateSnapshotInvariants(record) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const pre = findSnapshotResult(record, "snapshot:pre-upgrade-state");
  const post = findSnapshotResult(record, "snapshot:post-upgrade-state");
  const invariants = [];

  invariants.push({
    id: "upgrade-state-snapshots-present",
    phaseId: "evidence-post-upgrade-snapshots",
    required: true,
    status: pre?.snapshot && post?.snapshot ? "passed" : "missing",
    summary: "pre-upgrade and post-upgrade OpenClaw state snapshots were collected",
    artifactPath: post?.evidenceArtifactPath ?? pre?.evidenceArtifactPath ?? null,
    reason: pre?.snapshot && post?.snapshot ? null : "required upgrade state snapshot result was not recorded"
  });

  if (!pre?.snapshot || !post?.snapshot) {
    return invariants;
  }

  invariants.push(compareSnapshotCountInvariant({
    id: "plugin-install-index-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "plugin install index evidence is preserved across upgrade",
    before: pre.snapshot.pluginInstallIndexCount,
    after: post.snapshot.pluginInstallIndexCount,
    artifactPath: post.evidenceArtifactPath
  }));
  invariants.push(compareSnapshotCountInvariant({
    id: "plugin-directory-count-not-decreased",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "plugin directory evidence does not disappear across upgrade",
    before: pre.snapshot.pluginDirCount,
    after: post.snapshot.pluginDirCount,
    artifactPath: post.evidenceArtifactPath
  }));
  invariants.push(compareSnapshotSetInvariant({
    id: "provider-ids-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "provider ids present before upgrade remain present after upgrade",
    before: unionStrings(pre.snapshot.auth?.providerIds, pre.snapshot.models?.providerIds),
    after: unionStrings(post.snapshot.auth?.providerIds, post.snapshot.models?.providerIds),
    artifactPath: post.evidenceArtifactPath
  }));
  invariants.push(compareSnapshotSetInvariant({
    id: "model-ids-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "model ids present before upgrade remain present after upgrade",
    before: pre.snapshot.models?.modelIds,
    after: post.snapshot.models?.modelIds,
    artifactPath: post.evidenceArtifactPath
  }));
  invariants.push(compareSnapshotSetInvariant({
    id: "auth-method-shape-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "auth method shape present before upgrade remains present after upgrade",
    before: pre.snapshot.auth?.authMethodShapes,
    after: post.snapshot.auth?.authMethodShapes,
    artifactPath: post.evidenceArtifactPath
  }));
  invariants.push(compareSnapshotSetInvariant({
    id: "installed-plugin-ids-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "installed plugin ids present before upgrade remain present after upgrade",
    before: pre.snapshot.installedPluginIds,
    after: post.snapshot.installedPluginIds,
    artifactPath: post.evidenceArtifactPath
  }));
  invariants.push(compareSnapshotSetInvariant({
    id: "workspace-roots-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "workspace root fingerprints present before upgrade remain present after upgrade",
    before: pre.snapshot.workspace?.rootHashes,
    after: post.snapshot.workspace?.rootHashes,
    artifactPath: post.evidenceArtifactPath
  }));
  invariants.push(compareSnapshotEqualityInvariant({
    id: "runtime-target-kind-stable",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "runtime target kind remains stable across upgrade",
    before: pre.snapshot.runtime?.targetKind,
    after: post.snapshot.runtime?.targetKind,
    artifactPath: post.evidenceArtifactPath
  }));
  invariants.push(compareSnapshotEqualityInvariant({
    id: "local-build-target-hash-stable",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "local-build target path fingerprint remains stable across upgrade",
    before: pre.snapshot.runtime?.targetValueHash,
    after: post.snapshot.runtime?.targetValueHash,
    artifactPath: post.evidenceArtifactPath,
    optionalWhenMissing: true
  }));
  invariants.push(compareSnapshotEqualityInvariant({
    id: "service-desired-state-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "service desired state remains stable across upgrade",
    before: pre.snapshot.service?.desired,
    after: post.snapshot.service?.desired,
    artifactPath: post.evidenceArtifactPath,
    optionalWhenMissing: true
  }));
  invariants.push(compareSnapshotEqualityInvariant({
    id: "service-running-state-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "service running state remains stable across upgrade while pid and restart metadata may change",
    before: pre.snapshot.service?.state,
    after: post.snapshot.service?.state,
    artifactPath: post.evidenceArtifactPath,
    optionalWhenMissing: true
  }));
  invariants.push(compareSnapshotEqualityInvariant({
    id: "service-readiness-preserved",
    phaseId: "evidence-post-upgrade-snapshots",
    summary: "service readiness remains stable across upgrade while pid and restart metadata may change",
    before: pre.snapshot.service?.readiness,
    after: post.snapshot.service?.readiness,
    artifactPath: post.evidenceArtifactPath,
    optionalWhenMissing: true
  }));

  return invariants;
}


export { buildReleaseRuntimeStartupEvidenceInvariants } from "./release-runtime-startup.mjs";
