import { collectEnvMetrics } from "../metrics.mjs";
import { phaseResultStatus } from "../measurement-contract.mjs";
import { metricOptions } from "./metric-options.mjs";
import {
  buildStateLifecyclePhase,
  stateLifecycleCollectionIntent,
  stateLifecycleCommandScope,
  stateStepMatchesPhase
} from "./phase-plan.mjs";
import { runScenarioCommand } from "./command-executor.mjs";

export async function executeStateSetupAfterPhase(context, envName, phaseId, scenario, artifactDir, authPolicy) {
  const steps = (context.state?.setup ?? []).filter((step) => stateStepMatchesPhase(step, phaseId));
  if (steps.length === 0) {
    return null;
  }

  return executeStateLifecycleSteps(context, envName, scenario, `state-${phaseId}`, steps, artifactDir, phaseId, authPolicy);
}

export async function executeStateLifecycleSteps(context, envName, scenario, kind, steps, artifactDir, phaseId = null, authPolicy = null) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  const results = [];
  const phase = buildStateLifecyclePhase(context, envName, scenario, kind, steps, artifactDir, phaseId);
  const commands = phase.commands;

  for (const [commandIndex, command] of commands.entries()) {
    results.push(await runScenarioCommand(command, context, envName, artifactDir, phase, commandIndex, authPolicy));
  }

  return {
    ...phase,
    results,
    metrics: await collectEnvMetrics(envName, metricOptions(context, scenario, { id: phaseId }, artifactDir, {
      kind: "state-lifecycle",
      measurementPhase: phase,
      lifecycleKind: kind,
      lifecycleCommandScope: stateLifecycleCommandScope(commands),
      collectionIntent: stateLifecycleCollectionIntent(steps),
      resultStatus: phaseResultStatus(results)
    }))
  };
}
