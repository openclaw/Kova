import { setTimeout as delay } from "node:timers/promises";
import { buildAuthCleanupPhase } from "../auth.mjs";
import { runCleanupCommand } from "../cleanup.mjs";
import { quoteShell, runCommand } from "../commands.mjs";
import { isMissingOcmResource } from "../ocm/missing-resource.mjs";
import { ocmEnvDestroy, ocmEnvProtect, ocmServiceStatusJson } from "../ocm/commands.mjs";
import { stopNetworkFrontage } from "../network-frontage.mjs";
import { executeAuthPhase } from "./auth-phase.mjs";
import {
  attachPostCleanupEvidence,
  collectPreCleanupEvidence
} from "./finalize-record.mjs";
import { executeStateLifecycleSteps } from "./state-lifecycle.mjs";
import { collectStagedOcmDiagnostics } from "../ocm/diagnostics.mjs";

export async function teardownScenario(record, scenario, context, envName, artifactDir, authPolicy) {
  const errors = [];
  const options = {
    onError() {
      blockPassingRecord(record);
    }
  };
  const beforeRetention = await runGuardedTeardownStages([
    {
      id: "pre-cleanup-evidence",
      run: () => collectPreCleanupEvidence(record, scenario, context, envName, artifactDir, authPolicy)
    },
    {
      id: "network-frontage-cleanup",
      run: () => cleanupNetworkFrontage(record, context)
    }
  ], options);
  errors.push(...beforeRetention.errors);

  let retainEnv = shouldRetainEnv(context, record);
  if (retainEnv) {
    // The OCM protection is the destruction fence. Do not emit a retained
    // record when that fence could not be established.
    retainEnv = await protectRetainedEnv(record, context, envName);
    if (retainEnv) {
      record.cleanup = "retained";
      record.retainedReason = context.keepEnv ? "keep-env" : "failure";
    }
  }

  record.networkFrontage = context.networkFrontageAllocation ?? record.networkFrontage;
  let shutdownConfirmed = !context.ocmDiagnostics;
  const afterRetention = await runGuardedTeardownStages([
    {
      id: "cleanup-phase-notification",
      run: () => retainEnv ? null : context.onPhase?.("cleanup")
    },
    {
      id: "auth-cleanup",
      run: () => retainEnv ? null : cleanupAuth(record, context, envName, artifactDir, authPolicy)
    },
    {
      id: "state-cleanup",
      run: () => retainEnv ? null : cleanupState(record, scenario, context, envName, artifactDir, authPolicy)
    },
    {
      id: "stop-and-export",
      run: async () => {
        if (retainEnv || !context.ocmDiagnostics) return;
        const deadlineEpochMs = await stopCandidate(record, context, envName);
        shutdownConfirmed = true;
        await collectStagedOcmDiagnostics(envName, context.ocmDiagnostics, artifactDir, {
          env: context.commandEnv, stopped: true,
          deadlineEpochMs: Math.min(deadlineEpochMs, Date.now() + 10000)
        });
      }
    },
    {
      id: "env-cleanup",
      run: () => {
        if (retainEnv) return;
        // Guarded stages continue after errors. Preserve unflushed candidate
        // artifacts until the outer owner can quiesce the UID and clean up.
        if (!shutdownConfirmed) {
          throw new Error("environment destruction withheld: candidate shutdown unconfirmed; outer UID cleanup required");
        }
        return cleanupEnv(record, context, envName);
      }
    },
    {
      id: "post-cleanup-evidence",
      run: () => attachPostCleanupEvidence(record, scenario, context, artifactDir)
    }
  ], options);
  errors.push(...afterRetention.errors);

  if (errors.length > 0) {
    record.teardownErrors = errors;
  }
}

export async function runGuardedTeardownStages(stages, options = {}) {
  const errors = [];

  for (const stage of stages) {
    try {
      await stage.run();
    } catch (error) {
      const failure = {
        stage: stage.id,
        message: error instanceof Error ? error.message : String(error)
      };
      errors.push(failure);
      options.onError?.(failure);
    }
  }

  return { errors };
}

async function cleanupNetworkFrontage(record, context) {
  const cleanup = await stopNetworkFrontage(context);
  if (!cleanup) {
    return;
  }
  record.phases.push({
    id: "network-frontage-cleanup",
    title: "Network Frontage Cleanup",
    intent: "Stop the per-env loopback frontage proxy before destroying or retaining the Kova env.",
    measurementScope: "cleanup",
    driverKind: "kova",
    commands: [cleanup.command],
    evidence: ["network frontage proxy stopped"],
    results: [cleanup]
  });
  if (cleanup.status !== 0) {
    blockPassingRecord(record);
  }
}

