import { runCommand } from "./commands.mjs";
import { normalizeOptionalCommandResult } from "./command-results.mjs";
import {
  buildAuthCleanupPhase,
  buildAuthPreparePhase,
  buildAuthSetupPhase,
  scenarioAuthPolicy
} from "./auth.mjs";
import { runCleanupCommand } from "./cleanup.mjs";
import { applyEvidenceLedgerGating, attachEvidenceLedger } from "./evidence-ledger.mjs";
import {
  attachEvidenceInvariants
} from "./evidence/invariants.mjs";
import {
  attachCleanupEvidence,
  attachEvidenceArtifactBudget
} from "./evidence/record.mjs";
import { quoteShell } from "./commands.mjs";
import { ocmEnvDestroy, ocmRuntimeBuildLocal } from "./ocm/commands.mjs";
import {
  materializeLifecycleCommands,
  materializeLifecycleStepCommands,
  materializeScenarioPhaseCommands,
  safeSegment
} from "./run/phase-commands.mjs";
import { captureProcessSnapshot, diffProcessSnapshots } from "./collectors/resources.mjs";
import { collectEnvMetrics, collectNodeProfileMetrics } from "./metrics.mjs";
import { collectorArtifactDirs, prepareCollectorArtifactDirs } from "./collectors/artifacts.mjs";
import { collectProviderEvidence } from "./collectors/provider.mjs";
import { resolveCollectionPolicy } from "./collection-policy.mjs";
import { evaluateRecord } from "./evaluator.mjs";
import {
  isAgentMessageCommand,
  measurementScopeForPhase,
  normalizeMeasurementScope,
  phaseDriverKind,
  phaseResultStatus,
  readinessHardTimeoutForPhase,
  readinessThresholdForPhase,
  tagCommandResult,
  withPhaseContract
} from "./measurement-contract.mjs";
import { artifactsDir } from "./paths.mjs";
import { repoRoot } from "./paths.mjs";
import { assertKovaEnvName, assertSafeScenarioCommand } from "./safety.mjs";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export function createRunId() {
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  return `kova-${stamp}`;
}

export function buildDryRunRecord(scenario, context) {
  const envName = envNameFor(scenario.id, context.state?.id, context.runId, context.repeat);
  const artifactDir = join(artifactsDir, context.runId, envName);
  const authPolicy = scenarioAuthPolicy(context, scenario, context.state);

  return attachEvidenceLedger({
    scenario: scenario.id,
    surface: scenario.surface,
    title: scenario.title,
    status: "DRY-RUN",
    target: context.target,
    from: context.from ?? null,
    state: stateSummary(context.state),
    repeat: repeatSummary(context.repeat),
    envName,
    likelyOwner: "OpenClaw",
    objective: scenario.objective,
    thresholds: scenario.thresholds,
    cleanup: context.keepEnv ? "retained" : "planned",
    auth: authPolicy.summary,
    profiling: profilingSummary(context),
    collectorArtifactDirs: collectorArtifactDirs(artifactDir),
    phases: buildPlannedPhases(scenario, context, envName, artifactDir, authPolicy)
  });
}

export function buildSkippedRecord(scenario, context, reason) {
  const record = buildDryRunRecord(scenario, context);
  record.status = "SKIPPED";
  record.skipReason = reason;
  record.cleanup = "not-needed";
  record.phases = [];
  return attachEvidenceLedger(record);
}

