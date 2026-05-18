import {
  commonResourceProofOk,
  commonResourceProofReason,
  commonTimelineProofOk,
  commonTimelineProofReason,
  findCommandResult,
  findCommandResultInPhase,
  nonNegativeNumber,
  phaseMetrics,
  releaseStartupLogArtifactPath,
  releaseStartupLogsOk,
  releaseStartupLogsReason,
  zeroCountInvariant
} from "./shared.mjs";

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
