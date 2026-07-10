import { collectEnvMetrics } from "../metrics.mjs";
import { phaseResultStatus } from "../measurement-contract.mjs";
import { runScenarioCommand } from "./command-executor.mjs";
import { metricOptions } from "./metric-options.mjs";
import {
  buildEvidenceSnapshotPhase,
  compactOpenClawStateSnapshot
} from "./phase-plan.mjs";

export async function executeEvidenceSnapshotPhase(context, envName, scenario, afterPhaseId, artifactDir, authPolicy) {
  const phase = buildEvidenceSnapshotPhase(context, envName, scenario, afterPhaseId, artifactDir);
  if (!phase) {
    return null;
  }

  const results = [];
  for (const [commandIndex, command] of phase.commands.entries()) {
    const result = await runScenarioCommand(command, context, envName, artifactDir, phase, commandIndex, authPolicy);
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
      measurementPhase: phase,
      resultStatus: phaseResultStatus(results)
    }))
  };
}
