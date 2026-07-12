import { buildAuthCleanupPhase } from "../auth.mjs";
import { runCleanupCommand } from "../cleanup.mjs";
import { isMissingOcmResource } from "../ocm/missing-resource.mjs";
import { ocmEnvDestroy } from "../ocm/commands.mjs";
import { stopNetworkFrontage } from "../network-frontage.mjs";
import { executeAuthPhase } from "./auth-phase.mjs";
import {
  attachPostCleanupEvidence,
  collectPreCleanupEvidence
} from "./finalize-record.mjs";
import { executeStateLifecycleSteps } from "./state-lifecycle.mjs";

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

  const retainEnv = shouldRetainEnv(context, record);
  if (retainEnv) {
    record.cleanup = "retained";
    record.retainedReason = context.keepEnv ? "keep-env" : "failure";
  } else {
    context.onPhase?.("cleanup");
  }

  record.networkFrontage = context.networkFrontageAllocation ?? record.networkFrontage;
  const afterRetention = await runGuardedTeardownStages([
    {
      id: "auth-cleanup",
      run: () => retainEnv ? null : cleanupAuth(record, context, envName, artifactDir, authPolicy)
    },
    {
      id: "state-cleanup",
      run: () => retainEnv ? null : cleanupState(record, scenario, context, envName, artifactDir, authPolicy)
    },
    {
      id: "env-cleanup",
      run: () => retainEnv ? null : cleanupEnv(record, context, envName)
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
  const cleanup = await runCleanupCommand(ocmEnvDestroy(envName), { timeoutMs: context.timeoutMs });
  record.cleanup = classifyEnvDestroyCleanup(cleanup, envName);
  record.cleanupResult = cleanup;
  if (record.cleanup === "destroy-failed") {
    blockPassingRecord(record);
  }
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
