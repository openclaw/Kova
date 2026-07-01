import {
  buildAuthCleanupPhase,
  buildAuthPreparePhase,
  buildAuthSetupPhase,
  scenarioAuthPolicy
} from "./auth.mjs";
import { runCleanupCommand } from "./cleanup.mjs";
import { attachEvidenceLedger } from "./evidence-ledger.mjs";
import { ocmEnvDestroy } from "./ocm/commands.mjs";
import { runScenarioCommand } from "./run/command-executor.mjs";
import { commandFailureRecordStatus } from "./command-results.mjs";
import {
  executeStateLifecycleSteps,
  executeStateSetupAfterPhase
} from "./run/state-lifecycle.mjs";
import { executeAuthPhase } from "./run/auth-phase.mjs";
import { executeEvidenceSnapshotPhase } from "./run/evidence-snapshots.mjs";
import {
  attachPostCleanupEvidence,
  collectPreCleanupEvidence
} from "./run/finalize-record.mjs";
import { appendChannelCapabilityEvidence } from "./run/channel-capability-results.mjs";
import {
  buildScenarioPhase,
  buildTargetSetupPhase,
  buildPlannedPhases,
  phaseSupportsAuthSetup,
} from "./run/phase-plan.mjs";
import { executeTargetSetup } from "./run/target-setup.mjs";
import { envNameFor } from "./run/env-name.mjs";
import { collectEnvMetrics } from "./metrics.mjs";
import { collectorArtifactDirs, prepareCollectorArtifactDirs } from "./collectors/artifacts.mjs";
import {
  phaseResultStatus
} from "./measurement-contract.mjs";
import { metricOptions } from "./run/metric-options.mjs";
import { artifactsDir } from "./paths.mjs";
import { plannedNetworkFrontage, stopNetworkFrontage } from "./network-frontage.mjs";
import { assertKovaEnvName } from "./safety.mjs";
import { join } from "node:path";
export { createRunId } from "./run/run-id.mjs";

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
    networkFrontage: plannedNetworkFrontage(context, envName),
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
      const setupPhase = buildTargetSetupPhase(context, envName);
      record.phases.push({
        ...setupPhase,
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
        const plannedPhase = buildScenarioPhase(phase, context, envName, artifactDir);
        const results = [];
        for (const [commandIndex, command] of plannedPhase.commands.entries()) {
          const result = await runScenarioCommand(command, context, envName, artifactDir, phase.id, commandIndex, authPolicy);
          results.push(result);
          record.networkFrontage = context.networkFrontageAllocation ?? record.networkFrontage;
          appendChannelCapabilityEvidence(record, result, phase.id, commandIndex);
          if (result.status !== 0) {
            scenarioFailed = true;
            record.status = classifyCommandFailure(result);
            break;
          }
        }

        record.phases.push({
          ...plannedPhase,
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
    await collectPreCleanupEvidence(record, scenario, context, envName, artifactDir, authPolicy);

    const networkCleanup = await stopNetworkFrontage(context);
    if (networkCleanup) {
      record.phases.push({
        id: "network-frontage-cleanup",
        title: "Network Frontage Cleanup",
        intent: "Stop the per-env loopback frontage proxy before destroying or retaining the Kova env.",
        measurementScope: "cleanup",
        driverKind: "kova",
        commands: [networkCleanup.command],
        evidence: ["network frontage proxy stopped"],
        results: [networkCleanup]
      });
      if (networkCleanup.status !== 0 && record.status === "PASS") {
        record.status = "BLOCKED";
      }
    }
    const shouldRetain = shouldRetainEnv(context, record);
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
    record.networkFrontage = context.networkFrontageAllocation ?? record.networkFrontage;

    await attachPostCleanupEvidence(record, scenario, context, artifactDir);
  }

  return record;
}

function shouldRetainEnv(context, record) {
  return context.keepEnv || (context.retainOnFailure && record.status !== "PASS");
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

function shouldApplyAuthAfterPhase(phase, authPolicy, record) {
  if (!phaseSupportsAuthSetup(phase, authPolicy)) {
    return false;
  }
  return !record.phases.some((planned) => planned.id === "auth-setup");
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
  if (result.harnessBlocker) {
    return "BLOCKED";
  }
  const structuredStatus = commandFailureRecordStatus(result);
  if (structuredStatus) {
    return structuredStatus;
  }

  if (result.timedOut) {
    return "FAIL";
  }

  if (result.command.startsWith("ocm start") || result.command.startsWith("ocm runtime build-local")) {
    return "BLOCKED";
  }

  return "FAIL";
}
