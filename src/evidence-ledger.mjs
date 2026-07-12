import { RECORD_STATUS } from "./statuses.mjs";
import {
  commandResultFailureReason,
  commandResultFailed,
  commandResultPassed
} from "./measurement-contract.mjs";
import {
  validGatewayState,
  validHealthSamples,
  validHealthSummaryFailureCount
} from "./health.mjs";

export const EVIDENCE_LEDGER_SCHEMA = "kova.evidenceLedger.v1";

export function attachEvidenceLedger(record) {
  record.evidenceLedger = buildEvidenceLedger(record);
  return record;
}

export function applyEvidenceLedgerGating(record) {
  const ledger = record.evidenceLedger ?? buildEvidenceLedger(record);
  record.evidenceLedger = ledger;

  if (record.status === RECORD_STATUS.DRY_RUN || record.status === RECORD_STATUS.SKIPPED) {
    return record;
  }

  const missing = ledger.entries.filter((entry) => entry.required && entry.status === "missing");
  const failed = ledger.entries.filter((entry) => entry.required && entry.status === "failed");
  const failedCommands = failed.filter((entry) => entry.category === "command");
  const failedInvariants = failed.filter((entry) => entry.category === "invariant");
  const failedChannelCapabilities = failed.filter((entry) => entry.category === "channel-capability");
  const failedEvidence = failed.filter((entry) => !isBehaviorFailureCategory(entry.category));
  ledger.completeness = missing.length > 0 || failedEvidence.length > 0 ? "incomplete" : "complete";
  ledger.summary.requiredMissing = missing.length;
  ledger.summary.requiredFailed = failed.length;

  if (record.status === RECORD_STATUS.PASS && (failedCommands.length > 0 || failedInvariants.length > 0 || failedChannelCapabilities.length > 0)) {
    record.status = RECORD_STATUS.FAIL;
  }
  if (record.status === RECORD_STATUS.PASS && (missing.length > 0 || failedEvidence.length > 0)) {
    record.status = RECORD_STATUS.INCOMPLETE;
    const incomplete = [...missing, ...failedEvidence];
    record.incompleteReason = `${incomplete.length} required evidence ledger entr${incomplete.length === 1 ? "y was" : "ies were"} incomplete`;
    record.incompleteEvidence = incomplete.slice(0, 5).map((entry) => entry.id);
  }

  return record;
}

export function buildEvidenceLedger(record) {
  const entries = [];
  for (const phase of record.phases ?? []) {
    const commands = phase.commands ?? [];
    const results = phase.results ?? [];
    const blockingCommand = firstFailedCommandInPhase(phase, results);
    for (const [index, command] of commands.entries()) {
      const result = results[index] ?? null;
      entries.push(commandEntry({ record, phase, index, command, result, blockingCommand }));
    }
  }
  for (const invariant of record.evidenceInvariants ?? []) {
    entries.push(invariantEntry(invariant));
  }
  for (const artifact of record.evidenceArtifacts ?? []) {
    entries.push(artifactEntry(artifact));
  }
  for (const cleanup of record.cleanupEvidence ?? []) {
    entries.push(cleanupEntry(cleanup));
  }
  for (const capability of record.channelCapabilityEvidence ?? []) {
    entries.push(channelCapabilityEntry(capability));
  }
  if (record.status !== RECORD_STATUS.DRY_RUN && record.status !== RECORD_STATUS.SKIPPED) {
    entries.push(finalMetricsEntry(record.finalMetrics));
  }

  return {
    schemaVersion: EVIDENCE_LEDGER_SCHEMA,
    completeness: record.status === RECORD_STATUS.DRY_RUN ? "not-evaluated" : completenessForEntries(entries),
    summary: summarizeEntries(entries),
    entries
  };
}

function channelCapabilityEntry(capability) {
  return {
    id: `channel-capability:${capability.channelId}:${capability.group}:${capability.capabilityId}`,
    category: "channel-capability",
    required: capability.required !== false,
    status: capability.status,
    phaseId: capability.phaseId ?? null,
    commandIndex: capability.commandIndex ?? null,
    summary: capability.summary,
    artifactPath: capability.artifactPath ?? null,
    reason: capability.reason ?? null,
    channelId: capability.channelId,
    capabilityId: capability.capabilityId,
    group: capability.group,
    proofMode: capability.proofMode ?? null,
    failureOwner: capability.failureOwner ?? null,
    ownerArea: capability.ownerArea ?? null
  };
}

function cleanupEntry(cleanup) {
  return {
    id: `cleanup:${cleanup.id}`,
    category: "cleanup",
    required: cleanup.required !== false,
    status: cleanup.status,
    phaseId: cleanup.phaseId ?? null,
    commandIndex: null,
    summary: cleanup.summary,
    artifactPath: cleanup.artifactPath ?? null,
    reason: cleanup.reason ?? null
  };
}

function artifactEntry(artifact) {
  return {
    id: `artifact:${artifact.id}`,
    category: "artifact",
    required: artifact.required !== false,
    status: artifact.status,
    phaseId: artifact.phaseId ?? null,
    commandIndex: null,
    summary: artifact.summary,
    artifactPath: artifact.artifactPath ?? null,
    reason: artifact.reason ?? null
  };
}