export async function executeScenario(scenario, context) {
  const envName = envNameFor(scenario.id, context.state?.id, context.runId, context.repeat);
  assertKovaEnvName(envName, "generated env");
  const artifactDir = join(artifactsDir, context.runId, envName);
  const record = buildDryRunRecord(scenario, context);
  const authPolicy = scenarioAuthPolicy(context, scenario, context.state);
  record.status = "PASS";
  record.startedAt = new Date().toISOString();
  record.artifactDir = artifactDir;
  record.collectorArtifactDirs = collectorArtifactDirs(artifactDir);
  record.phases = [];

  let scenarioFailed = false;

  try {
    record.collectorArtifactDirs = await prepareCollectorArtifactDirs(artifactDir, context);
    context.onPhase?.("target setup");
    const setupResults = await executeTargetSetup(context, envName, artifactDir);
    if (setupResults.length > 0) {
      record.phases.push({
        id: "target-setup",
        title: "Target Runtime Setup",
        intent: "Prepare the target OpenClaw runtime selector for the scenario.",
        measurementScope: "harness",
        driverKind: "ocm",
        commands: setupResults.map((result) => result.command),
        evidence: [],
        results: setupResults
      });
      if (setupResults.some((result) => result.status !== 0)) {
        record.status = "BLOCKED";
        scenarioFailed = true;
      }
    }

    if (!scenarioFailed) {
      const authPreparePhase = await executeAuthPhase(
        buildAuthPreparePhase(authPolicy, artifactDir),
        context,
        envName,
        artifactDir,
        authPolicy
      );
      if (authPreparePhase) {
        context.onPhase?.("auth prepare");
        record.phases.push(authPreparePhase);
        if (authPreparePhase.results.some((result) => result.status !== 0)) {
          record.status = "BLOCKED";
          scenarioFailed = true;
        }
      }
    }

    if (!scenarioFailed) {
      context.onPhase?.("state prepare");
      const preparePhase = await executeStateLifecycleSteps(context, envName, scenario, "prepare", context.state?.prepare ?? [], artifactDir, null, authPolicy);
      if (preparePhase) {
        record.phases.push(preparePhase);
        if (preparePhase.results.some((result) => result.status !== 0)) {
          scenarioFailed = true;
          record.status = "FAIL";
        }
      }
    }

    if (!scenarioFailed) {
      for (const phase of scenario.phases) {
        if (phase.id === "cleanup") {
          continue;
        }

        context.onPhase?.(phase.title ?? phase.id);
        const commands = materializeScenarioPhaseCommands(phase, context, envName, artifactDir);
        const results = [];
        for (const [commandIndex, command] of commands.entries()) {
          const result = await runScenarioCommand(command, context, envName, artifactDir, phase.id, commandIndex, authPolicy);
          results.push(result);
          if (result.status !== 0) {
            scenarioFailed = true;
            record.status = classifyCommandFailure(result);
            break;
          }
        }

        record.phases.push({
          id: phase.id,
          title: phase.title,
          intent: phase.intent,
          healthScope: phase.healthScope,
          collectionIntent: phase.collectionIntent ?? null,
          measurementScope: measurementScopeForPhase(phase),
          driverKind: phaseDriverKind(phase, commands),
          expectedAgentFailure: phase.expectedAgentFailure === true,
          commands,
          evidence: phase.evidence ?? [],
          results,
          metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, phase, artifactDir, {
            kind: "scenario-phase",
            resultStatus: phaseResultStatus(results)
          }))
        });

        const authSetupPhase = shouldApplyAuthAfterPhase(phase, authPolicy, record)
          ? await executeAuthPhase(buildAuthSetupPhase(authPolicy, envName, artifactDir), context, envName, artifactDir, authPolicy)
          : null;
        if (authSetupPhase) {
          record.phases.push(authSetupPhase);
          record.auth = authPolicy.summary;
          record.auth.applied = authSetupPhase.results.every((result) => result.status === 0);
          if (authSetupPhase.results.some((result) => result.status !== 0)) {
            scenarioFailed = true;
            record.status = "BLOCKED";
          }
        }
        if (scenarioFailed) {
          break;
        }

        const statePhase = await executeStateSetupAfterPhase(context, envName, phase.id, scenario, artifactDir, authPolicy);
        if (statePhase) {
          record.phases.push(statePhase);
          if (statePhase.results.some((result) => result.status !== 0)) {
            scenarioFailed = true;
            record.status = "FAIL";
          }
        }

        if (scenarioFailed) {
          break;
        }

        const snapshotPhase = await executeEvidenceSnapshotPhase(context, envName, scenario, phase.id, artifactDir, authPolicy);
        if (snapshotPhase) {
          record.phases.push(snapshotPhase);
          if (snapshotPhase.results.some((result) => result.status !== 0)) {
            scenarioFailed = true;
            record.status = "INCOMPLETE";
          }
        }

        if (scenarioFailed) {
          break;
        }
      }
    }
  } finally {
    record.finishedAt = new Date().toISOString();
    record.finalMetrics = await collectEnvMetrics(envName, metricOptions(context, scenario, null, artifactDir, {
      kind: "final"
    }));
    record.providerEvidence = await collectProviderEvidence(artifactDir, { authPolicy });
    evaluateRecord(record, scenario, evaluatorContext(context, scenario));

    if (shouldCaptureFailureDiagnostics(record, context)) {
      record.failureDiagnostics = await collectEnvMetrics(envName, {
        ...metricOptions(context, scenario, null, artifactDir, {
          kind: "failure-diagnostics"
        }),
        readinessTimeoutMs: 0,
        heapSnapshot: true,
        diagnosticReport: true
      });
    }

    const shouldRetain = context.keepEnv || (context.retainOnFailure && record.status !== "PASS");
    if (!shouldRetain) {
      context.onPhase?.("cleanup");
      const authCleanupPhase = await executeAuthPhase(
        buildAuthCleanupPhase(authPolicy, artifactDir),
        context,
        envName,
        artifactDir,
        authPolicy
      );
      if (authCleanupPhase) {
        record.phases.push(authCleanupPhase);
        if (authCleanupPhase.results.some((result) => result.status !== 0) && record.status === "PASS") {
          record.status = "BLOCKED";
        }
      }
      const cleanupPhase = await executeStateLifecycleSteps(context, envName, scenario, "cleanup", context.state?.cleanup ?? [], artifactDir, null, authPolicy);
      if (cleanupPhase) {
        record.phases.push(cleanupPhase);
        if (cleanupPhase.results.some((result) => result.status !== 0) && record.status === "PASS") {
          record.status = "BLOCKED";
        }
      }
    }
    if (!shouldRetain) {
      const cleanup = await runCleanupCommand(ocmEnvDestroy(envName), { timeoutMs: context.timeoutMs });
      record.cleanup = classifyEnvDestroyCleanup(cleanup);
      record.cleanupResult = cleanup;
      if (record.cleanup === "destroy-failed" && record.status === "PASS") {
        record.status = "BLOCKED";
      }
    } else {
      record.cleanup = "retained";
      record.retainedReason = context.keepEnv ? "keep-env" : "failure";
    }

    if (context.nodeProfile === true || context.deepProfile === true) {
      record.postCleanupNodeProfiles = await collectNodeProfileMetrics(artifactDir);
      record.finalMetrics = record.finalMetrics ?? {};
      record.finalMetrics.nodeProfiles = record.postCleanupNodeProfiles;
      attachNodeProfileMeasurements(record);
    }

    evaluateRecord(record, scenario, evaluatorContext(context, scenario));
    attachEvidenceInvariants(record, scenario);
    attachCleanupEvidence(record);
    await attachEvidenceArtifactBudget(record);
    attachEvidenceLedger(record);
    applyEvidenceLedgerGating(record);
  }

  return record;
}

