import { runCommand } from "./commands.mjs";
import {
  buildAuthCleanupPhase,
  buildAuthPreparePhase,
  buildAuthSetupPhase,
  scenarioAuthPolicy
} from "./auth.mjs";
import { runCleanupCommand } from "./cleanup.mjs";
import { applyEvidenceLedgerGating, attachEvidenceLedger } from "./evidence-ledger.mjs";
import { materializeCommands } from "./registries/scenarios.mjs";
import { quoteShell } from "./commands.mjs";
import { ocmEnvDestroy, ocmRuntimeBuildLocal } from "./ocm/commands.mjs";
import { captureProcessSnapshot, diffProcessSnapshots } from "./collectors/resources.mjs";
import { collectEnvMetrics, collectNodeProfileMetrics } from "./metrics.mjs";
import { collectorArtifactDirs, prepareCollectorArtifactDirs } from "./collectors/artifacts.mjs";
import { collectProviderEvidence } from "./collectors/provider.mjs";
import { evaluateRecord } from "./evaluator.mjs";
import { driverKindForCommand, measurementScopeForPhase, normalizeMeasurementScope, phaseDriverKind } from "./measurement-contract.mjs";
import { artifactsDir } from "./paths.mjs";
import { repoRoot } from "./paths.mjs";
import { assertKovaEnvName, assertSafeScenarioCommand } from "./safety.mjs";
import { dirname, join } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";

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
        record.phases.push(authPreparePhase);
        if (authPreparePhase.results.some((result) => result.status !== 0)) {
          record.status = "BLOCKED";
          scenarioFailed = true;
        }
      }
    }

    if (!scenarioFailed) {
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
          measurementScope: phaseMeasurementScope(phase),
          driverKind: phaseDriverKind(phase, commands),
          expectedAgentFailure: phase.expectedAgentFailure === true,
          commands,
          evidence: phase.evidence ?? [],
          results,
          metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, phase, artifactDir))
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
    record.finalMetrics = await collectEnvMetrics(envName, metricOptions(context, scenario, null, artifactDir));
    record.providerEvidence = await collectProviderEvidence(artifactDir, { authPolicy });
    evaluateRecord(record, scenario, evaluatorContext(context, scenario));

    if (shouldCaptureFailureDiagnostics(record, context)) {
      record.failureDiagnostics = await collectEnvMetrics(envName, {
        ...metricOptions(context, scenario, null, artifactDir),
        readinessTimeoutMs: 0,
        heapSnapshot: true,
        diagnosticReport: true
      });
    }

    const shouldRetain = context.keepEnv || (context.retainOnFailure && record.status !== "PASS");
    if (!shouldRetain) {
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
      measurementScope: phaseMeasurementScope(phase),
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

  const commands = [];
  const evidence = [];
  for (const step of steps) {
    commands.push(...materializeCommands(step.commands ?? [], commandValues(context, envName, artifactDir)));
    evidence.push(...(step.evidence ?? []));
  }

  return {
    id: kind,
    title: stateLifecycleTitle(context.state?.id, kind, phaseId),
    intent: stateLifecycleIntent(context.state?.id, kind, phaseId),
    measurementScope: normalizeMeasurementScope(null, kind),
    driverKind: phaseDriverKind(null, commands),
    commands,
    evidence,
    scenario: scenario.id
  };
}

