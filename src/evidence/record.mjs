import { stat } from "node:fs/promises";
import { collectRecordMetricObjects } from "./metrics.mjs";

export function attachCleanupEvidence(record) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return record;
  }
  const retainedByRequest = record.cleanup === "retained" && record.retainedReason === "keep-env";
  if (retainedByRequest) {
    record.cleanupEvidence = [{
      id: "env-cleanup",
      required: false,
      status: "skipped",
      phaseId: "env-cleanup",
      summary: "disposable Kova env cleanup was explicitly skipped by keep-env",
      reason: "keep-env requested"
    }];
    return record;
  }

  const cleanupStatus = cleanupEvidenceStatus(record.cleanup);
  record.cleanupEvidence = [{
    id: "env-cleanup",
    required: true,
    status: cleanupStatus,
    phaseId: "env-cleanup",
    summary: "disposable Kova env cleanup completed or was explicitly accounted for",
    reason: cleanupEvidenceReason(record.cleanup)
  }];
  return record;
}

function cleanupEvidenceStatus(cleanup) {
  if (["destroyed", "already-absent", "not-needed"].includes(cleanup)) {
    return "passed";
  }
  if (cleanup === "destroy-failed") {
    return "failed";
  }
  return "missing";
}

function cleanupEvidenceReason(cleanup) {
  if (["destroyed", "already-absent", "not-needed"].includes(cleanup)) {
    return null;
  }
  if (cleanup === "destroy-failed") {
    return "env destroy command failed";
  }
  return "cleanup result was not recorded";
}

export async function attachEvidenceArtifactBudget(record, scenario = null) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return record;
  }
  const maxBytes = evidenceArtifactMaxBytes(scenario);
  const phaseArtifactPaths = (record.phases ?? [])
    .flatMap((phase) => phase.results ?? [])
    .map((result) => result.evidenceArtifactPath)
    .filter(Boolean);
  const providerArtifactPaths = Array.isArray(record.providerEvidence?.artifacts)
    ? record.providerEvidence.artifacts.filter(Boolean)
    : [];
  const metricArtifactPaths = collectEvidenceMetricArtifactPaths(record);
  const paths = [...new Set([...phaseArtifactPaths, ...providerArtifactPaths, ...metricArtifactPaths])];
  let totalBytes = 0;
  let missingCount = 0;
  const artifacts = [];
  for (const path of paths) {
    try {
      const stats = await stat(path);
      totalBytes += stats.size;
      artifacts.push({ path, bytes: stats.size });
    } catch {
      missingCount += 1;
      artifacts.push({ path, bytes: null });
    }
  }

  record.evidenceArtifactBudget = {
    schemaVersion: "kova.evidenceArtifactBudget.v1",
    maxBytes,
    totalBytes,
    artifactCount: paths.length,
    missingCount,
    exceeded: totalBytes > maxBytes,
    artifacts: artifacts.slice(0, 20)
  };
  record.evidenceArtifacts = [{
    id: "record-budget",
    required: true,
    status: totalBytes <= maxBytes && missingCount === 0 ? "passed" : "failed",
    summary: "total retained evidence artifact bytes stay within the per-record cap",
    artifactPath: null,
    reason: artifactBudgetReason({ totalBytes, maxBytes, missingCount })
  }];
  return record;
}

function evidenceArtifactMaxBytes(scenario) {
  const value = scenario?.evidenceArtifactMaxBytes;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return 5 * 1024 * 1024;
}

function collectEvidenceMetricArtifactPaths(record) {
  const paths = [];
  for (const metrics of collectRecordMetricObjects(record)) {
    paths.push(...artifactPathArray(metrics.logs?.artifacts));
    paths.push(...artifactPathArray(metrics.timeline?.artifacts));
    paths.push(...artifactPathArray(metrics.timeline?.timelineArtifacts));
  }
  paths.push(...artifactPathArray(record.measurements?.resourceSampleArtifacts));
  paths.push(...artifactPathArray(record.measurements?.openclawTimelineArtifacts));
  paths.push(...artifactPathArray([record.measurements?.officialPluginEvidence?.artifactPath]));
  for (const run of record.measurements?.officialPluginEvidence?.runs ?? []) {
    paths.push(...artifactPathArray([run.artifactPath]));
  }
  return paths;
}


function artifactPathArray(value) {
  return Array.isArray(value) ? value.filter((path) => typeof path === "string" && path.length > 0) : [];
}

function artifactBudgetReason({ totalBytes, maxBytes, missingCount }) {
  if (missingCount > 0) {
    return `${missingCount} evidence artifact path(s) could not be statted`;
  }
  if (totalBytes > maxBytes) {
    return `evidence artifacts used ${totalBytes} bytes over cap ${maxBytes}`;
  }
  return null;
}
