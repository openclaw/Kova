import {
  buildAuthCleanupPhase,
  buildAuthPreparePhase,
  buildAuthSetupPhase
} from "../auth.mjs";
import { quoteShell } from "../commands.mjs";
import { collectorArtifactDirs } from "../collectors/artifacts.mjs";
import {
  measurementScopeForPhase,
  normalizeMeasurementScope,
  phaseDriverKind,
  withPhaseContract
} from "../measurement-contract.mjs";
import { ocmEnvDestroy, ocmRuntimeBuildLocal } from "../ocm/commands.mjs";
import { repoRoot } from "../paths.mjs";
import {
  materializeLifecycleCommands,
  materializeScenarioPhaseCommands,
  safeSegment
} from "./phase-commands.mjs";
import { join } from "node:path";

export function buildPlannedPhases(scenario, context, envName, artifactDir, authPolicy) {
  const phases = [];
  const targetSetupPhase = buildTargetSetupPhase(context, envName);
  if (targetSetupPhase) {
    phases.push(targetSetupPhase);
  }

  const authPreparePhase = buildAuthPreparePhase(authPolicy, artifactDir);
  if (authPreparePhase) {
    phases.push(withPhaseContract(authPreparePhase, "harness"));
  }

  const preparePhase = buildStateLifecyclePhase(context, envName, scenario, "prepare", context.state?.prepare ?? [], artifactDir);
  if (preparePhase) {
    phases.push(preparePhase);
  }

  for (const phase of scenario.phases) {
    if (phase.id === "cleanup") {
      continue;
    }
    const commands = materializeScenarioPhaseCommands(phase, context, envName, artifactDir);
    phases.push({
      id: phase.id,
      title: phase.title,
      intent: phase.intent,
      healthScope: phase.healthScope,
      collectionIntent: phase.collectionIntent ?? null,
      measurementScope: measurementScopeForPhase(phase),
      driverKind: phaseDriverKind(phase, commands),
      expectedAgentFailure: phase.expectedAgentFailure === true,
      commands,
      evidence: phase.evidence ?? []
    });

    if (phaseSupportsAuthSetup(phase, authPolicy) && !phases.some((planned) => planned.id === "auth-setup")) {
      const authSetupPhase = buildAuthSetupPhase(authPolicy, envName, artifactDir);
      if (authSetupPhase) {
        phases.push(withPhaseContract(authSetupPhase, "harness"));
      }
    }

    const statePhase = buildStateLifecyclePhase(
      context,
      envName,
      scenario,
      `state-${phase.id}`,
      (context.state?.setup ?? []).filter((step) => stateStepMatchesPhase(step, phase.id)),
      artifactDir,
      phase.id
    );
    if (statePhase) {
      phases.push(statePhase);
    }

    const snapshotPhase = buildEvidenceSnapshotPhase(context, envName, scenario, phase.id, artifactDir);
    if (snapshotPhase) {
      phases.push(snapshotPhase);
    }
  }

  if (!context.keepEnv) {
    const authCleanupPhase = buildAuthCleanupPhase(authPolicy, artifactDir);
    if (authCleanupPhase) {
      phases.push(withPhaseContract(authCleanupPhase, "cleanup"));
    }
    const cleanupPhase = buildStateLifecyclePhase(context, envName, scenario, "cleanup", context.state?.cleanup ?? [], artifactDir);
    if (cleanupPhase) {
      phases.push(cleanupPhase);
    }
    phases.push({
      id: "env-cleanup",
      title: "Environment Cleanup",
      intent: "Destroy the disposable Kova env after the scenario finishes.",
      measurementScope: "cleanup",
      driverKind: "ocm",
      commands: [ocmEnvDestroy(envName)],
      evidence: ["temporary env destroyed"]
    });
  }

  return phases;
}

export function buildTargetSetupPhase(context, envName) {
  if (context.targetPlan.kind !== "local-build") {
    return null;
  }

  return {
    id: "target-setup",
    title: "Target Runtime Setup",
    intent: "Prepare the target OpenClaw runtime selector for the scenario.",
    measurementScope: "harness",
    driverKind: "ocm",
    commands: [targetSetupCommand(context.targetPlan)],
    evidence: [`local-build runtime ${context.targetPlan.runtimeName}`, `kova env ${envName}`]
  };
}

export function buildStateLifecyclePhase(context, envName, scenario, kind, steps, artifactDir, phaseId = null) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const { commands, evidence } = materializeLifecycleCommands(steps, context, envName, artifactDir);

  return {
    id: kind,
    title: stateLifecycleTitle(context.state?.id, kind, phaseId),
    intent: stateLifecycleIntent(context.state?.id, kind, phaseId),
    measurementScope: normalizeMeasurementScope(null, kind),
    driverKind: phaseDriverKind(null, commands),
    collectionIntent: stateLifecycleCollectionIntent(steps),
    commands,
    evidence,
    scenario: scenario.id
  };
}

