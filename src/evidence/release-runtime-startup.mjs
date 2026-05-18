import {
  commandReceiptOk,
  commandReceiptReason,
  collectorReceiptOk,
  collectorReceiptReason,
  collectedLogArtifactPath,
  collectedLogsOk,
  collectedLogsProof,
  collectedLogsReason,
  findCommandResult,
  nonNegativeNumber,
  parseJsonObject,
  zeroCountInvariant
} from "./shared.mjs";

export function buildReleaseRuntimeStartupEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const health = record.measurements?.health ?? {};
  const service = releaseStartupBestServiceMetrics(record);
  const provision = releaseStartupProvisionProof(record);
  const statusResult = findCommandResult(record, (result) => result.command === "ocm @{env} -- status" || result.command?.includes(" -- status"));
  const pluginsListResult = findCommandResult(record, (result) => result.command === "ocm @{env} -- plugins list" || result.command?.includes(" -- plugins list"));
  const logsProof = collectedLogsProof(record, "startup-logs");
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;

  return [
    {
      id: "release-runtime-command-receipts",
      phaseId: "post-start",
      required: true,
      status: releaseStartupCommandReceiptsOk(record) ? "passed" : "missing",
      summary: "startup, service status, OpenClaw status, plugin list, and log command receipts were captured",
      artifactPath: null,
      reason: releaseStartupCommandReceiptsReason(record)
    },
    {
      id: "release-runtime-binding-version-proof",
      phaseId: "provision",
      required: true,
      status: releaseStartupBindingOk(service, provision) ? "passed" : "missing",
      summary: "OCM startup evidence identifies the release runtime binding and OpenClaw version",
      artifactPath: null,
      reason: releaseStartupBindingReason(service, provision)
    },
    {
      id: "release-runtime-readiness-health-proof",
      phaseId: "provision",
      required: true,
      status: releaseStartupHealthMissing(record, health) ? "missing" : releaseStartupHealthOk(record, health) ? "passed" : "failed",
      summary: "gateway readiness, post-ready health, and final service state were measured",
      artifactPath: null,
      reason: releaseStartupHealthReason(record, health)
    },
    {
      id: "release-runtime-command-usability-proof",
      phaseId: "post-start",
      required: true,
      status: releaseStartupCommandUsabilityOk(statusResult, pluginsListResult, record.measurements) ? "passed" : "missing",
      summary: "status and plugin-list commands completed with latency measurements",
      artifactPath: null,
      reason: releaseStartupCommandUsabilityReason(statusResult, pluginsListResult, record.measurements)
    },
    {
      id: "release-runtime-resource-proof",
      phaseId: "provision",
      required: true,
      status: releaseStartupResourceOk(record.measurements) ? "passed" : "missing",
      summary: "gateway-scoped resource samples and retained sample artifacts were captured",
      artifactPath: record.measurements?.resourceSampleArtifacts?.[0] ?? null,
      reason: releaseStartupResourceReason(record.measurements)
    },
    {
      id: "release-runtime-diagnostic-timeline-proof",
      phaseId: "startup-logs",
      required: true,
      status: releaseStartupTimelineOk(record.measurements) ? "passed" : "missing",
      summary: "OpenClaw diagnostic timeline was captured and parsed without errors",
      artifactPath: record.measurements?.openclawTimelineArtifacts?.[0] ?? null,
      reason: releaseStartupTimelineReason(record.measurements)
    },
    {
      id: "release-runtime-startup-logs-captured",
      phaseId: "startup-logs",
      required: true,
      status: collectedLogsOk(logsProof) ? "passed" : "missing",
      summary: "startup logs were captured through command or collector evidence",
      artifactPath: collectedLogArtifactPath(record),
      reason: collectedLogsReason(logsProof)
    },
    zeroCountInvariant({
      id: "release-runtime-no-missing-runtime-dependency-errors",
      summary: "startup logs and command output contain no missing runtime dependency errors",
      actual: missingDependencyErrors,
      metric: "missingDependencyErrors",
      phaseId: "startup-logs"
    }),
    zeroCountInvariant({
      id: "release-runtime-no-plugin-load-failures",
      summary: "startup logs contain no plugin load failures",
      actual: pluginLoadFailures,
      metric: "pluginLoadFailures",
      phaseId: "startup-logs"
    })
  ];
}

function releaseStartupCommandReceiptsOk(record) {
  const required = [
    ["ocm start", () => commandReceiptOk(record, (result) => result.command?.startsWith("ocm start "))],
    ["service collector", () => collectorReceiptOk(record, "post-start", "service")],
    ["ocm status", () => commandReceiptOk(record, (result) => result.command === "ocm @{env} -- status" || result.command?.includes(" -- status"))],
    ["ocm plugins list", () => commandReceiptOk(record, (result) => result.command === "ocm @{env} -- plugins list" || result.command?.includes(" -- plugins list"))],
    ["logs collector", () => collectorReceiptOk(record, "startup-logs", "logs")]
  ];
  return required.every(([_, ok]) => ok());
}

function releaseStartupCommandReceiptsReason(record) {
  const required = [
    ["ocm start", () => commandReceiptReason(record, (result) => result.command?.startsWith("ocm start "))],
    ["service collector", () => collectorReceiptReason(record, "post-start", "service")],
    ["ocm status", () => commandReceiptReason(record, (result) => result.command === "ocm @{env} -- status" || result.command?.includes(" -- status"))],
    ["ocm plugins list", () => commandReceiptReason(record, (result) => result.command === "ocm @{env} -- plugins list" || result.command?.includes(" -- plugins list"))],
    ["logs collector", () => collectorReceiptReason(record, "startup-logs", "logs")]
  ];
  for (const [label, reason] of required) {
    const missing = reason();
    if (missing) {
      return `${label}: ${missing}`;
    }
  }
  return null;
}

