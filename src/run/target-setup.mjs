import { join } from "node:path";
import { runCommand } from "../commands.mjs";
import { collectorArtifactDirs } from "../collectors/artifacts.mjs";
import { tagCommandResult } from "../measurement-contract.mjs";
import { buildTargetSetupPhase } from "./phase-plan.mjs";

export async function executeTargetSetup(context, envName, artifactDir) {
  const phase = buildTargetSetupPhase(context, envName);
  if (!phase) {
    return [];
  }
  const targetSetup = context.targetSetup;
  if (targetSetup?.completed) {
    return [];
  }
  if (targetSetup?.failed) {
    return cachedFailureResults(targetSetup.results);
  }
  if (targetSetup?.inFlight) {
    const results = await targetSetup.inFlight;
    return results.every((result) => result.status === 0)
      ? []
      : cachedFailureResults(results);
  }

  const setupPromise = runTargetSetup(phase, context, envName, artifactDir);
  if (targetSetup) {
    // Local-build matrices share one runtime. Parallel scenarios wait on the
    // same build so OCM never races multiple npm pack/install operations.
    targetSetup.inFlight = setupPromise;
  }

  try {
    const results = await setupPromise;
    if (targetSetup) {
      targetSetup.results = results;
      if (results.every((result) => result.status === 0)) {
        targetSetup.completed = true;
      } else {
        targetSetup.failed = true;
      }
    }
    return results;
  } finally {
    if (targetSetup) {
      targetSetup.inFlight = null;
    }
  }
}

async function runTargetSetup(phase, context, envName, artifactDir) {
  return [
    tagCommandResult(await runCommand(phase.commands[0], {
      timeoutMs: context.timeoutMs,
      env: { KOVA_ENV_NAME: envName },
      resourceSample: context.resourceSampling === false ? null : {
        envName,
        intervalMs: context.resourceSampleIntervalMs,
        processRoles: context.processRoles ?? [],
        artifactPath: join(collectorArtifactDirs(artifactDir).resourceSamples, "target-setup-1.jsonl")
      }
    }), phase)
  ];
}

function cachedFailureResults(results) {
  return results.map((result) => ({
    ...result,
    cached: true,
    durationMs: 0,
    originalDurationMs: result.durationMs
  }));
}
