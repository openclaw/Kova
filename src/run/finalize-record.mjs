import { applyEvidenceLedgerGating, attachEvidenceLedger } from "../evidence-ledger.mjs";
import { attachEvidenceInvariants } from "../evidence/invariants.mjs";
import {
  attachCleanupEvidence,
  attachEvidenceArtifactBudget
} from "../evidence/record.mjs";
import { evaluateRecord } from "../evaluator.mjs";
import { collectEnvMetrics, collectNodeProfileMetrics } from "../metrics.mjs";
import { collectProviderEvidence } from "../collectors/provider.mjs";
import { collectStateFixtureAccounting } from "../collectors/state-fixtures.mjs";
import { metricOptions } from "./metric-options.mjs";

export async function collectPreCleanupEvidence(record, scenario, context, envName, artifactDir, authPolicy) {
  record.finishedAt = new Date().toISOString();
  record.finalMetrics = await collectEnvMetrics(envName, metricOptions(context, scenario, null, artifactDir, {
    kind: "final"
  }));
  record.stateFixtureAccounting = await collectStateFixtureAccounting(context.state, envName, artifactDir);
  record.providerEvidence = await collectProviderEvidence(artifactDir, { authPolicy });
  evaluateRecord(record, scenario, evaluatorContext(context, scenario));

  if (shouldCaptureFailureDiagnostics(record, context)) {
    record.failureDiagnostics = await collectEnvMetrics(envName, {
      ...metricOptions(context, scenario, null, artifactDir, {
        kind: "failure-diagnostics"
      }),
      readinessTimeoutMs: 0,
      heapSnapshot: true,
      diagnosticReport: true
    });
  }
}

export async function attachPostCleanupEvidence(record, scenario, context, artifactDir) {
  if (context.nodeProfile === true || context.deepProfile === true) {
    record.postCleanupNodeProfiles = await collectNodeProfileMetrics(artifactDir);
    record.finalMetrics = record.finalMetrics ?? {};
    record.finalMetrics.nodeProfiles = record.postCleanupNodeProfiles;
    attachNodeProfileMeasurements(record);
  }

  evaluateRecord(record, scenario, evaluatorContext(context, scenario));
  attachEvidenceInvariants(record, scenario);
  attachCleanupEvidence(record);
  await attachEvidenceArtifactBudget(record, scenario);
  attachEvidenceLedger(record);
  applyEvidenceLedgerGating(record);
}

function shouldCaptureFailureDiagnostics(record, context) {
  if (!(context.deepProfile === true || context.profileOnFailure === true)) {
    return false;
  }
  if (record.status === "PASS") {
    return false;
  }
  return record.cleanup !== "retained";
}

function attachNodeProfileMeasurements(record) {
  if (!record.measurements) {
    record.measurements = {};
  }
  const profiles = record.postCleanupNodeProfiles;
  if (!profiles) {
    return;
  }
  const topCpu = profiles.cpuProfileSummary?.topFunctions?.[0];
  const topHeap = profiles.heapProfileSummary?.topFunctions?.[0];
  record.measurements.nodeCpuProfileCount = profiles.cpuProfileCount ?? record.measurements.nodeCpuProfileCount ?? 0;
  record.measurements.nodeHeapProfileCount = profiles.heapProfileCount ?? record.measurements.nodeHeapProfileCount ?? 0;
  record.measurements.nodeTraceEventCount = profiles.traceEventCount ?? record.measurements.nodeTraceEventCount ?? 0;
  record.measurements.nodeProfileArtifactBytes = profiles.artifactBytes ?? record.measurements.nodeProfileArtifactBytes ?? 0;
  record.measurements.nodeProfileTopFunction = topCpu?.functionName ?? record.measurements.nodeProfileTopFunction ?? null;
  record.measurements.nodeProfileTopFunctionMs = topCpu?.selfMs ?? record.measurements.nodeProfileTopFunctionMs ?? null;
  record.measurements.nodeProfileTopFunctionUrl = topCpu?.url ?? record.measurements.nodeProfileTopFunctionUrl ?? null;
  record.measurements.nodeHeapTopFunction = topHeap?.functionName ?? record.measurements.nodeHeapTopFunction ?? null;
  record.measurements.nodeHeapTopFunctionMb = topHeap?.selfSizeMb ?? record.measurements.nodeHeapTopFunctionMb ?? null;
  record.measurements.nodeHeapTopFunctionUrl = topHeap?.url ?? record.measurements.nodeHeapTopFunctionUrl ?? null;
}

function evaluatorContext(context, scenario) {
  return {
    surface: context.surfacesById?.[scenario.surface] ?? null,
    targetPlan: context.targetPlan ?? null,
    profile: context.profile ?? null
  };
}