function shouldCaptureFailureDiagnostics(record, context) {
  if (!(context.deepProfile === true || context.profileOnFailure === true)) {
    return false;
  }
  if (record.status === "PASS") {
    return false;
  }
  return record.cleanup !== "retained";
}

function attachNodeProfileMeasurements(record) {
  if (!record.measurements) {
    record.measurements = {};
  }
  const profiles = record.postCleanupNodeProfiles;
  if (!profiles) {
    return;
  }
  const topCpu = profiles.cpuProfileSummary?.topFunctions?.[0];
  const topHeap = profiles.heapProfileSummary?.topFunctions?.[0];
  record.measurements.nodeCpuProfileCount = profiles.cpuProfileCount ?? record.measurements.nodeCpuProfileCount ?? 0;
  record.measurements.nodeHeapProfileCount = profiles.heapProfileCount ?? record.measurements.nodeHeapProfileCount ?? 0;
  record.measurements.nodeTraceEventCount = profiles.traceEventCount ?? record.measurements.nodeTraceEventCount ?? 0;
  record.measurements.nodeProfileArtifactBytes = profiles.artifactBytes ?? record.measurements.nodeProfileArtifactBytes ?? 0;
  record.measurements.nodeProfileTopFunction = topCpu?.functionName ?? record.measurements.nodeProfileTopFunction ?? null;
  record.measurements.nodeProfileTopFunctionMs = topCpu?.selfMs ?? record.measurements.nodeProfileTopFunctionMs ?? null;
  record.measurements.nodeProfileTopFunctionUrl = topCpu?.url ?? record.measurements.nodeProfileTopFunctionUrl ?? null;
  record.measurements.nodeHeapTopFunction = topHeap?.functionName ?? record.measurements.nodeHeapTopFunction ?? null;
  record.measurements.nodeHeapTopFunctionMb = topHeap?.selfSizeMb ?? record.measurements.nodeHeapTopFunctionMb ?? null;
  record.measurements.nodeHeapTopFunctionUrl = topHeap?.url ?? record.measurements.nodeHeapTopFunctionUrl ?? null;
}

