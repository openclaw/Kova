import { collectEnvMetrics } from "../metrics.mjs";
import {
  phaseResultStatus,
  withPhaseContract
} from "../measurement-contract.mjs";
import { runScenarioCommand } from "./command-executor.mjs";
import { metricOptions } from "./metric-options.mjs";

export async function executeAuthPhase(phase, context, envName, artifactDir, authPolicy) {
  if (!phase) {
    return null;
  }
  const plannedPhase = withPhaseContract(phase);
  const results = [];
  for (const [commandIndex, command] of plannedPhase.commands.entries()) {
    results.push(await runScenarioCommand(command, context, envName, artifactDir, plannedPhase, commandIndex, authPolicy));
  }
  return {
    ...plannedPhase,
    results,
    metrics: await collectEnvMetrics(envName, metricOptions(context, null, plannedPhase, artifactDir, {
      kind: "auth-phase",
      collectionIntent: phase.collectionIntent ?? null,
      resultStatus: phaseResultStatus(results)
    }))
  };
}
