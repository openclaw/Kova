import { collectRecordMetricObjects } from "./metrics.mjs";
import {
  commandResultFailureReason,
  commandResultFailed,
  commandResultPassed
} from "../measurement-contract.mjs";

export function phaseCommandReceiptsOk(record) {
  return (record.phases ?? []).every((phase) => {
    const commandCount = phase.commands?.length ?? 0;
    if (commandCount === 0) {
      return true;
    }
    return Array.from({ length: commandCount }).every((_, index) => {
      const result = phase.results?.[index];
      return commandResultPassed(result) && result.durationMs !== undefined;
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
      if (commandResultFailed(result)) {
        return `${phase.id} command ${index + 1}: ${commandResultFailureReason(result)}`;
      }
      if (!commandResultPassed(result)) {
        return `${phase.id} command ${index + 1} result status was not captured`;
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

export function collectedLogsProof(record, phaseId) {
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

export function collectedLogsOk(proof) {
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

export function collectedLogsReason(proof) {
  if (!proof) {
    return "logs evidence was not captured";
  }
  if (!proof.kind && proof.status !== undefined) {
    if (proof.status !== 0) {
      return `logs command exited ${proof.status}`;
    }
    if (`${proof.stdout ?? ""}${proof.stderr ?? ""}`.trim().length === 0) {
      return "logs command emitted no output";
    }
    return null;
  }
  if (proof.kind === "command") {
    if (proof.command.status !== 0) {
      return `logs command exited ${proof.command.status}`;
    }
    if (`${proof.command.stdout ?? ""}${proof.command.stderr ?? ""}`.trim().length === 0) {
      return "logs command emitted no output";
    }
    return null;
  }
  if (!proof.receipt) {
    return "logs collector receipt was not captured";
  }
  if (proof.receipt.status !== "PASS") {
    return `logs collector status was ${proof.receipt.status}`;
  }
  if (proof.metrics?.commandStatus !== 0) {
    return `logs collector command status was ${proof.metrics?.commandStatus ?? "missing"}`;
  }
  if (!Array.isArray(proof.metrics?.artifacts) || proof.metrics.artifacts.length === 0) {
    return "logs collector artifact path was not recorded";
  }
  return null;
}

export function collectedLogArtifactPath(record) {
  for (const metrics of collectRecordMetricObjects(record)) {
    const artifact = metrics.logs?.artifacts?.[0];
    if (artifact) {
      return artifact;
    }
  }
  return null;
}

export function releaseStartupLogsProof(record, phaseId) {
  return collectedLogsProof(record, phaseId);
}

export function releaseStartupLogsOk(proof) {
  return collectedLogsOk(proof);
}

export function releaseStartupLogsReason(proof) {
  return collectedLogsReason(proof);
}

export function releaseStartupLogArtifactPath(record) {
  return collectedLogArtifactPath(record);
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
  if (!validStringSetInput(before) || !validStringSetInput(after)) {
    return missingSnapshotInvariant({
      id,
      phaseId,
      summary,
      artifactPath,
      reason: snapshotInputsMissingReason(before, after, "set")
    });
  }
  const beforeValues = sortedUnique(before);
  const afterValues = new Set(sortedUnique(after));
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
  if (!optionalWhenMissing && (!validSnapshotValue(before) || !validSnapshotValue(after))) {
    return missingSnapshotInvariant({
      id,
      phaseId,
      summary,
      artifactPath,
      reason: snapshotInputsMissingReason(before, after, "value")
    });
  }
  if (optionalWhenMissing &&
    ((before !== null && before !== undefined && !validSnapshotValue(before)) ||
      (after !== null && after !== undefined && !validSnapshotValue(after)))) {
    return missingSnapshotInvariant({
      id,
      phaseId,
      summary,
      artifactPath,
      reason: snapshotInputsMissingReason(before, after, "value")
    });
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
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nonNegativeNumber(value) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0;
}

export function validRequestCount(value, minimum = 0) {
  return Number.isInteger(value) && value >= minimum;
}

export function providerResponseStatusValues(statuses, requestCount, statuslessRequestCount = 0) {
  if (!validRequestCount(requestCount, 1) ||
    !validRequestCount(statuslessRequestCount) ||
    statuslessRequestCount >= requestCount ||
    !Array.isArray(statuses) ||
    statuses.length === 0) {
    return null;
  }
  const validStatuses = statuses.every((status) =>
    Number.isInteger(status?.value) &&
    status.value >= 100 &&
    status.value <= 599 &&
    Number.isInteger(status.count) &&
    status.count > 0
  );
  const uniqueStatuses = validStatuses &&
    new Set(statuses.map((status) => status.value)).size === statuses.length;
  const statusCount = uniqueStatuses
    ? statuses.reduce((total, status) => total + status.count, 0)
    : null;
  return statusCount + statuslessRequestCount === requestCount
    ? statuses.map((status) => status.value)
    : null;
}

export function unionStrings(...groups) {
  if (groups.length === 0 || !groups.every(validStringSetInput)) {
    return null;
  }
  return sortedUnique(groups.flat());
}

export function compareSnapshotCountInvariant({ id, phaseId, summary, before, after, artifactPath }) {
  if (!validSnapshotCount(before) || !validSnapshotCount(after)) {
    return missingSnapshotInvariant({
      id,
      phaseId,
      summary,
      artifactPath,
      reason: snapshotInputsMissingReason(before, after, "count")
    });
  }
  const beforeCount = before;
  const afterCount = after;
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
  return commandResultPassed(result) && result.durationMs !== undefined;
}

export function commandReceiptReason(record, predicate) {
  const result = findCommandResult(record, predicate);
  if (!result) {
    return "command receipt was not captured";
  }
  if (commandResultFailed(result)) {
    return commandResultFailureReason(result);
  }
  if (!commandResultPassed(result)) {
    return "command result status was not captured";
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

export function commandProof(label, predicate) {
  return [
    label,
    (record) => commandReceiptOk(record, predicate),
    (record) => commandReceiptReason(record, predicate)
  ];
}

export function commandProofInPhase(label, phaseId, predicate) {
  return [
    label,
    (record) => {
      const result = findCommandResultInPhase(record, phaseId, predicate);
      return commandResultPassed(result) && nonNegativeNumber(result.durationMs);
    },
    (record) => {
      const result = findCommandResultInPhase(record, phaseId, predicate);
      if (!result) {
        return `command receipt was not captured in ${phaseId}`;
      }
      if (commandResultFailed(result)) {
        return commandResultFailureReason(result);
      }
      if (!commandResultPassed(result)) {
        return "command result status was not captured";
      }
      if (!nonNegativeNumber(result.durationMs)) {
        return "command duration was not a non-negative finite measurement";
      }
      return null;
    }
  ];
}

export function collectorProof(label, phaseId, collectorId) {
  return [
    label,
    (record) => collectorReceiptOk(record, phaseId, collectorId),
    (record) => collectorReceiptReason(record, phaseId, collectorId)
  ];
}

export function requiredProofsOk(record, proofs) {
  return proofs.every(([_, ok]) => ok(record));
}

export function requiredProofsReason(record, proofs) {
  for (const [label, _, reason] of proofs) {
    const missing = reason(record);
    if (missing) {
      return `${label}: ${missing}`;
    }
  }
  return null;
}

export function gatewaySessionHealthOk(record, health) {
  return health?.readiness?.classification === "ready" &&
    Number.isFinite(health.readiness.healthReadyAtMs) &&
    validRequestCount(health.postReadySamples?.count, 1) &&
    validRequestCount(health.postReadySamples?.failureCount) &&
    health.postReadySamples.failureCount === 0 &&
    validRequestCount(health.final?.failureCount) &&
    health.final.failureCount === 0 &&
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
  if (!validRequestCount(health.postReadySamples?.count, 1)) {
    return "post-ready health samples were not collected";
  }
  if (!validRequestCount(health.postReadySamples?.failureCount)) {
    return "post-ready health failure count was not collected";
  }
  if (health.postReadySamples.failureCount !== 0) {
    return `post-ready health failures were ${health.postReadySamples.failureCount}`;
  }
  if (!validRequestCount(health.final?.failureCount)) {
    return "final health failure count was not collected";
  }
  if (health.final.failureCount !== 0) {
    return `final health failures were ${health.final.failureCount}`;
  }
  if (record.measurements?.finalGatewayState !== "running") {
    return `final gateway state was ${record.measurements?.finalGatewayState ?? "missing"}`;
  }
  return null;
}

function missingSnapshotInvariant({ id, phaseId, summary, artifactPath, reason }) {
  return {
    id,
    phaseId,
    required: true,
    status: "missing",
    summary,
    artifactPath,
    reason
  };
}

function snapshotInputsMissingReason(before, after, kind) {
  const missing = [];
  if ((kind === "set" && !validStringSetInput(before)) ||
    (kind === "count" && !validSnapshotCount(before)) ||
    (kind === "value" && !validSnapshotValue(before))) {
    missing.push("before");
  }
  if ((kind === "set" && !validStringSetInput(after)) ||
    (kind === "count" && !validSnapshotCount(after)) ||
    (kind === "value" && !validSnapshotValue(after))) {
    missing.push("after");
  }
  return `${missing.join(" and ")} ${kind} evidence was not collected`;
}

function validStringSetInput(value) {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function validSnapshotCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function validSnapshotValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
