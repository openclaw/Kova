import {
  commonResourceProofOk,
  commonResourceProofReason,
  commonTimelineProofOk,
  commonTimelineProofReason,
  collectedLogArtifactPath,
  findCommandResult,
  gatewaySessionHealthOk,
  gatewaySessionHealthReason,
  nonNegativeNumber,
  phaseCommandReceiptsOk,
  phaseCommandReceiptsReason,
  providerResponseStatusValues,
  validRequestCount,
  zeroCountInvariant
} from "./shared.mjs";

export function buildAgentGatewayRpcTurnEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const turns = Array.isArray(record.measurements?.agentTurns)
    ? record.measurements.agentTurns
    : [];
  const expectedTurnCount = agentTurnExpectedCount(scenario, turns);
  const health = record.measurements?.health ?? {};
  const providerEvidence = record.providerEvidence ?? {};
  const providerArtifacts = Array.isArray(providerEvidence.artifacts) ? providerEvidence.artifacts : [];
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;
  const providerTimeoutMentions = record.measurements?.providerTimeoutMentions;
  const logArtifactPath = collectedLogArtifactPath(record);

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
    return "runtime release track was not captured";
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

  const turns = Array.isArray(record.measurements?.agentTurns)
    ? record.measurements.agentTurns
    : [];
  const expectedTurnCount = agentTurnExpectedCount(scenario, turns);
  const providerEvidence = record.providerEvidence ?? {};
  const providerArtifacts = Array.isArray(providerEvidence.artifacts) ? providerEvidence.artifacts : [];
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;
  const providerTimeoutMentions = record.measurements?.providerTimeoutMentions;
  const logArtifactPath = collectedLogArtifactPath(record);

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
    scopedTurns.every((turn) => turnUsesLocalAgentCli(turn) && !turn.gatewaySession);
}

function agentCliLocalTransportReason(turns, expectedTurnCount) {
  if (turns.length < expectedTurnCount) {
    return `expected at least ${expectedTurnCount} agent turn(s), found ${turns.length}`;
  }
  const bad = turns.slice(0, expectedTurnCount).find((turn) => !turnUsesLocalAgentCli(turn) || turn.gatewaySession);
  if (!bad) {
    return null;
  }
  if (!turnUsesLocalAgentCli(bad)) {
    return `${bad.phaseId} command did not include --local`;
  }
  return `${bad.phaseId} had Gateway session transport evidence`;
}

function turnUsesLocalAgentCli(turn) {
  const command = turn?.command ?? "";
  return commandUsesFlag(command, "--local") ||
    command.includes("run-concurrent-agent-turns.mjs");
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
  const scopedTurns = turns.slice(0, expectedTurnCount);
  if (scopedTurns.length < expectedTurnCount) {
    return false;
  }
  const successfulTurns = scopedTurns.filter((turn) => !agentTurnExpectedFailure(turn, scenario));
  if (successfulTurns.length === 0) {
    return true;
  }
  const attributedRequestCount = successfulTurns.reduce(
    (total, turn) => validRequestCount(turn.requestCount, 1) ? total + turn.requestCount : Number.NaN,
    0
  );
  if (providerEvidence?.available !== true ||
    !validRequestCount(providerEvidence.requestCount, attributedRequestCount)) {
    return false;
  }
  return successfulTurns.every((turn) =>
    turn.missingProviderRequest === false &&
    validRequestCount(turn.requestCount, 1) &&
    turn.providerAfterCommandEnd !== true &&
    nonNegativeNumber(turn.providerFinalMs) &&
    successfulTurnProviderStatusesOk(turn, scenario)
  );
}