function invariantEntry(invariant) {
  return {
    id: `invariant:${invariant.id}`,
    category: "invariant",
    required: invariant.required !== false,
    status: invariant.status,
    phaseId: invariant.phaseId ?? null,
    commandIndex: null,
    summary: invariant.summary,
    artifactPath: invariant.artifactPath ?? null,
    reason: invariant.reason ?? null
  };
}

function finalMetricsEntry(metrics) {
  const evidence = finalMetricsEvidence(metrics);
  return {
    id: "collector:final-metrics",
    category: "collector",
    required: true,
    status: evidence.status,
    phaseId: "final",
    commandIndex: null,
    summary: "final service and health metrics were collected",
    artifactPath: null,
    reason: evidence.reason
  };
}

function finalMetricsEvidence(metrics) {
  if (!metrics) {
    return { status: "missing", reason: "final metrics were not collected" };
  }
  if (metrics.error !== null && metrics.error !== undefined) {
    return {
      status: "failed",
      reason: String(metrics.error) || "final metrics collection failed"
    };
  }
  if (!validGatewayState(metrics.service?.gatewayState)) {
    return { status: "missing", reason: "final service state was not collected" };
  }
  const healthSamples = validHealthSamples(metrics.healthSamples);
  const healthSummary = validHealthSummaryFailureCount(metrics.healthSummary) !== null;
  const healthResult = typeof metrics.health?.ok === "boolean";
  if (!healthSamples && !healthSummary && !healthResult) {
    return { status: "missing", reason: "final health evidence was not collected" };
  }
  return { status: "passed", reason: null };
}

function isBehaviorFailureCategory(category) {
  return category === "command" || category === "invariant" || category === "channel-capability";
}

function completenessForEntries(entries) {
  return entries.some((entry) =>
    entry.required &&
    (entry.status === "missing" || (entry.status === "failed" && !isBehaviorFailureCategory(entry.category)))
  )
    ? "incomplete"
    : "complete";
}

function commandEntry({ record, phase, index, command, result, blockingCommand }) {
  const executed = record.status !== RECORD_STATUS.DRY_RUN;
  const category = result?.evidenceKind ?? phase.evidenceKind ?? "command";
  const evidenceId = result?.evidenceId ?? phase.evidenceIds?.[index] ?? `command:${phase.id}:${index + 1}`;
  const status = commandStatus({ executed, result, blockingCommand });
  return {
    id: evidenceId,
    category,
    required: result?.evidenceRequired ?? phase.evidenceRequired?.[index] ?? true,
    status,
    phaseId: phase.id,
    commandIndex: index,
    summary: result?.evidenceSummary ?? phase.evidenceSummaries?.[index] ?? summarizeCommand(command),
    artifactPath: result?.evidenceArtifactPath ?? phase.evidenceArtifactPaths?.[index] ?? null,
    reason: result?.evidenceReason ?? commandReason({ executed, result, status, blockingCommand })
  };
}

function commandStatus({ executed, result, blockingCommand }) {
  if (!executed) {
    return "skipped";
  }
  if (!result) {
    if (blockingCommand) {
      return "failed";
    }
    return "missing";
  }
  if (result.evidenceStatus) {
    return result.evidenceStatus;
  }
  if (commandResultPassed(result)) {
    return "passed";
  }
  return commandResultFailed(result) ? "failed" : "missing";
}

function commandReason({ executed, result, status, blockingCommand }) {
  if (!executed) {
    return "dry-run command was planned but not executed";
  }
  if (status === "missing") {
    return result
      ? "command result did not contain passing or failing evidence"
      : "command was planned but no result was recorded";
  }
  if (status === "failed") {
    if (!result) {
      return `not executed because ${blockingCommand.id} in phase "${blockingCommand.phaseId}" failed: ${blockingCommand.summary} (${blockingCommand.reason})`;
    }
    return commandResultFailureReason(result);
  }
  return null;
}

function firstFailedCommandInPhase(phase, results) {
  for (const [index, result] of results.entries()) {
    if (!commandResultFailed(result)) {
      continue;
    }
    return {
      id: result.evidenceId ?? phase.evidenceIds?.[index] ?? `command:${phase.id}:${index + 1}`,
      phaseId: phase.id,
      summary: result.evidenceSummary ?? phase.evidenceSummaries?.[index] ?? summarizeCommand(result.command),
      reason: commandResultFailureReason(result)
    };
  }
  return null;
}

function summarizeEntries(entries) {
  const byStatus = {};
  const byCategory = {};
  let required = 0;
  let requiredMissing = 0;
  let requiredFailed = 0;
  for (const entry of entries) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    if (entry.required) {
      required += 1;
      if (entry.status === "missing") {
        requiredMissing += 1;
      }
      if (entry.status === "failed") {
        requiredFailed += 1;
      }
    }
  }
  return {
    total: entries.length,
    required,
    requiredMissing,
    requiredFailed,
    byStatus,
    byCategory
  };
}

function summarizeCommand(command) {
  if (typeof command !== "string") {
    return "unknown command";
  }
  return command.length <= 160 ? command : `${command.slice(0, 157)}...`;
}