function profilingSummary(context) {
  const enabled = context.nodeProfile === true ||
    context.deepProfile === true ||
    context.heapSnapshot === true ||
    context.diagnosticReport === true ||
    context.profileOnFailure === true;
  return {
    schemaVersion: "kova.profiling.v1",
    enabled,
    deepProfile: context.deepProfile === true,
    nodeProfile: context.nodeProfile === true,
    heapSnapshot: context.heapSnapshot === true,
    diagnosticReport: context.diagnosticReport === true,
    profileOnFailure: context.profileOnFailure === true,
    affectsResourceMeasurements: enabled,
    baselineEligible: !enabled,
    interpretation: enabled
      ? "instrumented run; CPU/RSS can include profiler and diagnostic overhead"
      : "normal user-path resource measurements"
  };
}

function classifyEnvDestroyCleanup(result) {
  if (result.status === 0) {
    return "destroyed";
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/\benvironment\b[\s\S]*\bdoes not exist\b/i.test(output) || /\bnot found\b/i.test(output)) {
    return "already-absent";
  }

  return "destroy-failed";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeStateSetupAfterPhase(context, envName, phaseId, scenario, artifactDir, authPolicy) {
  const steps = (context.state?.setup ?? []).filter((step) => stateStepMatchesPhase(step, phaseId));
  if (steps.length === 0) {
    return null;
  }

  return executeStateLifecycleSteps(context, envName, scenario, `state-${phaseId}`, steps, artifactDir, phaseId, authPolicy);
}

function buildPlannedPhases(scenario, context, envName, artifactDir, authPolicy) {
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

function buildTargetSetupPhase(context, envName) {
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

function buildStateLifecyclePhase(context, envName, scenario, kind, steps, artifactDir, phaseId = null) {
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

function buildEvidenceSnapshotPhase(context, envName, scenario, afterPhaseId, artifactDir) {
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

function compactOpenClawStateSnapshot(stdout, artifactPath) {
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

async function executeStateLifecycleSteps(context, envName, scenario, kind, steps, artifactDir, phaseId = null, authPolicy = null) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const results = [];
  const { commands, evidence } = materializeLifecycleCommands(steps, context, envName, artifactDir);

  for (const step of steps) {
    const stepCommands = materializeLifecycleStepCommands(step, context, envName, artifactDir);
    for (const [commandIndex, command] of stepCommands.entries()) {
      results.push(await runScenarioCommand(command, context, envName, artifactDir, kind, commandIndex, authPolicy));
    }
  }

  return {
    id: kind,
    title: stateLifecycleTitle(context.state?.id, kind, phaseId),
    intent: stateLifecycleIntent(context.state?.id, kind, phaseId),
    measurementScope: normalizeMeasurementScope(null, kind),
    driverKind: phaseDriverKind(null, commands),
    commands,
    evidence,
    results,
    metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, { id: phaseId }, artifactDir, {
      kind: "state-lifecycle",
      measurementScope: normalizeMeasurementScope(null, kind),
      lifecycleKind: kind,
      lifecycleCommandScope: stateLifecycleCommandScope(commands),
      collectionIntent: stateLifecycleCollectionIntent(steps),
      resultStatus: phaseResultStatus(results)
    }))
  };
}

async function executeAuthPhase(phase, context, envName, artifactDir, authPolicy) {
  if (!phase) {
    return null;
  }
  const results = [];
  for (const [commandIndex, command] of phase.commands.entries()) {
    results.push(await runScenarioCommand(command, context, envName, artifactDir, phase.id, commandIndex, authPolicy));
  }
  return {
    ...phase,
    measurementScope: normalizeMeasurementScope(phase.measurementScope, phase.id),
    driverKind: phaseDriverKind(phase),
    results,
    metrics: await collectEnvMetrics(envName, metricOptions(context, null, { id: phase.id }, artifactDir, {
      kind: "auth-phase",
      measurementScope: normalizeMeasurementScope(phase.measurementScope, phase.id),
      collectionIntent: phase.collectionIntent ?? null,
      resultStatus: phaseResultStatus(results)
    }))
  };
}

async function executeEvidenceSnapshotPhase(context, envName, scenario, afterPhaseId, artifactDir, authPolicy) {
  const phase = buildEvidenceSnapshotPhase(context, envName, scenario, afterPhaseId, artifactDir);
  if (!phase) {
    return null;
  }

  const results = [];
  for (const [commandIndex, command] of phase.commands.entries()) {
    const result = await runScenarioCommand(command, context, envName, artifactDir, phase.id, commandIndex, authPolicy);
    const artifactPath = phase.evidenceArtifactPaths[commandIndex];
    result.evidenceKind = "snapshot";
    result.evidenceId = phase.evidenceIds[commandIndex];
    result.evidenceRequired = phase.evidenceRequired[commandIndex];
    result.evidenceSummary = phase.evidenceSummaries[commandIndex];
    result.evidenceArtifactPath = artifactPath;
    if (result.status === 0) {
      const snapshot = compactOpenClawStateSnapshot(result.stdout, artifactPath);
      result.snapshot = snapshot;
      if (snapshot.parseError) {
        result.evidenceStatus = "failed";
        result.evidenceReason = `OpenClaw state snapshot JSON could not be parsed: ${snapshot.parseError}`;
      } else if (snapshot.homePresent !== true) {
        result.evidenceStatus = "failed";
        result.evidenceReason = "OpenClaw state snapshot did not find OPENCLAW_HOME";
      }
    } else {
      result.evidenceReason = "OpenClaw state snapshot command failed";
    }
    results.push(result);
  }

  return {
    ...phase,
    results,
    metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, { id: afterPhaseId }, artifactDir, {
      kind: "evidence-snapshot",
      measurementScope: phase.measurementScope,
      resultStatus: phaseResultStatus(results)
    }))
  };
}

function stateLifecycleTitle(stateId, kind, phaseId) {
  if (kind === "prepare") {
    return `State Prepare (${stateId})`;
  }
  if (kind === "cleanup") {
    return `State Cleanup (${stateId})`;
  }
  return `State Setup After ${phaseId}`;
}

function stateLifecycleIntent(stateId, kind, phaseId) {
  if (kind === "prepare") {
    return `Prepare Kova state '${stateId}' before scenario phases.`;
  }
  if (kind === "cleanup") {
    return `Clean up Kova state '${stateId}' fixture artifacts before env destruction.`;
  }
  return `Apply Kova state '${stateId}' setup after scenario phase '${phaseId}'.`;
}

function stateStepMatchesPhase(step, phaseId) {
  if (Array.isArray(step.afterPhases)) {
    return step.afterPhases.includes(phaseId);
  }
  return step.afterPhase === phaseId;
}

function metricOptions(context, scenario, phase, artifactDir, policyContext = {}) {
  const readinessThresholdMs = readinessThresholdForPhase(scenario, phase);
  const measurementScope = policyContext.measurementScope ?? normalizeMeasurementScope(phase?.measurementScope, phase?.id);
  return {
    timeoutMs: context.timeoutMs,
    healthSamples: context.healthSamples,
    healthIntervalMs: context.healthIntervalMs,
    readinessThresholdMs,
    readinessTimeoutMs: readinessHardTimeoutForPhase(scenario, phase, readinessThresholdMs),
    readinessIntervalMs: context.readinessIntervalMs,
    heapSnapshot: context.heapSnapshot === true && context.deepProfile !== true,
    diagnosticReport: false,
    artifactDir,
    collectorArtifactDirs: collectorArtifactDirs(artifactDir),
    collectionPolicy: resolveCollectionPolicy({
      kind: policyContext.kind,
      scenario: scenario?.id ?? null,
      surface: scenario?.surface ?? null,
      phaseId: phase?.id ?? null,
      phaseHealthScope: phase?.healthScope ?? null,
      measurementScope,
      resultStatus: policyContext.resultStatus ?? null,
      collectionIntent: policyContext.collectionIntent ?? phase?.collectionIntent ?? null,
      lifecycleKind: policyContext.lifecycleKind ?? null,
      lifecycleCommandScope: policyContext.lifecycleCommandScope ?? null
    })
  };
}

function stateLifecycleCommandScope(commands) {
  return commands.some((command) => /(?:^|\s)ocm(?:\s|$)/.test(command)) ? "env" : "host";
}

function stateLifecycleCollectionIntent(steps) {
  const intents = new Set((steps ?? []).map((step) => step.collectionIntent).filter(Boolean));
  return intents.size === 1 ? [...intents][0] : null;
}

async function executeTargetSetup(context, envName, artifactDir) {
  if (context.targetPlan.kind !== "local-build") {
    return [];
  }
  if (context.targetSetup?.completed) {
    return [];
  }

  const results = [
    tagCommandResult(await runCommand(targetSetupCommand(context.targetPlan), {
      timeoutMs: context.timeoutMs,
      env: { KOVA_ENV_NAME: envName },
      resourceSample: context.resourceSampling === false ? null : {
        envName,
        intervalMs: context.resourceSampleIntervalMs,
        processRoles: context.processRoles ?? [],
        artifactPath: join(collectorArtifactDirs(artifactDir).resourceSamples, "target-setup-1.jsonl")
      }
    }), "target-setup")
  ];
  if (results.every((result) => result.status === 0) && context.targetSetup) {
    context.targetSetup.completed = true;
  }
  return results;
}

function targetSetupCommand(targetPlan) {
  return ocmRuntimeBuildLocal(targetPlan.runtimeName, targetPlan.repoPath);
}

async function runScenarioCommand(command, context, envName, artifactDir, phaseId, commandIndex, authPolicy = null) {
  assertSafeScenarioCommand(command, context, envName);
  const agentCommand = isAgentMessageCommand(command);
  const snapshotOptions = {
    envName,
    processRoles: context.processRoles ?? [],
    rootCommand: command
  };
  const snapshotBase = join(collectorArtifactDirs(artifactDir).processSnapshots, `${safeSegment(phaseId)}-${commandIndex + 1}`);
  const beforeSnapshot = agentCommand ? captureProcessSnapshot(snapshotOptions) : null;
  if (beforeSnapshot) {
    await writeJsonArtifact(`${snapshotBase}-before.json`, beforeSnapshot);
  }
  const result = await runCommand(command, {
    timeoutMs: context.timeoutMs,
    env: {
      ...diagnosticsEnv(context, envName, artifactDir),
      ...(authPolicy?.commandEnv ?? {})
    },
    redactValues: authPolicy?.redactionValues ?? context.auth?.redactionValues ?? [],
    resourceSample: context.resourceSampling === false ? null : {
      envName,
      intervalMs: context.resourceSampleIntervalMs,
      processRoles: context.processRoles ?? [],
      artifactPath: join(collectorArtifactDirs(artifactDir).resourceSamples, `${safeSegment(phaseId)}-${commandIndex + 1}.jsonl`)
    }
  });
  normalizeOptionalCommandResult(result);
  tagCommandResult(result, phaseId);
  if (agentCommand) {
    await sleep(1000);
    const afterSnapshot = captureProcessSnapshot(snapshotOptions);
    const processLeaks = diffProcessSnapshots(beforeSnapshot, afterSnapshot, {
      roles: agentLeakRoles()
    });
    await writeJsonArtifact(`${snapshotBase}-after.json`, afterSnapshot);
    await writeJsonArtifact(`${snapshotBase}-leaks.json`, processLeaks);
    result.processSnapshots = {
      schemaVersion: "kova.agentProcessSnapshots.v1",
      beforePath: `${snapshotBase}-before.json`,
      afterPath: `${snapshotBase}-after.json`,
      leaksPath: `${snapshotBase}-leaks.json`,
      before: compactSnapshot(beforeSnapshot),
      after: compactSnapshot(afterSnapshot),
      leaks: processLeaks
    };
  }
  return result;
}

function agentLeakRoles() {
  return ["agent-cli", "agent-process", "mcp-runtime", "plugin-cli", "mock-provider", "browser-sidecar"];
}

function compactSnapshot(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    capturedAt: snapshot.capturedAt,
    envName: snapshot.envName,
    gatewayPid: snapshot.gatewayPid,
    processCount: snapshot.processCount,
    roleCounts: snapshot.roleCounts
  };
}