function agentProviderProofReason(providerEvidence, turns, scenario, expectedTurnCount) {
  const scopedTurns = turns.slice(0, expectedTurnCount);
  if (scopedTurns.length < expectedTurnCount) {
    return `agent turn attribution count ${scopedTurns.length} was below required ${expectedTurnCount}`;
  }
  const successfulTurns = scopedTurns.filter((turn) => !agentTurnExpectedFailure(turn, scenario));
  if (successfulTurns.length === 0) {
    return null;
  }
  if (providerEvidence?.available !== true) {
    return providerEvidence?.error ?? "provider evidence was not available";
  }
  const missing = successfulTurns.find((turn) =>
    turn.missingProviderRequest === true || !validRequestCount(turn.requestCount, 1)
  );
  if (missing) {
    return `${missing.phaseId} had no attributed provider request`;
  }
  const attributedRequestCount = successfulTurns.reduce(
    (total, turn) => total + turn.requestCount,
    0
  );
  if (!validRequestCount(providerEvidence.requestCount, attributedRequestCount)) {
    return `provider request count ${providerEvidence.requestCount ?? "missing"} was not a finite count of at least ${attributedRequestCount}`;
  }
  const late = successfulTurns.find((turn) => turn.providerAfterCommandEnd === true);
  if (late) {
    return `${late.phaseId} provider request arrived after command window by ${late.providerLateByMs ?? "unknown"}ms`;
  }
  const incomplete = successfulTurns.find((turn) => !nonNegativeNumber(turn.providerFinalMs));
  if (incomplete) {
    return `${incomplete.phaseId} had no completed provider response timing`;
  }
  const missingStatus = successfulTurns.find((turn) =>
    successfulTurnProviderStatusValues(turn, scenario) === null
  );
  if (missingStatus) {
    return `${missingStatus.phaseId} had no valid provider HTTP response status evidence`;
  }
  const failedStatus = successfulTurns.find((turn) => !successfulTurnProviderStatusesOk(turn, scenario));
  if (failedStatus) {
    return `${failedStatus.phaseId} had provider HTTP error status evidence`;
  }
  return null;
}

function successfulTurnProviderStatusesOk(turn, scenario) {
  const numericStatuses = successfulTurnProviderStatusValues(turn, scenario);
  if (numericStatuses === null) {
    return false;
  }
  const hasSuccess = numericStatuses.some((value) => value >= 200 && value < 300);
  const hasHttpFailure = numericStatuses.some((value) => value >= 400);
  if (!hasHttpFailure) {
    return hasSuccess;
  }
  if (!providerRecoveryScenarioAllowsFailedRequest(scenario)) {
    return false;
  }
  const recoverableErrors = new Set(["provider-error", "provider-disconnect", "http"]);
  const providerErrors = Array.isArray(turn.providerErrors) ? turn.providerErrors : [];
  const hasRecoverableError = providerErrors.some((error) => recoverableErrors.has(error.kind));
  return hasSuccess && hasRecoverableError;
}

function successfulTurnProviderStatusValues(turn, scenario) {
  const statuslessRequestCount = providerRecoveryScenarioAllowsFailedRequest(scenario)
    ? recoverableStatuslessProviderRequestCount(turn.providerErrors)
    : 0;
  return providerResponseStatusValues(
    turn.providerStatuses,
    turn.requestCount,
    statuslessRequestCount
  );
}

function recoverableStatuslessProviderRequestCount(providerErrors) {
  if (!Array.isArray(providerErrors)) {
    return 0;
  }
  const requestIds = new Set();
  for (const error of providerErrors) {
    if ((error?.kind === "provider-error" || error?.kind === "provider-disconnect") &&
      typeof error.requestId === "string" &&
      error.requestId.length > 0 &&
      (error.status === null || error.status === undefined)) {
      requestIds.add(error.requestId);
    }
  }
  return requestIds.size;
}

function providerRecoveryScenarioAllowsFailedRequest(scenario) {
  return scenario?.mockProvider?.mode === "error-then-recover" ||
    scenario?.mockProvider?.mode === "disconnect-then-recover";
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
  const expectedGatewayState = agentCliRecordExpectsRunningGateway(record) ? "running" : "disabled";
  return record.measurements?.finalGatewayState === expectedGatewayState &&
    final?.failureCount === 0 &&
    findCommandResult(record, (result) => result.command?.includes(" -- status"))?.status === 0;
}

function agentCliNoServiceHealthReason(record) {
  const expectedGatewayState = agentCliRecordExpectsRunningGateway(record) ? "running" : "disabled";
  if (record.measurements?.finalGatewayState !== expectedGatewayState) {
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

function agentCliRecordExpectsRunningGateway(record) {
  return (record.phases ?? []).some((phase) =>
    (phase.commands ?? []).some((command) =>
      command.startsWith("ocm service start ") ||
      command.startsWith("ocm service restart ") ||
      (command.startsWith("ocm start ") && !/(?:^|\s)--no-service(?:\s|$)/.test(command))
    )
  );
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