export function buildEvidenceSnapshotPhase(context, envName, scenario, afterPhaseId, artifactDir) {
  const snapshots = evidenceSnapshotsAfterPhase(scenario, afterPhaseId);
  if (snapshots.length === 0) {
    return null;
  }

  const commands = [];
  const evidenceIds = [];
  const evidenceRequired = [];
  const evidenceArtifactPaths = [];
  const evidenceSummaries = [];

  for (const snapshot of snapshots) {
    const artifactPath = join(collectorArtifactDirs(artifactDir).collectors, "state-snapshots", `${safeSegment(snapshot.id)}.json`);
    commands.push(openClawStateSnapshotCommand({
      context,
      envName,
      label: snapshot.label ?? snapshot.id,
      artifactPath,
      maxFileBytes: snapshot.maxFileBytes
    }));
    evidenceIds.push(`snapshot:${snapshot.id}`);
    evidenceRequired.push(snapshot.required !== false);
    evidenceArtifactPaths.push(artifactPath);
    evidenceSummaries.push(snapshot.summary ?? `OpenClaw state snapshot after ${afterPhaseId}`);
  }

  return {
    id: `evidence-${afterPhaseId}-snapshots`,
    title: `Evidence Snapshots After ${afterPhaseId}`,
    intent: `Capture bounded OpenClaw state evidence after scenario phase '${afterPhaseId}'.`,
    healthScope: "none",
    measurementScope: "harness",
    driverKind: "ocm",
    evidenceKind: "snapshot",
    commands,
    evidence: evidenceIds,
    evidenceIds,
    evidenceRequired,
    evidenceArtifactPaths,
    evidenceSummaries
  };
}

export function compactOpenClawStateSnapshot(stdout, artifactPath) {
  try {
    const snapshot = JSON.parse(stdout);
    return {
      schemaVersion: snapshot.schemaVersion,
      label: snapshot.label,
      artifactPath,
      homePresent: snapshot.home?.present === true,
      fileCount: snapshot.budget?.fileCount ?? 0,
      totalBytes: snapshot.budget?.totalBytes ?? 0,
      truncatedCount: snapshot.budget?.truncatedCount ?? 0,
      omittedCount: snapshot.budget?.omittedCount ?? 0,
      redactedSecretKeyCount: snapshot.redaction?.secretKeyCount ?? 0,
      pluginInstallIndexCount: snapshot.plugins?.installIndexes?.length ?? 0,
      pluginDirCount: snapshot.plugins?.pluginDirs?.length ?? 0,
      installedPluginIds: (snapshot.plugins?.installed ?? []).map((plugin) => plugin.id).filter(Boolean).sort(),
      runtime: snapshot.runtime ?? null,
      service: snapshot.service ?? null,
      config: {
        fileCount: snapshot.config?.files?.length ?? 0,
        keys: snapshot.config?.keys ?? [],
        schemaVersions: snapshot.config?.schemaVersions ?? []
      },
      auth: {
        providerIds: snapshot.auth?.providerIds ?? [],
        authMethodShapes: snapshot.auth?.authMethodShapes ?? [],
        secretReferenceKeys: snapshot.auth?.secretReferenceKeys ?? []
      },
      models: {
        providerIds: snapshot.models?.providerIds ?? [],
        modelIds: snapshot.models?.modelIds ?? [],
        modelCount: snapshot.models?.modelCount ?? 0
      },
      workspace: {
        rootHashes: snapshot.workspace?.rootHashes ?? [],
        allowedRootCount: snapshot.workspace?.allowedRootCount ?? 0,
        durableBoundary: snapshot.workspace?.durableBoundary ?? null
      },
      cleanup: snapshot.cleanup ?? null
    };
  } catch (error) {
    return {
      artifactPath,
      parseError: error.message
    };
  }
}

export function stateLifecycleTitle(stateId, kind, phaseId) {
  if (kind === "prepare") {
    return `State Prepare (${stateId})`;
  }
  if (kind === "cleanup") {
    return `State Cleanup (${stateId})`;
  }
  return `State Setup After ${phaseId}`;
}

export function stateLifecycleIntent(stateId, kind, phaseId) {
  if (kind === "prepare") {
    return `Prepare Kova state '${stateId}' before scenario phases.`;
  }
  if (kind === "cleanup") {
    return `Clean up Kova state '${stateId}' fixture artifacts before env destruction.`;
  }
  return `Apply Kova state '${stateId}' setup after scenario phase '${phaseId}'.`;
}

export function stateStepMatchesPhase(step, phaseId) {
  if (Array.isArray(step.afterPhases)) {
    return step.afterPhases.includes(phaseId);
  }
  return step.afterPhase === phaseId;
}

export function stateLifecycleCommandScope(commands) {
  return commands.some((command) => /(?:^|\s)ocm(?:\s|$)/.test(command)) ? "env" : "host";
}

export function stateLifecycleCollectionIntent(steps) {
  const intents = new Set((steps ?? []).map((step) => step.collectionIntent).filter(Boolean));
  return intents.size === 1 ? [...intents][0] : null;
}

export function phaseSupportsAuthSetup(phase, authPolicy) {
  if (!authPolicy?.setup) {
    return false;
  }
  const commands = phase.commands ?? [];
  return commands.some((command) => /\bocm\s+(start|env clone)\b/.test(command));
}

export function targetSetupCommand(targetPlan) {
  return ocmRuntimeBuildLocal(targetPlan.runtimeName, targetPlan.repoPath);
}

function evidenceSnapshotsAfterPhase(scenario, afterPhaseId) {
  return (scenario.evidenceContract?.snapshots ?? []).filter((snapshot) => snapshot.afterPhase === afterPhaseId);
}

function openClawStateSnapshotCommand({ context, envName, label, artifactPath, maxFileBytes }) {
  const args = [
    "node",
    quoteShell(join(repoRoot, "support", "capture-openclaw-state.mjs")),
    "--label",
    quoteShell(label),
    "--output",
    quoteShell(artifactPath),
    "--target-kind",
    quoteShell(context.targetPlan.kind),
    "--target-value",
    quoteShell(context.targetPlan.value)
  ];
  if (context.targetPlan.runtimeName) {
    args.push("--runtime-name", quoteShell(context.targetPlan.runtimeName));
  }
  if (!context.keepEnv) {
    args.push("--cleanup-expected");
  }
  if (maxFileBytes) {
    args.push("--max-file-bytes", String(maxFileBytes));
  }
  return `ocm env exec ${quoteShell(envName)} -- ${args.join(" ")}`;
}
