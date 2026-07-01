import { collectorArtifactDirs } from "../collectors/artifacts.mjs";
import { resolveCollectionPolicy } from "../collection-policy.mjs";
import {
  normalizeMeasurementScope,
  readinessHardTimeoutForPhase,
  readinessThresholdForPhase
} from "../measurement-contract.mjs";

export function metricOptions(context, scenario, phase, artifactDir, policyContext = {}) {
  const readinessThresholdMs = readinessThresholdForPhase(scenario, phase);
  const measurementScope = policyContext.measurementScope ?? normalizeMeasurementScope(phase?.measurementScope, phase?.id);
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
    collectorArtifactDirs: collectorArtifactDirs(artifactDir),
    networkFrontageAllocation: context.networkFrontageAllocation ?? null,
    collectionPolicy: resolveCollectionPolicy({
      kind: policyContext.kind,
      scenario: scenario?.id ?? null,
      surface: scenario?.surface ?? null,
      phaseId: phase?.id ?? null,
      phaseHealthScope: phase?.healthScope ?? null,
      measurementScope,
      resultStatus: policyContext.resultStatus ?? null,
      collectionIntent: policyContext.collectionIntent ?? phase?.collectionIntent ?? null,
      lifecycleKind: policyContext.lifecycleKind ?? null,
      lifecycleCommandScope: policyContext.lifecycleCommandScope ?? null
    })
  };
}