async function cleanupAuth(record, context, envName, artifactDir, authPolicy) {
  const phase = await executeAuthPhase(
    buildAuthCleanupPhase(authPolicy, artifactDir),
    context,
    envName,
    artifactDir,
    authPolicy
  );
  appendCleanupPhase(record, phase);
}

async function cleanupState(record, scenario, context, envName, artifactDir, authPolicy) {
  const phase = await executeStateLifecycleSteps(
    context,
    envName,
    scenario,
    "cleanup",
    context.state?.cleanup ?? [],
    artifactDir,
    null,
    authPolicy
  );
  appendCleanupPhase(record, phase);
}

async function cleanupEnv(record, context, envName) {
  const cleanup = await runCleanupCommand(ocmEnvDestroy(envName), { timeoutMs: context.timeoutMs, env: context.commandEnv });
  record.cleanup = classifyEnvDestroyCleanup(cleanup, envName);
  record.cleanupResult = cleanup;
  if (record.cleanup === "destroy-failed") {
    blockPassingRecord(record);
  }
}

async function protectRetainedEnv(record, context, envName) {
  const result = await runCommand(ocmEnvProtect(envName, true), {
    timeoutMs: context.timeoutMs,
    env: context.commandEnv
  });
  record.retentionProtectionResult = result;
  const outcome = classifyRetentionProtection(result, envName);
  if (outcome === "already-absent") {
    return false;
  }
  if (outcome === "failed") {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`failed to protect retained env ${envName}: ${detail}`);
  }
  return true;
}

async function stopCandidate(record, context, envName) {
  const deadlineEpochMs = Date.now() + (context.timeoutMs ?? 120000);
  const result = await runCommand(`ocm service stop ${quoteShell(envName)} --json`, {
    timeoutMs: context.timeoutMs, env: context.commandEnv
  });
  const phase = {
    id: "transport-stop",
    title: "Stop Candidate Before Artifact Export",
    measurementScope: "cleanup",
    driverKind: "kova",
    commands: [result.command],
    results: [result]
  };
  record.phases.push(phase);
  if (result.status !== 0) throw new Error("OCM candidate stop command failed");
  // Successful stop means accepted, not stopped. Observe only this env and
  // charge both the action and observations to the original command budget.
  // B's response orders diagnostics; outer UID quiescence is still required.
  while (Date.now() < deadlineEpochMs) {
    const status = await runCommand(ocmServiceStatusJson(envName), {
      env: context.commandEnv, timeoutMs: Math.max(1, deadlineEpochMs - Date.now()),
      maxOutputChars: 10000
    });
    phase.commands.push(status.command);
    phase.results.push(status);
    if (status.status !== 0 || status.outputBudget.truncated) {
      throw new Error("OCM candidate shutdown observation failed");
    }
    const state = JSON.parse(status.stdout);
    if (state?.envName !== envName || typeof state.running !== "boolean" ||
        typeof state.desiredRunning !== "boolean") {
      throw new Error("OCM shutdown observation did not identify the exact environment state");
    }
    if (Date.now() >= deadlineEpochMs) break;
    if (!state.running && !state.desiredRunning) return deadlineEpochMs;
    await delay(Math.min(100, Math.max(0, deadlineEpochMs - Date.now())));
  }
  throw new Error("OCM candidate shutdown was not confirmed before the command deadline");
}

export function classifyRetentionProtection(result, envName) {
  if (result.status === 0) {
    return "protected";
  }
  return isMissingOcmResource(result, "environment", envName)
    ? "already-absent"
    : "failed";
}

function appendCleanupPhase(record, phase) {
  if (!phase) {
    return;
  }
  record.phases.push(phase);
  if (phase.results.some((result) => result.status !== 0)) {
    blockPassingRecord(record);
  }
}

function shouldRetainEnv(context, record) {
  return context.keepEnv || (context.retainOnFailure && record.status !== "PASS");
}

function blockPassingRecord(record) {
  if (record.status === "PASS") {
    record.status = "BLOCKED";
  }
}

function classifyEnvDestroyCleanup(result, envName) {
  if (result.status === 0) {
    return "destroyed";
  }
  return isMissingOcmResource(result, "environment", envName)
    ? "already-absent"
    : "destroy-failed";
}
