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
  if (context.targetSetup?.completed) {
    return [];
  }
  if (context.targetSetup?.failed) {
    return context.targetSetup.results.map((result) => ({
      ...result,
      cached: true,
      durationMs: 0,
      originalDurationMs: result.durationMs
    }));
  }

  const results = [
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
  if (results.every((result) => result.status === 0) && context.targetSetup) {
    context.targetSetup.completed = true;
  } else if (context.targetSetup) {
    // A local-build runtime is shared by the whole matrix. Retrying the same
    // failed build per scenario only burns time and cannot change the outcome.
    context.targetSetup.failed = true;
    context.targetSetup.results = results;
  }
  return results;
}