function materializeScenarioPhaseCommands(phase, context, envName, artifactDir) {
  return materializeCommands(phase.commands ?? [], commandValues(context, envName, artifactDir));
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

function attachEvidenceInvariants(record, scenario) {
  const invariants = [];
  if (scenario.surface === "upgrade-existing-user") {
    invariants.push(...buildUpgradeStateSnapshotInvariants(record));
    invariants.push(...buildUpgradeLogDerivedInvariants(record));
  }
  if (scenario.surface === "gateway-session-send-turn") {
    invariants.push(...buildGatewaySessionEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "release-runtime-startup") {
    invariants.push(...buildReleaseRuntimeStartupEvidenceInvariants(record, scenario));
  }
  if (scenario.surface === "official-plugin-install") {
    invariants.push(...buildOfficialPluginInstallEvidenceInvariants(record, scenario));
  }
  if (invariants.length > 0) {
    record.evidenceInvariants = invariants;
  }
  return record;
}

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

function officialPluginHealthOk(record, health) {
  return health?.readiness?.classification === "ready" &&
    Number.isFinite(health.readiness.healthReadyAtMs) &&
    (health.postReadySamples?.count ?? 0) > 0 &&
    (health.postReadySamples?.failureCount ?? 0) === 0 &&
    (health.final?.failureCount ?? 0) === 0 &&
    record.measurements?.finalGatewayState === "running";
}

function officialPluginHealthMissing(record, health) {
  return !health?.readiness ||
    !Number.isFinite(health.readiness.healthReadyAtMs) ||
    (health.postReadySamples?.count ?? 0) <= 0 ||
    record.measurements?.finalGatewayState === undefined;
}

function officialPluginHealthReason(record, health) {
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

function commonResourceProofOk(measurements) {
  return (measurements?.resourceSampleCount ?? 0) > 0 &&
    Array.isArray(measurements?.resourceSampleArtifacts) &&
    measurements.resourceSampleArtifacts.length > 0 &&
    nonNegativeNumber(measurements.peakRssMb);
}

function commonResourceProofReason(measurements) {
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

function commonTimelineProofOk(measurements) {
  return measurements?.openclawTimelineAvailable === true &&
    (measurements.openclawTimelineEventCount ?? 0) > 0 &&
    (measurements.openclawTimelineParseErrors ?? 0) === 0 &&
    Array.isArray(measurements.openclawTimelineArtifacts) &&
    measurements.openclawTimelineArtifacts.length > 0;
}

function commonTimelineProofReason(measurements) {
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

export function buildReleaseRuntimeStartupEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const health = record.measurements?.health ?? {};
  const service = releaseStartupBestServiceMetrics(record);
  const provision = releaseStartupProvisionProof(record);
  const statusResult = findCommandResult(record, (result) => result.command === "ocm @{env} -- status" || result.command?.includes(" -- status"));
  const pluginsListResult = findCommandResult(record, (result) => result.command === "ocm @{env} -- plugins list" || result.command?.includes(" -- plugins list"));
  const logsResult = findCommandResult(record, (result) => result.command?.startsWith("ocm logs "));
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
      status: releaseStartupLogsOk(logsResult) ? "passed" : "missing",
      summary: "startup log command captured bounded gateway startup output",
      artifactPath: releaseStartupLogArtifactPath(record),
      reason: releaseStartupLogsReason(logsResult)
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
    (result) => result.command?.startsWith("ocm start "),
    (result) => result.command?.startsWith("ocm service status "),
    (result) => result.command === "ocm @{env} -- status" || result.command?.includes(" -- status"),
    (result) => result.command === "ocm @{env} -- plugins list" || result.command?.includes(" -- plugins list"),
    (result) => result.command?.startsWith("ocm logs ")
  ];
  return required.every((predicate) => {
    const result = findCommandResult(record, predicate);
    return result?.status === 0 && result.durationMs !== undefined;
  });
}

function releaseStartupCommandReceiptsReason(record) {
  const required = [
    ["ocm start", (result) => result.command?.startsWith("ocm start ")],
    ["ocm service status", (result) => result.command?.startsWith("ocm service status ")],
    ["ocm status", (result) => result.command === "ocm @{env} -- status" || result.command?.includes(" -- status")],
    ["ocm plugins list", (result) => result.command === "ocm @{env} -- plugins list" || result.command?.includes(" -- plugins list")],
    ["ocm logs", (result) => result.command?.startsWith("ocm logs ")]
  ];
  for (const [label, predicate] of required) {
    const result = findCommandResult(record, predicate);
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

function releaseStartupLogsOk(result) {
  return result?.status === 0 && `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().length > 0;
}

function releaseStartupLogsReason(result) {
  if (!result) {
    return "startup logs command receipt was not captured";
  }
  if (result.status !== 0) {
    return `startup logs command exited ${result.status}`;
  }
  if (`${result.stdout ?? ""}${result.stderr ?? ""}`.trim().length === 0) {
    return "startup logs command emitted no output";
  }
  return null;
}

function releaseStartupLogArtifactPath(record) {
  for (const metrics of collectRecordMetricObjects(record)) {
    const artifact = metrics.logs?.artifacts?.[0];
    if (artifact) {
      return artifact;
    }
  }
  return null;
}

export function buildGatewaySessionEvidenceInvariants(record, scenario = {}) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const turns = collectGatewaySessionTurnResults(record);
  const expectedTurnCount = scenario.id === "gateway-session-send-turn" ? 2 : Math.max(1, turns.length);
  const health = record.measurements?.health ?? {};
  const providerEvidence = record.providerEvidence ?? {};
  const agentTurns = record.measurements?.agentTurns ?? [];
  const providerArtifacts = Array.isArray(providerEvidence.artifacts) ? providerEvidence.artifacts : [];
  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;

  return [
    {
      id: "gateway-session-turn-json-captured",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => turn.result?.status === 0 && turn.payload)
        ? "passed"
        : "missing",
      summary: "cold/warm Gateway session helper command JSON was captured",
      artifactPath: null,
      reason: turns.length >= expectedTurnCount
        ? missingGatewaySessionPayloadReason(turns)
        : `expected at least ${expectedTurnCount} Gateway session turn result(s), found ${turns.length}`
    },
    {
      id: "gateway-session-direct-rpc-transport",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => turn.payload?.gatewayTransport?.kind === "direct-gateway-rpc")
        ? "passed"
        : "failed",
      summary: "Gateway session sends used direct Gateway RPC transport",
      artifactPath: null,
      reason: gatewaySessionTransportReason(turns)
    },
    {
      id: "gateway-session-response-content",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => gatewaySessionResponseOk(turn.payload))
        ? "passed"
        : "failed",
      summary: "Gateway session turns produced the expected assistant marker and assistant-count evidence",
      artifactPath: null,
      reason: gatewaySessionResponseReason(turns)
    },
    {
      id: "gateway-session-latency-windows",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: turns.length >= expectedTurnCount && turns.every((turn) => gatewaySessionLatencyOk(turn.payload))
        ? "passed"
        : "missing",
      summary: "Gateway session active-turn and response latency windows were measured",
      artifactPath: null,
      reason: gatewaySessionLatencyReason(turns)
    },
    {
      id: "gateway-session-provider-proof",
      phaseId: "gateway-session-send-turn",
      required: true,
      status: providerProofOk(providerEvidence, agentTurns, expectedTurnCount) ? "passed" : "missing",
      summary: "provider request/response evidence was captured and attributed to every Gateway session turn",
      artifactPath: providerEvidence.summaryPath ?? providerArtifacts[0] ?? null,
      reason: providerProofReason(providerEvidence, agentTurns, expectedTurnCount)
    },
    {
      id: "gateway-session-readiness-health-proof",
      phaseId: "gateway-start",
      required: true,
      status: gatewaySessionHealthOk(record, health) ? "passed" : "missing",
      summary: "Gateway readiness, post-ready health, and final service state were measured",
      artifactPath: null,
      reason: gatewaySessionHealthReason(record, health)
    },
    zeroCountInvariant({
      id: "gateway-session-no-missing-runtime-dependency-errors",
      summary: "gateway logs and command output contain no missing runtime dependency errors",
      actual: missingDependencyErrors,
      metric: "missingDependencyErrors",
      phaseId: "post-gateway-session-health"
    }),
    zeroCountInvariant({
      id: "gateway-session-no-plugin-load-failures",
      summary: "gateway logs contain no plugin load failures",
      actual: pluginLoadFailures,
      metric: "pluginLoadFailures",
      phaseId: "post-gateway-session-health"
    })
  ];
}

function collectGatewaySessionTurnResults(record) {
  const turns = [];
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (!result?.command?.includes("run-gateway-session-send-turn.mjs")) {
        continue;
      }
      turns.push({
        phaseId: phase.id,
        result,
        payload: parseJsonObject(result.stdout)
      });
    }
  }
  return turns;
}

function missingGatewaySessionPayloadReason(turns) {
  const bad = turns.find((turn) => turn.result?.status !== 0 || !turn.payload);
  if (!bad) {
    return null;
  }
  if (bad.result?.status !== 0) {
    return `${bad.phaseId} command exited ${bad.result?.status ?? "unknown"}`;
  }
  return `${bad.phaseId} did not emit parseable JSON`;
}

function gatewaySessionTransportReason(turns) {
  const bad = turns.find((turn) => turn.payload?.gatewayTransport?.kind !== "direct-gateway-rpc");
  if (!bad) {
    return null;
  }
  const transport = bad.payload?.gatewayTransport?.kind ?? "missing";
  const fallbackReason = bad.payload?.gatewayTransport?.fallbackReason;
  return `${bad.phaseId} used ${transport}${fallbackReason ? ` (${fallbackReason})` : ""}`;
}

function gatewaySessionResponseOk(payload) {
  if (!payload || payload.ok !== true || payload.expectedTextPresent !== true) {
    return false;
  }
  const assistantCount = numberOrNull(payload.assistantMessageCount);
  const minAssistantCount = numberOrNull(payload.minAssistantCount);
  return typeof payload.finalAssistantVisibleText === "string" &&
    payload.finalAssistantVisibleText.length > 0 &&
    assistantCount !== null &&
    minAssistantCount !== null &&
    assistantCount >= minAssistantCount;
}

function gatewaySessionResponseReason(turns) {
  const bad = turns.find((turn) => !gatewaySessionResponseOk(turn.payload));
  if (!bad) {
    return null;
  }
  if (!bad.payload) {
    return `${bad.phaseId} JSON payload was missing`;
  }
  if (bad.payload.ok !== true) {
    return `${bad.phaseId} payload ok was not true`;
  }
  if (bad.payload.expectedTextPresent !== true) {
    return `${bad.phaseId} did not report expected text present`;
  }
  const assistantCount = numberOrNull(bad.payload.assistantMessageCount);
  const minAssistantCount = numberOrNull(bad.payload.minAssistantCount);
  if (assistantCount === null || minAssistantCount === null || assistantCount < minAssistantCount) {
    return `${bad.phaseId} assistant count ${assistantCount ?? "missing"} was below required ${minAssistantCount ?? "missing"}`;
  }
  return `${bad.phaseId} final assistant text was missing`;
}

function gatewaySessionLatencyOk(payload) {
  return payload &&
    nonNegativeNumber(payload.activeTurnMs) &&
    nonNegativeNumber(payload.sendDurationMs) &&
    nonNegativeNumber(payload.timeToMatchedAssistantMs) &&
    nonNegativeNumber(payload.historyPollCount) &&
    numberOrNull(payload.historyErrorCount) === 0;
}

function gatewaySessionLatencyReason(turns) {
  const bad = turns.find((turn) => !gatewaySessionLatencyOk(turn.payload));
  if (!bad) {
    return null;
  }
  if (!bad.payload) {
    return `${bad.phaseId} JSON payload was missing`;
  }
  const missing = ["activeTurnMs", "sendDurationMs", "timeToMatchedAssistantMs", "historyPollCount"]
    .filter((key) => !nonNegativeNumber(bad.payload[key]));
  if (missing.length > 0) {
    return `${bad.phaseId} missing latency field(s): ${missing.join(", ")}`;
  }
  return `${bad.phaseId} historyErrorCount was ${bad.payload.historyErrorCount ?? "missing"}`;
}

function providerProofOk(providerEvidence, agentTurns, expectedTurnCount) {
  if (providerEvidence?.available !== true || providerEvidence.requestCount < expectedTurnCount) {
    return false;
  }
  const gatewayTurns = agentTurns.filter((turn) => turn.gatewaySession);
  if (gatewayTurns.length < expectedTurnCount) {
    return false;
  }
  return gatewayTurns.every((turn) =>
    turn.missingProviderRequest === false &&
    (turn.requestCount ?? 0) > 0 &&
    turn.providerAfterCommandEnd !== true &&
    turn.providerStatuses.every((status) => !Number.isFinite(Number(status.value)) || Number(status.value) < 400)
  );
}

function providerProofReason(providerEvidence, agentTurns, expectedTurnCount) {
  if (providerEvidence?.available !== true) {
    return providerEvidence?.error ?? "provider evidence was not available";
  }
  if (providerEvidence.requestCount < expectedTurnCount) {
    return `provider request count ${providerEvidence.requestCount ?? 0} was below required ${expectedTurnCount}`;
  }
  const gatewayTurns = agentTurns.filter((turn) => turn.gatewaySession);
  if (gatewayTurns.length < expectedTurnCount) {
    return `agent turn attribution count ${gatewayTurns.length} was below required ${expectedTurnCount}`;
  }
  const missing = gatewayTurns.find((turn) => turn.missingProviderRequest === true || (turn.requestCount ?? 0) === 0);
  if (missing) {
    return `${missing.phaseId} had no attributed provider request`;
  }
  const late = gatewayTurns.find((turn) => turn.providerAfterCommandEnd === true);
  if (late) {
    return `${late.phaseId} provider request arrived after command window by ${late.providerLateByMs ?? "unknown"}ms`;
  }
  const failedStatus = gatewayTurns.find((turn) =>
    turn.providerStatuses.some((status) => Number.isFinite(Number(status.value)) && Number(status.value) >= 400)
  );
  if (failedStatus) {
    return `${failedStatus.phaseId} had provider HTTP error status evidence`;
  }
  return null;
}

function gatewaySessionHealthOk(record, health) {
  return health?.readiness?.classification === "ready" &&
    Number.isFinite(health.readiness.healthReadyAtMs) &&
    (health.postReadySamples?.count ?? 0) > 0 &&
    (health.postReadySamples?.failureCount ?? 0) === 0 &&
    (health.final?.failureCount ?? 0) === 0 &&
    record.measurements?.finalGatewayState === "running";
}

function gatewaySessionHealthReason(record, health) {
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

export function buildUpgradeLogDerivedInvariants(record) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const missingDependencyErrors = record.measurements?.missingDependencyErrors;
  const pluginLoadFailures = record.measurements?.pluginLoadFailures;
  const doctor = findCommandResult(record, (result) => result.command?.includes(" -- doctor"));

  return [
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
      status: doctorOutputStatus(doctor),
      summary: "post-upgrade doctor output was captured for interpretation",
      artifactPath: null,
      reason: doctorOutputReason(doctor)
    }
  ];
}

function zeroCountInvariant({ id, summary, actual, metric, phaseId = "post-upgrade" }) {
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

function doctorOutputStatus(result) {
  if (!result) {
    return "missing";
  }
  if (result.status !== 0) {
    return "failed";
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.length > 0 ? "passed" : "missing";
}

function doctorOutputReason(result) {
  if (!result) {
    return "doctor command result was not recorded";
  }
  if (result.status !== 0) {
    return `doctor command exited ${result.status}`;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.length > 0 ? null : "doctor command produced no captured output";
}

function attachCleanupEvidence(record) {
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

async function attachEvidenceArtifactBudget(record) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return record;
  }
  const maxBytes = 5 * 1024 * 1024;
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

function collectRecordMetricObjects(record) {
  const metrics = [];
  for (const phase of record.phases ?? []) {
    if (phase.metrics) {
      metrics.push(phase.metrics);
    }
  }
  if (record.finalMetrics) {
    metrics.push(record.finalMetrics);
  }
  return metrics;
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

export function buildUpgradeStateSnapshotInvariants(record) {
  if (record.status === "DRY-RUN" || record.status === "SKIPPED") {
    return [];
  }

  const pre = findSnapshotResult(record, "snapshot:pre-upgrade-state");
  const post = findSnapshotResult(record, "snapshot:post-upgrade-state");
  const invariants = [];

  invariants.push({
    id: "upgrade-state-snapshots-present",
    phaseId: "evidence-post-upgrade-snapshots",
    required: true,
    status: pre?.snapshot && post?.snapshot ? "passed" : "missing",
    summary: "pre-upgrade and post-upgrade OpenClaw state snapshots were collected",
    artifactPath: post?.evidenceArtifactPath ?? pre?.evidenceArtifactPath ?? null,
    reason: pre?.snapshot && post?.snapshot ? null : "required upgrade state snapshot result was not recorded"
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

function compareSnapshotSetInvariant({ id, phaseId, summary, before, after, artifactPath }) {
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

function compareSnapshotEqualityInvariant({ id, phaseId, summary, before, after, artifactPath, optionalWhenMissing = false }) {
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

function sortedUnique(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text ?? "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0;
}

function unionStrings(...groups) {
  return sortedUnique(groups.flatMap((group) => group ?? []));
}

function compareSnapshotCountInvariant({ id, phaseId, summary, before, after, artifactPath }) {
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

function findSnapshotResult(record, evidenceId) {
  for (const phase of record.phases ?? []) {
    for (const result of phase.results ?? []) {
      if (result.evidenceId === evidenceId) {
        return result;
      }
    }
  }
  return null;
}

function findCommandResult(record, predicate) {
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

function findCommandResultInPhase(record, phaseId, predicate) {
  const phase = (record.phases ?? []).find((candidate) => candidate.id === phaseId);
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

async function executeStateLifecycleSteps(context, envName, scenario, kind, steps, artifactDir, phaseId = null, authPolicy = null) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const results = [];
  const commands = [];
  const evidence = [];

  for (const step of steps) {
    const stepCommands = materializeCommands(step.commands ?? [], commandValues(context, envName, artifactDir));
    commands.push(...stepCommands);
    evidence.push(...(step.evidence ?? []));

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
    metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, { id: phaseId }, artifactDir))
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
    metrics: await collectEnvMetrics(envName, metricOptions(context, null, { id: phase.id }, artifactDir))
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
    metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, { id: afterPhaseId }, artifactDir))
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

function metricOptions(context, scenario, phase, artifactDir) {
  const readinessThresholdMs = readinessThresholdForPhase(scenario, phase);
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
    collectorArtifactDirs: collectorArtifactDirs(artifactDir)
  };
}

function readinessThresholdForPhase(scenario, phase) {
  const thresholds = scenario?.thresholds ?? {};
  const defaultMs = thresholds.gatewayReadyMs ?? 30000;
  if (!phase) {
    return 0;
  }
  if ((phase.commands ?? []).some((command) => /(?:^|\s)--no-service(?:\s|$)/.test(command))) {
    return 0;
  }
  if (phase.id === "cold-start" || phase.id === "provision" || phase.id === "baseline" || phase.id === "gateway" || phase.id === "start") {
    return thresholds.coldReadyMs ?? thresholds.gatewayReadyMs ?? defaultMs;
  }
  if (phase.id === "gateway-start") {
    return thresholds.gatewayReadyMs ?? defaultMs;
  }
  if (phase.id === "warm-restart" || phase.id === "restart") {
    return thresholds.warmReadyMs ?? thresholds.restartReadyMs ?? thresholds.gatewayReadyMs ?? defaultMs;
  }
  if (phase.id === "upgrade" || phase.id === "post-upgrade" || phase.id === "source-runtime") {
    return thresholds.gatewayReadyMs ?? defaultMs;
  }
  return 0;
}

function readinessHardTimeoutForPhase(scenario, phase, thresholdMs) {
  if (!phase || thresholdMs <= 0) {
    return 0;
  }
  const thresholds = scenario?.thresholds ?? {};
  const explicit = thresholds.gatewayReadyHardTimeoutMs ?? thresholds.readinessHardTimeoutMs;
  if (typeof explicit === "number") {
    return Math.max(explicit, thresholdMs);
  }
  return Math.max(thresholdMs * 3, thresholdMs + 30000);
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

export function normalizeOptionalCommandResult(result) {
  if (!result || result.status === 0) {
    return result;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/^ocm\s+logs\s/.test(result.command ?? "") && /no logs exist for env\b/i.test(output)) {
    result.optional = true;
    result.originalStatus = result.status;
    result.status = 0;
    result.note = "optional log collection found no env logs";
  }

  return result;
}

function phaseMeasurementScope(phase) {
  return measurementScopeForPhase(phase);
}

function withPhaseContract(phase, scope = null) {
  return {
    ...phase,
    measurementScope: normalizeMeasurementScope(scope ?? phase.measurementScope, phase.id),
    driverKind: phaseDriverKind(phase)
  };
}

function tagCommandResult(result, phaseId) {
  result.measurementScope = measurementScopeForPhase({
    id: phaseId,
    measurementScope: result.measurementScope,
    commands: [result.command]
  });
  result.driverKind = driverKindForCommand(result.command);
  return result;
}

function isAgentMessageCommand(command) {
  return (command.includes(" -- agent ") && command.includes("--message")) ||
    command.includes("run-concurrent-agent-turns.mjs") ||
    command.includes("run-gateway-session-send-turn.mjs") ||
    command.includes("run-tui-message-turn.mjs") ||
    command.includes("run-openai-compatible-turn.mjs");
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

function commandValues(context, envName, artifactDir = "") {
  return {
    env: quoteShell(envName),
    target: context.target,
    from: context.from ?? "",
    sourceEnv: quoteShell(context.sourceEnv ?? ""),
    artifactDir: artifactDir ? quoteShell(artifactDir) : "",
    kovaRoot: quoteShell(repoRoot),
    startSelector: context.targetPlan.startSelector,
    upgradeSelector: context.targetPlan.upgradeSelector,
    fromUpgradeSelector: context.fromPlan?.upgradeSelector ?? ""
  };
}

function safeSegment(value) {
  return String(value ?? "phase").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "phase";
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
