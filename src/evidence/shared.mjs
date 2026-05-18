import { collectRecordMetricObjects } from "./metrics.mjs";

export function phaseCommandReceiptsOk(record) {
  return (record.phases ?? []).every((phase) => {
    const commandCount = phase.commands?.length ?? 0;
    if (commandCount === 0) {
      return true;
    }
    return Array.from({ length: commandCount }).every((_, index) => {
      const result = phase.results?.[index];
      return result?.status === 0 && result.durationMs !== undefined;
    });
  });
}

export function phaseCommandReceiptsReason(record) {
  for (const phase of record.phases ?? []) {
    for (const [index, command] of (phase.commands ?? []).entries()) {
      const result = phase.results?.[index];
      if (!result) {
        return `${phase.id} command ${index + 1} receipt was not captured`;
      }
      if (result.status !== 0) {
        return `${phase.id} command ${index + 1} exited ${result.status}`;
      }
      if (result.durationMs === undefined) {
        return `${phase.id} command ${index + 1} duration was not captured`;
      }
      if (typeof command === "string" && typeof result.command === "string" && result.command.length === 0) {
        return `${phase.id} command ${index + 1} command text was empty`;
      }
    }
  }
  return null;
}

export function commonResourceProofOk(measurements) {
  return (measurements?.resourceSampleCount ?? 0) > 0 &&
    Array.isArray(measurements?.resourceSampleArtifacts) &&
    measurements.resourceSampleArtifacts.length > 0 &&
    nonNegativeNumber(measurements.peakRssMb);
}

export function commonResourceProofReason(measurements) {
  if ((measurements?.resourceSampleCount ?? 0) <= 0) {
    return "resource samples were not collected";
  }
  if (!Array.isArray(measurements?.resourceSampleArtifacts) || measurements.resourceSampleArtifacts.length === 0) {
    return "resource sample artifact path was not recorded";
  }
  if (!nonNegativeNumber(measurements?.peakRssMb)) {
    return "resource peak RSS measurement was not captured";
  }
  return null;
}

export function commonTimelineProofOk(measurements) {
  return measurements?.openclawTimelineAvailable === true &&
    (measurements.openclawTimelineEventCount ?? 0) > 0 &&
    (measurements.openclawTimelineParseErrors ?? 0) === 0 &&
    Array.isArray(measurements.openclawTimelineArtifacts) &&
    measurements.openclawTimelineArtifacts.length > 0;
}

export function commonTimelineProofReason(measurements) {
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

export function phaseMetrics(record, phaseId) {
  return (record.phases ?? []).find((phase) => phase.id === phaseId)?.metrics ?? null;
}

export function releaseStartupLogsProof(record, phaseId) {
  const command = findCommandResultInPhase(record, phaseId, (result) => result.command?.startsWith("ocm logs "));
  if (command) {
    return { kind: "command", command };
  }
  const phase = findPhase(record, phaseId);
  return {
    kind: "collector",
    receipt: collectorReceiptInPhase(record, phaseId, "logs"),
    metrics: phase?.metrics?.logs ?? null
  };
}

export function releaseStartupLogsOk(proof) {
  if (proof && !proof.kind && proof.status !== undefined) {
    return proof.status === 0 && `${proof.stdout ?? ""}${proof.stderr ?? ""}`.trim().length > 0;
  }
  if (proof?.kind === "command") {
    return proof.command?.status === 0 && `${proof.command.stdout ?? ""}${proof.command.stderr ?? ""}`.trim().length > 0;
  }
  return proof?.receipt?.status === "PASS" &&
    proof.metrics?.commandStatus === 0 &&
    Array.isArray(proof.metrics?.artifacts) &&
    proof.metrics.artifacts.length > 0;
}

export function releaseStartupLogsReason(proof) {
  if (!proof) {
    return "startup logs evidence was not captured";
  }
  if (!proof.kind && proof.status !== undefined) {
    if (proof.status !== 0) {
      return `startup logs command exited ${proof.status}`;
    }
    if (`${proof.stdout ?? ""}${proof.stderr ?? ""}`.trim().length === 0) {
      return "startup logs command emitted no output";
    }
    return null;
  }
  if (proof.kind === "command") {
    if (proof.command.status !== 0) {
      return `startup logs command exited ${proof.command.status}`;
    }
    if (`${proof.command.stdout ?? ""}${proof.command.stderr ?? ""}`.trim().length === 0) {
      return "startup logs command emitted no output";
    }
    return null;
  }
  if (!proof.receipt) {
    return "startup logs collector receipt was not captured";
  }
  if (proof.receipt.status !== "PASS") {
    return `startup logs collector status was ${proof.receipt.status}`;
  }
  if (proof.metrics?.commandStatus !== 0) {
    return `startup logs collector command status was ${proof.metrics?.commandStatus ?? "missing"}`;
  }
  if (!Array.isArray(proof.metrics?.artifacts) || proof.metrics.artifacts.length === 0) {
    return "startup logs collector artifact path was not recorded";
  }
  return null;
}

export function releaseStartupLogArtifactPath(record) {
  for (const metrics of collectRecordMetricObjects(record)) {
    const artifact = metrics.logs?.artifacts?.[0];
    if (artifact) {
      return artifact;
    }
  }
  return null;
}

export function zeroCountInvariant({ id, summary, actual, metric, phaseId = "post-upgrade" }) {
  if (!Number.isFinite(actual)) {
    return {
      id,
      phaseId,
      required: true,
      status: "missing",
      summary,
      artifactPath: null,
      reason: `${metric} measurement was not collected`
    };
  }
  return {
    id,
    phaseId,
    required: true,
    status: actual === 0 ? "passed" : "failed",
    summary,
    artifactPath: null,
    reason: actual === 0 ? null : `${metric} was ${actual}`
  };
}

export function compareSnapshotSetInvariant({ id, phaseId, summary, before, after, artifactPath }) {
  const beforeValues = sortedUnique(before ?? []);
  const afterValues = new Set(sortedUnique(after ?? []));
  const missing = beforeValues.filter((value) => !afterValues.has(value));
  return {
    id,
    phaseId,
    required: true,
    status: missing.length === 0 ? "passed" : "failed",
    summary,
    artifactPath,
    reason: missing.length === 0 ? null : `missing after upgrade: ${missing.slice(0, 5).join(", ")}`
  };
}

export function compareSnapshotEqualityInvariant({ id, phaseId, summary, before, after, artifactPath, optionalWhenMissing = false }) {
  if (optionalWhenMissing && (before === null || before === undefined) && (after === null || after === undefined)) {
    return {
      id,
      phaseId,
      required: true,
      status: "passed",
      summary,
      artifactPath,
      reason: null
    };
  }
  const status = before === after ? "passed" : "failed";
  return {
    id,
    phaseId,
    required: true,
    status,
    summary,
    artifactPath,
    reason: status === "passed" ? null : `changed from ${before ?? "missing"} to ${after ?? "missing"}`
  };
}

export function sortedUnique(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))].sort();
}

