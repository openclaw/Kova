import { collectEnvMetrics } from "../metrics.mjs";
import {
  phaseResultStatus,
  withPhaseContract
} from "../measurement-contract.mjs";
import { runAuthCommand } from "./command-executor.mjs";
import { metricOptions } from "./metric-options.mjs";

export async function executeAuthPhase(phase, context, envName, artifactDir, authPolicy) {
  if (!phase) {
    return null;
  }
  const plannedPhase = withPhaseContract(phase);
  const results = [];
  for (const [commandIndex, command] of plannedPhase.commands.entries()) {
    results.push(await runAuthCommand(command, context, envName, artifactDir, plannedPhase, commandIndex, authPolicy));
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
