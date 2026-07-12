import {
  collectedLogArtifactPath,
  collectedLogsOk,
  collectedLogsProof,
  collectedLogsReason,
  compareSnapshotCountInvariant,
  compareSnapshotEqualityInvariant,
  compareSnapshotSetInvariant,
  findCommandResult,
  findSnapshotResult,
  unionStrings,
  zeroCountInvariant
} from "./shared.mjs";
import {
  commandResultFailed,
  commandResultPassed
} from "../measurement-contract.mjs";

export function buildUpgradeLogDerivedInvariants(record) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;
  const doctor = findCommandResult(record, (result) => result.command?.includes(" -- doctor"));
  const logsProof = collectedLogsProof(record, "post-upgrade");
  const postUpgradeBlocker = failedCommandBeforeOrInPhase(record, "post-upgrade");
  const logsOk = collectedLogsOk(logsProof);
  const doctorStatus = doctorOutputStatus(doctor);

  return [
    {
      id: "upgrade-logs-captured",
      phaseId: "post-upgrade",
      required: true,
      status: logsOk ? "passed" : postUpgradeBlocker ? "failed" : "missing",
      summary: "post-upgrade gateway logs were captured for dependency and plugin-load checks",
      artifactPath: collectedLogArtifactPath(record),
      reason: logsOk ? null : postUpgradeBlocker?.reason ?? collectedLogsReason(logsProof)
    },
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
      status: doctorStatus === "passed" ? "passed" : postUpgradeBlocker ? "failed" : doctorStatus,
      summary: "post-upgrade doctor output was captured for interpretation",
      artifactPath: null,
      reason: doctorStatus === "passed" ? null : postUpgradeBlocker?.reason ?? doctorOutputReason(doctor)
    }
  ];
}

function doctorOutputStatus(result) {
  if (!result) {
    return "missing";
  }
  if (commandResultFailed(result)) {
    return "failed";
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.length > 0 ? "passed" : "missing";
}

function doctorOutputReason(result) {
  if (!result) {
    return "doctor command result was not recorded";
  }
  if (commandResultFailed(result)) {
    return `doctor command exited ${result.status ?? result.exitCode ?? "unknown"}`;
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
  const snapshotBlocker = failedCommandBeforeOrInPhase(record, "post-upgrade");
  const snapshotsPresent = Boolean(pre?.snapshot && post?.snapshot);
  const invariants = [];

  invariants.push({
    id: "upgrade-state-snapshots-present",
    phaseId: "evidence-post-upgrade-snapshots",
    required: true,
    status: snapshotsPresent ? "passed" : snapshotBlocker ? "failed" : "missing",
    summary: "pre-upgrade and post-upgrade OpenClaw state snapshots were collected",
    artifactPath: post?.evidenceArtifactPath ?? pre?.evidenceArtifactPath ?? null,
    reason: snapshotsPresent ? null : snapshotBlocker?.reason ?? "required upgrade state snapshot result was not recorded"
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

function failedCommandBeforeOrInPhase(record, phaseId) {
  const phases = record.phases ?? [];
  const targetIndex = phases.findIndex((phase) => phase.id === phaseId);
  const lastIndex = targetIndex === -1 ? phases.length - 1 : targetIndex;
  for (const [phaseIndex, phase] of phases.entries()) {
    if (phaseIndex > lastIndex) {
      break;
    }
    for (const [resultIndex, result] of (phase.results ?? []).entries()) {
      if (!result || commandResultPassed(result)) {
        continue;
      }
      const command = result.command ?? phase.commands?.[resultIndex] ?? "unknown command";
      return {
        phaseId: phase.id ?? "unknown",
        command,
        reason: `not collected because phase "${phase.id ?? "unknown"}" failed at command ${resultIndex + 1}: ${shortCommand(command)} (${failedResultLabel(result)})`
      };
    }
  }
  return null;
}

function shortCommand(command) {
  return typeof command === "string" && command.length > 160
    ? `${command.slice(0, 157)}...`
    : String(command ?? "unknown command");
}

function failedResultLabel(result) {
  return result?.timedOut
    ? "command timed out"
    : `command exited ${result?.status ?? result?.exitCode ?? "unknown"}`;
}
