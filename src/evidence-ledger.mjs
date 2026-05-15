import { RECORD_STATUS } from "./statuses.mjs";

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
  const failedEvidence = failed.filter((entry) => entry.category !== "command" && entry.category !== "invariant");
  const failedInvariants = failed.filter((entry) => entry.category === "invariant");
  ledger.completeness = missing.length > 0 || failedEvidence.length > 0 ? "incomplete" : "complete";
  ledger.summary.requiredMissing = missing.length;
  ledger.summary.requiredFailed = failed.length;

  if (record.status === RECORD_STATUS.PASS && (failedCommands.length > 0 || failedInvariants.length > 0)) {
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
    for (const [index, command] of commands.entries()) {
      const result = results[index] ?? null;
      entries.push(commandEntry({ record, phase, index, command, result }));
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

  return {
    schemaVersion: EVIDENCE_LEDGER_SCHEMA,
    completeness: record.status === RECORD_STATUS.DRY_RUN ? "not-evaluated" : completenessForEntries(entries),
    summary: summarizeEntries(entries),
    entries
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

function completenessForEntries(entries) {
  return entries.some((entry) => entry.required && entry.status === "missing")
    ? "incomplete"
    : "complete";
}

function commandEntry({ record, phase, index, command, result }) {
  const executed = record.status !== RECORD_STATUS.DRY_RUN;
  const category = result?.evidenceKind ?? phase.evidenceKind ?? "command";
  const evidenceId = result?.evidenceId ?? phase.evidenceIds?.[index] ?? `command:${phase.id}:${index + 1}`;
  const status = commandStatus({ executed, result });
  return {
    id: evidenceId,
    category,
    required: result?.evidenceRequired ?? phase.evidenceRequired?.[index] ?? true,
    status,
    phaseId: phase.id,
    commandIndex: index,
    summary: result?.evidenceSummary ?? phase.evidenceSummaries?.[index] ?? summarizeCommand(command),
    artifactPath: result?.evidenceArtifactPath ?? phase.evidenceArtifactPaths?.[index] ?? null,
    reason: result?.evidenceReason ?? commandReason({ executed, result, status })
  };
}

function commandStatus({ executed, result }) {
  if (!executed) {
    return "skipped";
  }
  if (!result) {
    return "missing";
  }
  if (result.evidenceStatus) {
    return result.evidenceStatus;
  }
  return result.status === 0 ? "passed" : "failed";
}

function commandReason({ executed, result, status }) {
  if (!executed) {
    return "dry-run command was planned but not executed";
  }
  if (status === "missing") {
    return "command was planned but no result was recorded";
  }
  if (status === "failed") {
    if (result?.timedOut) {
      return "command timed out";
    }
    return `command exited ${result?.status ?? "unknown"}`;
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
