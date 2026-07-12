import {
  comparePerformanceToBaseline,
  loadBaselineStore,
  reviewBaselineUpdate,
  saveBaselineStore,
  updateBaselineStore,
  withBaselineStoreLock
} from "../performance/baselines.mjs";
import { platformInfo } from "../platform.mjs";
import { summarizeRecords } from "../reporting/report.mjs";

const REPORT_SCHEMA_VERSION = "kova.report.v1";

export function buildRunReport({
  runId,
  outputPaths,
  mode,
  target,
  from = null,
  profile = null,
  state = null,
  controls,
  auth,
  targetCleanup,
  networkFrontage = null,
  performance,
  records,
  gate = null,
  platform = platformInfo()
}) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    runId,
    outputPaths,
    mode,
    ...(profile ? { profile } : {}),
    target,
    from,
    controls,
    auth,
    state,
    platform,
    targetCleanup,
    networkFrontage,
    performance,
    baseline: null,
    ...(gate !== undefined ? { gate } : {}),
    summary: summarizeRecords(records),
    records
  };
}

export function attachBaselineComparison(report, baselineStore, options) {
  const comparison = comparePerformanceToBaseline(report, baselineStore, {
    targetPlan: options.targetPlan,
    regressionThresholds: options.regressionThresholds
  });
  if (!comparison) {
    return report;
  }
  report.baseline = {
    path: options.baselinePath,
    comparison
  };
  return report;
}

export async function saveBaselineUpdate(report, options) {
  if (!options.saveBaselinePath) {
    return report;
  }
  const review = reviewBaselineUpdate(report, { reviewedGood: options.reviewedGood === true });
  const saved = await withBaselineStoreLock(options.saveBaselinePath, async () => {
    // The lock owns the entire read-modify-write sequence so separate Kova
    // processes cannot commit stores derived from the same stale snapshot.
    const existingStore = await loadBaselineStore(options.saveBaselinePath);
    const updatedStore = updateBaselineStore(existingStore, report, {
      targetPlan: options.targetPlan,
      reviewedGood: options.reviewedGood === true
    });
    return saveBaselineStore(options.saveBaselinePath, updatedStore);
  });
  report.baseline = {
    ...(report.baseline ?? {}),
    review,
    saved
  };
  return report;
}