async function writeJsonArtifact(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function shouldApplyAuthAfterPhase(phase, authPolicy, record) {
  if (!phaseSupportsAuthSetup(phase, authPolicy)) {
    return false;
  }
  return !record.phases.some((planned) => planned.id === "auth-setup");
}

function phaseSupportsAuthSetup(phase, authPolicy) {
  if (!authPolicy?.setup) {
    return false;
  }
  const commands = phase.commands ?? [];
  return commands.some((command) => /\bocm\s+(start|env clone)\b/.test(command));
}

function evaluatorContext(context, scenario) {
  return {
    surface: context.surfacesById?.[scenario.surface] ?? null,
    targetPlan: context.targetPlan ?? null,
    profile: context.profile ?? null
  };
}

function diagnosticsEnv(context, envName, artifactDir) {
  if (context.openclawDiagnostics === false) {
    return {};
  }
  const artifactDirs = collectorArtifactDirs(artifactDir);

  const env = {
    OPENCLAW_DIAGNOSTICS: "timeline",
    OPENCLAW_DIAGNOSTICS_RUN_ID: context.runId,
    OPENCLAW_DIAGNOSTICS_ENV: envName,
    OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(artifactDirs.openclaw, "timeline.jsonl"),
    OPENCLAW_DIAGNOSTICS_EVENT_LOOP: "1"
  };

  if (context.nodeProfile === true) {
    const profileDir = artifactDirs.nodeProfiles;
    env.KOVA_NODE_PROFILE_DIR = profileDir;
    env.NODE_OPTIONS = mergeNodeOptions(process.env.NODE_OPTIONS, [
      "--cpu-prof",
      `--cpu-prof-dir=${quoteNodeOptionValue(profileDir)}`,
      "--heap-prof",
      `--heap-prof-dir=${quoteNodeOptionValue(profileDir)}`,
      "--heapsnapshot-signal=SIGUSR2",
      "--report-on-signal",
      "--report-signal=SIGUSR2",
      `--report-directory=${quoteNodeOptionValue(profileDir)}`,
      "--trace-events-enabled",
      "--trace-event-categories=node.perf,node.async_hooks,v8",
      `--trace-event-file-pattern=${quoteNodeOptionValue(join(profileDir, "node-trace-${pid}.json"))}`
    ]);
  }

  return env;
}

function mergeNodeOptions(existing, additions) {
  return [existing, ...additions].filter(Boolean).join(" ");
}

function quoteNodeOptionValue(value) {
  const string = String(value);
  if (!/\s|"/.test(string)) {
    return string;
  }
  return `"${string.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function envNameFor(scenarioId, stateId, runId, repeat = null) {
  const stateSegment = stateId ? `${stateId}-` : "";
  const repeatSegment = repeat?.total > 1 ? `r${repeat.index}-` : "";
  return `kova-${scenarioId}-${stateSegment}${repeatSegment}${runId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function repeatSummary(repeat) {
  if (!repeat) {
    return {
      index: 1,
      total: 1
    };
  }
  return {
    index: repeat.index,
    total: repeat.total
  };
}

function stateSummary(state) {
  if (!state) {
    return null;
  }

  return {
    id: state.id,
    title: state.title,
    objective: state.objective,
    traits: state.traits ?? [],
    riskArea: state.riskArea ?? null,
    ownerArea: state.ownerArea ?? null,
    officialPlugins: summarizeOfficialPlugins(state.officialPlugins)
  };
}

function summarizeOfficialPlugins(plugins) {
  if (!Array.isArray(plugins)) {
    return [];
  }
  return plugins.map((plugin) => ({
    id: plugin.id,
    package: plugin.package,
    title: plugin.title,
    required: plugin.required !== false,
    riskArea: plugin.riskArea ?? null
  }));
}

function classifyCommandFailure(result) {
  if (result.timedOut) {
    return "FAIL";
  }

  if (result.command.startsWith("ocm start") || result.command.startsWith("ocm runtime build-local")) {
    return "BLOCKED";
  }

  return "FAIL";
}