function releaseStartupProvisionProof(record) {
  const result = findCommandResult(record, (candidate) => candidate.command?.startsWith("ocm start "));
  return {
    result,
    payload: parseJsonObject(result?.stdout)
  };
}

function releaseStartupBestServiceMetrics(record) {
  const services = [];
  for (const phase of record.phases ?? []) {
    if (phase.metrics?.service) {
      services.push(phase.metrics.service);
    }
  }
  if (record.finalMetrics?.service) {
    services.push(record.finalMetrics.service);
  }
  return services.find((service) => typeof service.runtimeReleaseVersion === "string" && service.runtimeReleaseVersion.length > 0) ??
    services.find((service) => service.gatewayState || service.gatewayPort || service.runtimeReleaseChannel) ??
    null;
}

function releaseStartupBindingOk(service, provision) {
  return typeof service?.runtimeReleaseVersion === "string" &&
    service.runtimeReleaseVersion.length > 0 &&
    (typeof service.runtimeReleaseChannel === "string" || typeof provision?.payload?.defaultRuntime === "string") &&
    (nonNegativeNumber(service.gatewayPort) || nonNegativeNumber(provision?.payload?.gatewayPort));
}

function releaseStartupBindingReason(service, provision) {
  if (!service) {
    return "service metrics were not captured";
  }
  if (typeof service.runtimeReleaseVersion !== "string" || service.runtimeReleaseVersion.length === 0) {
    return "runtime release version was not captured";
  }
  if (typeof service.runtimeReleaseChannel !== "string" && typeof provision?.payload?.defaultRuntime !== "string") {
    return "runtime binding/channel was not captured";
  }
  if (!nonNegativeNumber(service.gatewayPort) && !nonNegativeNumber(provision?.payload?.gatewayPort)) {
    return "gateway port was not captured";
  }
  return null;
}

function releaseStartupHealthOk(record, health) {
  return health?.readiness?.classification === "ready" &&
    Number.isFinite(health.readiness.healthReadyAtMs) &&
    (health.postReadySamples?.count ?? 0) > 0 &&
    (health.postReadySamples?.failureCount ?? 0) === 0 &&
    (health.final?.failureCount ?? 0) === 0 &&
    record.measurements?.finalGatewayState === "running";
}

function releaseStartupHealthMissing(record, health) {
  return !health?.readiness ||
    !Number.isFinite(health.readiness.healthReadyAtMs) ||
    (health.postReadySamples?.count ?? 0) <= 0 ||
    record.measurements?.finalGatewayState === undefined;
}

function releaseStartupHealthReason(record, health) {
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

function releaseStartupCommandUsabilityOk(statusResult, pluginsListResult, measurements) {
  return statusResult?.status === 0 &&
    pluginsListResult?.status === 0 &&
    nonNegativeNumber(measurements?.statusMs) &&
    nonNegativeNumber(measurements?.pluginsListMs);
}

function releaseStartupCommandUsabilityReason(statusResult, pluginsListResult, measurements) {
  if (!statusResult) {
    return "OpenClaw status command receipt was not captured";
  }
  if (statusResult.status !== 0) {
    return `OpenClaw status command exited ${statusResult.status}`;
  }
  if (!pluginsListResult) {
    return "plugin list command receipt was not captured";
  }
  if (pluginsListResult.status !== 0) {
    return `plugin list command exited ${pluginsListResult.status}`;
  }
  if (!nonNegativeNumber(measurements?.statusMs)) {
    return "status command latency was not measured";
  }
  if (!nonNegativeNumber(measurements?.pluginsListMs)) {
    return "plugin list command latency was not measured";
  }
  return null;
}

function releaseStartupResourceOk(measurements) {
  const gatewayRole = measurements?.resourceByRole?.gateway;
  return (measurements?.resourceSampleCount ?? 0) > 0 &&
    Array.isArray(measurements?.resourceSampleArtifacts) &&
    measurements.resourceSampleArtifacts.length > 0 &&
    nonNegativeNumber(gatewayRole?.peakRssMb);
}

function releaseStartupResourceReason(measurements) {
  if ((measurements?.resourceSampleCount ?? 0) <= 0) {
    return "resource samples were not collected";
  }
  if (!Array.isArray(measurements?.resourceSampleArtifacts) || measurements.resourceSampleArtifacts.length === 0) {
    return "resource sample artifact path was not recorded";
  }
  if (!nonNegativeNumber(measurements?.resourceByRole?.gateway?.peakRssMb)) {
    return "gateway role resource measurements were not captured";
  }
  return null;
}

function releaseStartupTimelineOk(measurements) {
  return measurements?.openclawTimelineAvailable === true &&
    (measurements.openclawTimelineEventCount ?? 0) > 0 &&
    (measurements.openclawTimelineParseErrors ?? 0) === 0 &&
    Array.isArray(measurements.openclawTimelineArtifacts) &&
    measurements.openclawTimelineArtifacts.length > 0;
}

function releaseStartupTimelineReason(measurements) {
  if (measurements?.openclawTimelineAvailable !== true) {
    return "OpenClaw diagnostic timeline was not available";
  }
  if ((measurements.openclawTimelineEventCount ?? 0) <= 0) {
    return "OpenClaw diagnostic timeline had no events";
  }
  if ((measurements.openclawTimelineParseErrors ?? 0) !== 0) {
    return `OpenClaw diagnostic timeline parse errors were ${measurements.openclawTimelineParseErrors}`;
  }
  if (!Array.isArray(measurements.openclawTimelineArtifacts) || measurements.openclawTimelineArtifacts.length === 0) {
    return "OpenClaw diagnostic timeline artifact path was not recorded";
  }
  return null;
}