export function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text ?? "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonNegativeNumber(value) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0;
}

export function unionStrings(...groups) {
  return sortedUnique(groups.flatMap((group) => group ?? []));
}

export function compareSnapshotCountInvariant({ id, phaseId, summary, before, after, artifactPath }) {
  const beforeCount = Number.isFinite(before) ? before : 0;
  const afterCount = Number.isFinite(after) ? after : 0;
  const status = beforeCount <= afterCount ? "passed" : "failed";
  return {
    id,
    phaseId,
    required: true,
    status,
    summary,
    artifactPath,
    reason: status === "passed" ? null : `count decreased from ${beforeCount} to ${afterCount}`
  };
}

export function findSnapshotResult(record, evidenceId) {
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (result.evidenceId === evidenceId) {
        return result;
      }
    }
  }
  return null;
}

export function findCommandResult(record, predicate) {
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (predicate(result)) {
        return {
          ...result,
          phaseId: phase.id
        };
      }
    }
  }
  return null;
}

export function findCommandResultInPhase(record, phaseId, predicate) {
  const phase = findPhase(record, phaseId);
  if (!phase) {
    return null;
  }
  for (const result of phase.results ?? []) {
    if (predicate(result)) {
      return {
        ...result,
        phaseId: phase.id
      };
    }
  }
  return null;
}

export function findPhase(record, phaseId) {
  return (record.phases ?? []).find((candidate) => candidate.id === phaseId) ?? null;
}

export function commandReceiptOk(record, predicate) {
  const result = findCommandResult(record, predicate);
  return result?.status === 0 && result.durationMs !== undefined;
}

export function commandReceiptReason(record, predicate) {
  const result = findCommandResult(record, predicate);
  if (!result) {
    return "command receipt was not captured";
  }
  if (result.status !== 0) {
    return `command exited ${result.status}`;
  }
  if (result.durationMs === undefined) {
    return "command duration was not captured";
  }
  return null;
}

export function collectorReceiptInPhase(record, phaseId, collectorId) {
  const phase = findPhase(record, phaseId);
  return (phase?.metrics?.collectors ?? []).find((collector) => collector.id === collectorId) ?? null;
}

export function collectorReceiptOk(record, phaseId, collectorId) {
  const receipt = collectorReceiptInPhase(record, phaseId, collectorId);
  return receipt?.status === "PASS" && receipt.durationMs !== undefined;
}

export function collectorReceiptReason(record, phaseId, collectorId) {
  const receipt = collectorReceiptInPhase(record, phaseId, collectorId);
  if (!receipt) {
    return "collector receipt was not captured";
  }
  if (receipt.status !== "PASS") {
    return `collector status was ${receipt.status}`;
  }
  if (receipt.durationMs === undefined) {
    return "collector duration was not captured";
  }
  return null;
}

export function gatewaySessionHealthOk(record, health) {
  return health?.readiness?.classification === "ready" &&
    Number.isFinite(health.readiness.healthReadyAtMs) &&
    (health.postReadySamples?.count ?? 0) > 0 &&
    (health.postReadySamples?.failureCount ?? 0) === 0 &&
    (health.final?.failureCount ?? 0) === 0 &&
    record.measurements?.finalGatewayState === "running";
}

export function gatewaySessionHealthReason(record, health) {
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
