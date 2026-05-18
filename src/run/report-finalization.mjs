import {
  comparePerformanceToBaseline,
  loadBaselineStore,
  reviewBaselineUpdate,
  saveBaselineStore,
  updateBaselineStore
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
  const existingStore = await loadBaselineStore(options.saveBaselinePath);
  const review = reviewBaselineUpdate(report, { reviewedGood: options.reviewedGood === true });
  const updatedStore = updateBaselineStore(existingStore, report, {
    targetPlan: options.targetPlan,
    reviewedGood: options.reviewedGood === true
  });
  report.baseline = {
    ...(report.baseline ?? {}),
    review,
    saved: await saveBaselineStore(options.saveBaselinePath, updatedStore)
  };
  return report;
}
